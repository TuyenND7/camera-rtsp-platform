"""Nhận dạng đối tượng từ sub-stream NVR hoặc HLS live và ghi sự kiện vào PostgreSQL.

Worker này cố ý dùng sub-stream khi người dùng cấu hình `ai_rtsp_url`: không kéo main-stream
độ phân giải cao cho AI. Khi để trống, nó đọc HLS live do backend đã tạo, phù hợp để thử nghiệm.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import psycopg
from ultralytics import YOLO


logging.basicConfig(
    level=os.getenv("AI_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("camera-ai")

DATABASE_URL = os.environ["DATABASE_URL"]
STORAGE_ROOT = Path(os.getenv("STORAGE_ROOT", "/storage"))
MODEL_PATH = os.getenv("AI_MODEL", "/models/yolov8n.pt")
DEVICE = os.getenv("AI_DEVICE", "cpu")
SYNC_SECONDS = float(os.getenv("AI_SYNC_SECONDS", "15"))
EVENT_COOLDOWN_SECONDS = float(os.getenv("AI_EVENT_COOLDOWN_SECONDS", "20"))


@dataclass(frozen=True)
class CameraConfig:
    id: int
    name: str
    ai_rtsp_url: str | None
    ai_fps: float
    ai_confidence: float
    ai_labels: tuple[str, ...]

    @property
    def source_url(self) -> str:
        # Trusted worker already has the storage mount. Public HLS requires login.
        return self.ai_rtsp_url or str(STORAGE_ROOT / "live" / str(self.id) / "index.m3u8")


class Detector:
    """Một model được dùng chung, khóa inference để tránh GPU/torch bị gọi đồng thời."""

    def __init__(self) -> None:
        log.info("loading model=%s device=%s", MODEL_PATH, DEVICE)
        self.model = YOLO(MODEL_PATH)
        self.lock = threading.Lock()

    def detect(self, image: Any, confidence: float) -> list[dict[str, Any]]:
        with self.lock:
            result = self.model.predict(image, conf=confidence, device=DEVICE, verbose=False)[0]
        if result.boxes is None:
            return []
        names = result.names
        found: list[dict[str, Any]] = []
        for box in result.boxes:
            class_id = int(box.cls.item())
            found.append({
                "label": str(names[class_id]),
                "confidence": float(box.conf.item()),
                "box": [round(float(value), 1) for value in box.xyxy[0].tolist()],
            })
        return found


class CameraWorker:
    def __init__(self, camera: CameraConfig, detector: Detector) -> None:
        self.camera = camera
        self.detector = detector
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, name=f"ai-camera-{camera.id}", daemon=True)
        self.last_event: dict[str, float] = {}

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def is_alive(self) -> bool:
        return self.thread.is_alive()

    def run(self) -> None:
        cap: cv2.VideoCapture | None = None
        next_frame_at = 0.0
        try:
            while not self.stop_event.is_set():
                if cap is None or not cap.isOpened():
                    if cap is not None:
                        cap.release()
                    # Không ghi URL vì URL RTSP thường chứa mật khẩu.
                    log.info("camera=%s opening AI source", self.camera.id)
                    cap = cv2.VideoCapture(self.camera.source_url, cv2.CAP_FFMPEG)
                    if not cap.isOpened():
                        cap.release()
                        cap = None
                        self.stop_event.wait(5)
                        continue

                ok, frame = cap.read()
                if not ok or frame is None:
                    cap.release()
                    cap = None
                    self.stop_event.wait(2)
                    continue

                now = time.monotonic()
                if now < next_frame_at:
                    continue
                next_frame_at = now + 1 / max(self.camera.ai_fps, 0.1)
                self.process_frame(frame)
        except Exception:
            log.exception("camera=%s worker stopped after an unexpected error", self.camera.id)
        finally:
            if cap is not None:
                cap.release()

    def process_frame(self, frame: Any) -> None:
        wanted = set(self.camera.ai_labels)
        detections = [item for item in self.detector.detect(frame, self.camera.ai_confidence) if item["label"] in wanted]
        if not detections:
            return

        now = time.monotonic()
        accepted = [
            item for item in detections
            if now - self.last_event.get(item["label"], float("-inf")) >= EVENT_COOLDOWN_SECONDS
        ]
        if not accepted:
            return

        snapshot_path = self.write_snapshot(frame)
        for item in accepted:
            self.insert_event(item, snapshot_path)
            self.last_event[item["label"]] = now

    def write_snapshot(self, frame: Any) -> str:
        timestamp = datetime.now(timezone.utc)
        relative = Path("events") / str(self.camera.id) / timestamp.strftime("%Y%m%d") / (
            f"{timestamp.strftime('%H%M%S_%f')}.jpg"
        )
        destination = STORAGE_ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(destination), frame, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise RuntimeError("cannot write AI event snapshot")
        return relative.as_posix()

    def insert_event(self, item: dict[str, Any], snapshot_path: str) -> None:
        metadata = json.dumps({"box": item["box"], "ai_fps": self.camera.ai_fps})
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            conn.execute(
                """
                INSERT INTO detection_events (camera_id, label, confidence, snapshot_path, metadata)
                VALUES (%s, %s, %s, %s, %s::jsonb)
                """,
                (self.camera.id, item["label"], item["confidence"], snapshot_path, metadata),
            )
        log.info(
            "camera=%s event=%s confidence=%.2f",
            self.camera.id,
            item["label"],
            item["confidence"],
        )


class Runtime:
    def __init__(self) -> None:
        self.detector = Detector()
        self.workers: dict[int, CameraWorker] = {}
        self.stopping = threading.Event()

    def fetch_cameras(self) -> list[CameraConfig]:
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            rows = conn.execute(
                """
                SELECT id, name, ai_rtsp_url, ai_fps, ai_confidence, ai_labels
                FROM cameras
                WHERE enabled = true AND ai_enabled = true
                ORDER BY id
                """
            ).fetchall()
        return [
            CameraConfig(
                id=row[0],
                name=row[1],
                ai_rtsp_url=row[2],
                ai_fps=float(row[3]),
                ai_confidence=float(row[4]),
                ai_labels=tuple(row[5] or []),
            )
            for row in rows
        ]

    def sync(self) -> None:
        desired = {camera.id: camera for camera in self.fetch_cameras()}
        for camera_id, worker in list(self.workers.items()):
            if camera_id not in desired or desired[camera_id] != worker.camera or not worker.is_alive():
                worker.stop()
                self.workers.pop(camera_id, None)
        for camera in desired.values():
            if camera.id not in self.workers:
                worker = CameraWorker(camera, self.detector)
                self.workers[camera.id] = worker
                worker.start()
                log.info("camera=%s AI worker started", camera.id)

    def run(self) -> None:
        while not self.stopping.is_set():
            try:
                self.sync()
            except Exception:
                log.exception("cannot sync camera configuration")
            self.stopping.wait(SYNC_SECONDS)
        for worker in self.workers.values():
            worker.stop()
        for worker in self.workers.values():
            worker.thread.join(timeout=5)

    def stop(self, *_: Any) -> None:
        self.stopping.set()


def main() -> None:
    runtime = Runtime()
    signal.signal(signal.SIGTERM, runtime.stop)
    signal.signal(signal.SIGINT, runtime.stop)
    runtime.run()


if __name__ == "__main__":
    main()
