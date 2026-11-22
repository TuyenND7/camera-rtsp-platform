"""Nhận dạng đối tượng từ sub-stream NVR hoặc HLS live và ghi sự kiện vào PostgreSQL.

Mặc định phân tích segment HLS local, dùng program date-time để vẽ khung đúng hình
đang xem. Luồng RTSP riêng là tùy chọn cho sự kiện; không suy đoán tọa độ đồng bộ
của một luồng khác. Không kết nối cloud của hãng để chạy model.
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

os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
import psycopg
from ultralytics import YOLO
from .live import FrameHistory, playlist_segments
from .tracking import ObjectTracker


logging.basicConfig(
    level=os.getenv("AI_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("camera-ai")

DATABASE_URL = os.environ["DATABASE_URL"]
STORAGE_ROOT = Path(os.getenv("STORAGE_ROOT", "/storage"))
MODEL_PATH = os.getenv("AI_MODEL", "/models/yolov8n.pt")
DEVICE = os.getenv("AI_DEVICE", "cpu")
SYNC_SECONDS = float(os.getenv("AI_SYNC_SECONDS", "3"))
TRACK_MAX_IDLE_SECONDS = float(os.getenv("AI_TRACK_MAX_IDLE_SECONDS", "8"))


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
        cv2.setNumThreads(1)
        if DEVICE == "cpu":
            import torch
            torch.set_num_threads(2)
        self.model = YOLO(MODEL_PATH)
        self.lock = threading.Lock()

    def detect(self, image: Any, confidence: float) -> list[dict[str, Any]]:
        with self.lock:
            result = self.model.predict(image, conf=confidence, device=DEVICE, imgsz=640, max_det=32, verbose=False)[0]
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
        self.tracker = ObjectTracker(camera.id, max_idle_seconds=TRACK_MAX_IDLE_SECONDS)
        self.history = FrameHistory(STORAGE_ROOT, camera.id, synchronized=not bool(camera.ai_rtsp_url))

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()

    def is_alive(self) -> bool:
        return self.thread.is_alive()

    def run(self) -> None:
        if not self.camera.ai_rtsp_url:
            self.run_live()
            return
        self.run_rtsp()

    def run_live(self) -> None:
        # Analyze completed HLS segments once, using their program date-time.
        # The viewer is a few seconds behind this edge; boxes share its clock.
        directory = STORAGE_ROOT / 'live' / str(self.camera.id)
        seen: list[tuple[str, float]] = []
        self.history.clear('waiting')
        last_frame = time.monotonic()
        try:
            while not self.stop_event.is_set():
                try:
                    playlist = (directory / 'index.m3u8').read_text(encoding='utf8')
                    segments = [segment for segment in playlist_segments(playlist)
                                if -3 < time.time() - segment.at < 15]
                except (OSError, ValueError):
                    segments = []
                for segment in segments:
                    key = (segment.name, segment.at)
                    if key in seen or self.stop_event.is_set():
                        continue
                    cap = cv2.VideoCapture(str(directory / segment.name), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 1])
                    try:
                        if not cap.isOpened():
                            continue
                        fps = cap.get(cv2.CAP_PROP_FPS)
                        fps = fps if 1 <= fps <= 120 else 25
                        frame_index, next_at = 0, 0.0
                        while not self.stop_event.is_set():
                            if not cap.grab():
                                break
                            offset = frame_index / fps
                            frame_index += 1
                            if offset + .001 < next_at or offset >= segment.duration:
                                continue
                            next_at = offset + 1 / max(self.camera.ai_fps, .1)
                            ok, frame = cap.retrieve()
                            if not ok or frame is None:
                                continue
                            self.process_frame(frame, segment.at + offset)
                            last_frame = time.monotonic()
                    finally:
                        cap.release()
                    seen.append(key)
                    seen = seen[-40:]
                if time.monotonic() - last_frame > 10:
                    self.history.clear('waiting')
                    last_frame = time.monotonic()
                self.stop_event.wait(.25)
        except Exception:
            log.exception('camera=%s live AI stopped', self.camera.id)
            self.history.clear('error')
        finally:
            if self.stop_event.is_set():
                self.history.clear('stopped')

    def run_rtsp(self) -> None:
        cap: cv2.VideoCapture | None = None
        next_frame_at = 0.0
        try:
            while not self.stop_event.is_set():
                if cap is None or not cap.isOpened():
                    if cap is not None:
                        cap.release()
                    # Không ghi URL vì URL RTSP thường chứa mật khẩu.
                    log.info("camera=%s opening AI source", self.camera.id)
                    cap = cv2.VideoCapture(self.camera.source_url, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_N_THREADS, 1])
                    if not cap.isOpened():
                        cap.release()
                        cap = None
                        self.stop_event.wait(5)
                        continue

                if not cap.grab():
                    cap.release()
                    cap = None
                    self.stop_event.wait(2)
                    continue

                now = time.monotonic()
                if now < next_frame_at:
                    continue
                next_frame_at = now + 1 / max(self.camera.ai_fps, 0.1)
                ok, frame = cap.retrieve()
                if not ok or frame is None:
                    continue
                self.process_frame(frame)
        except Exception:
            log.exception("camera=%s worker stopped after an unexpected error", self.camera.id)
        finally:
            if cap is not None:
                cap.release()

    def process_frame(self, frame: Any, captured_at: float | None = None) -> None:
        wanted = set(self.camera.ai_labels)
        detections = [item for item in self.detector.detect(frame, self.camera.ai_confidence) if item["label"] in wanted]
        if self.stop_event.is_set():
            return
        captured_at = captured_at if captured_at is not None else time.time()
        height, width = frame.shape[:2]
        detections = self.tracker.update(detections, captured_at, width, height)
        if self.history.synchronized:
            self.history.add(captured_at, width, height, detections)
        else:
            self.history.write()
        if not detections:
            return

        accepted = self.tracker.pending_events(detections)
        if not accepted:
            return

        try:
            snapshot_path = self.write_snapshot(frame)
            for item in accepted:
                self.insert_event(item, snapshot_path, captured_at, width, height, detections)
                self.tracker.mark_reported(item)
        except Exception:
            # Retry unreported tracks on the next frame, without killing AI.
            log.exception('camera=%s cannot save tracked event', self.camera.id)

    def write_snapshot(self, frame: Any) -> str:
        timestamp = datetime.now(timezone.utc)
        relative = Path("events") / str(self.camera.id) / timestamp.strftime("%Y%m%d") / (
            f"{timestamp.strftime('%H%M%S_%f')}.jpg"
        )
        destination = STORAGE_ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not cv2.imwrite(str(destination), frame, [cv2.IMWRITE_JPEG_QUALITY, 90]):
            raise RuntimeError("cannot write AI event snapshot")
        # Lists use a small sibling; full-resolution evidence is fetched on demand.
        temporary = destination.with_suffix('.thumb.tmp.jpg')
        try:
            height, width = frame.shape[:2]
            scale = min(320 / width, 180 / height, 1)
            thumbnail = cv2.resize(frame, (max(1, round(width * scale)), max(1, round(height * scale))))
            if not cv2.imwrite(str(temporary), thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 65]):
                raise OSError('Thumbnail was not written')
            os.replace(temporary, destination.with_suffix('.thumb.jpg'))
        except Exception:
            # The API can generate a missing thumbnail later without losing an event.
            log.warning('camera=%s thumbnail deferred', self.camera.id)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        return relative.as_posix()

    def insert_event(self, item: dict[str, Any], snapshot_path: str, captured_at: float, width: int, height: int, detections: list[dict]) -> None:
        metadata = json.dumps({"box": item["box"], "track_id": item["track_id"], "track_number": item["track_number"], "ai_fps": self.camera.ai_fps, "width": width, "height": height, "detections": detections, "synchronized": self.history.synchronized})
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            conn.execute(
                """
                INSERT INTO detection_events (camera_id, label, confidence, snapshot_path, metadata, detected_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s)
                ON CONFLICT DO NOTHING
                """,
                (self.camera.id, item["label"], item["confidence"], snapshot_path, metadata, datetime.fromtimestamp(captured_at, timezone.utc)),
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
                worker.thread.join(timeout=5)
                if not worker.is_alive():
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
