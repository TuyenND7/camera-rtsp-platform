"""Timestamped live detections. No model, camera credentials or image data here."""
from __future__ import annotations

import errno
import json
import math
import os
import re
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True)
class Segment:
    name: str
    at: float  # UTC epoch seconds of the first video frame
    duration: float


def playlist_segments(text: str) -> list[Segment]:
    result: list[Segment] = []
    at, duration = None, None
    for line in text.splitlines():
        try:
            if line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
                date = datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00'))
                at = date.timestamp() if date.tzinfo else None
            elif line.startswith('#EXTINF:'):
                value = float(line.split(':', 1)[1].split(',')[0])
                duration = value if math.isfinite(value) and 0 < value <= 120 else None
            elif line and not line.startswith('#'):
                if at is not None and duration and re.fullmatch(r'seg_\d+\.ts', line):
                    result.append(Segment(line, at, duration))
                at = at + duration if at is not None and duration else None
                duration = None
        except (ValueError, OverflowError):
            at, duration = None, None
    return result[-20:]


class FrameHistory:
    def __init__(self, root: Path, camera_id: int, synchronized: bool = True):
        self.file = root / '.detections' / f'{camera_id}.json'
        self.camera_id = camera_id
        self.synchronized = synchronized
        self.frames: deque[dict] = deque(maxlen=300)

    def write(self, state: str = 'ready') -> None:
        now = round(time.time() * 1000)
        while self.frames and self.frames[0]['at'] < now - 30_000:
            self.frames.popleft()
        body = {'version': 1, 'camera_id': self.camera_id, 'updated_at': now,
                'state': state, 'synchronized': self.synchronized, 'frames': list(self.frames)}
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix('.tmp')
        try:
            temporary.write_text(json.dumps(body, allow_nan=False, separators=(',', ':')), encoding='utf8')
            for attempt in range(4):
                try:
                    os.replace(temporary, self.file)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EBUSY, errno.EPERM) or attempt == 3:
                        raise
                    time.sleep(.02)
        except OSError:
            # A Windows shared-directory read may briefly block replacement.
            # Keep memory history and retry on the next frame, never stop video.
            pass
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def add(self, at: float, width: int, height: int, detections: list[dict]) -> None:
        self.frames.append({'at': round(at * 1000), 'width': width, 'height': height,
                            'detections': detections[:32]})
        self.write()

    def clear(self, state: str) -> None:
        self.frames.clear()
        self.write(state)
