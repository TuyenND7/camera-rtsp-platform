"""Camera-local spatial tracks, with timestamps instead of assumed video FPS.

IDs describe a continuous sighting, not a person's identity. No image embeddings,
cloud calls or tracker state are shared between cameras.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from uuid import uuid4

from scipy.optimize import linear_sum_assignment


@dataclass
class Track:
    number: int
    label: str
    box: tuple[float, ...]
    seen_at: float
    velocity: tuple[float, float] = (0.0, 0.0)
    hits: int = 1
    reported: bool = False


def iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    intersection = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0.0


class ObjectTracker:
    def __init__(self, camera_id: int, max_idle_seconds: float = 8.0):
        self.prefix = f'c{camera_id}-{uuid4().hex[:12]}'
        self.max_idle_seconds = max_idle_seconds
        self.tracks: dict[int, Track] = {}
        self.next_number = 1
        self.last_at = float('-inf')

    def track_id(self, number: int) -> str:
        return f'{self.prefix}-{number}'

    def cost(self, track: Track, box: tuple[float, ...], at: float) -> float:
        gap = at - track.seen_at
        # Do not extrapolate motion through a long occlusion indefinitely.
        dx, dy = (value * min(gap, 2.0) for value in track.velocity)
        predicted = (track.box[0] + dx, track.box[1] + dy, track.box[2] + dx, track.box[3] + dy)
        aw, ah = predicted[2] - predicted[0], predicted[3] - predicted[1]
        bw, bh = box[2] - box[0], box[3] - box[1]
        area_ratio = max(aw * ah, bw * bh) / max(1e-12, min(aw * ah, bw * bh))
        distance = math.hypot((predicted[0] + predicted[2] - box[0] - box[2]) / 2,
                              (predicted[1] + predicted[3] - box[1] - box[3]) / 2) / max(1e-9, math.hypot((aw + bw) / 2, (ah + bh) / 2))
        overlap = iou(predicted, box)
        if area_ratio > 4 or (overlap < .1 and distance > .65):
            return 100.0
        return 1 - overlap + .35 * distance + .1 * math.log(area_ratio)

    def update(self, detections: list[dict], at: float, width: int, height: int) -> list[dict]:
        if not math.isfinite(at) or at <= self.last_at or width < 1 or height < 1:
            return []
        self.last_at = at
        self.tracks = {number: track for number, track in self.tracks.items()
                       if at - track.seen_at <= self.max_idle_seconds}
        boxes = [tuple(value / (width if index % 2 == 0 else height) for index, value in enumerate(item['box']))
                 for item in detections]
        matched: dict[int, Track] = {}
        existing = list(self.tracks.values())
        if existing and detections:
            # A global one-to-one assignment prevents two boxes reusing one ID.
            costs = [[self.cost(track, box, at) if track.label == item['label'] else 100.0
                      for item, box in zip(detections, boxes)] for track in existing]
            rows, columns = linear_sum_assignment(costs)
            for row, column in zip(rows, columns):
                if costs[row][column] >= 100:
                    continue
                track, box = existing[row], boxes[column]
                gap = at - track.seen_at
                vx = (box[0] + box[2] - track.box[0] - track.box[2]) / (2 * gap)
                vy = (box[1] + box[3] - track.box[1] - track.box[3]) / (2 * gap)
                track.velocity = (vx, vy)
                track.box, track.seen_at = box, at
                track.hits += 1
                matched[int(column)] = track
        result: list[dict] = []
        for index, (item, box) in enumerate(zip(detections, boxes)):
            track = matched.get(index)
            if track is None:
                track = Track(self.next_number, item['label'], box, at)
                self.next_number += 1
                self.tracks[track.number] = track
            result.append({**item, 'track_id': self.track_id(track.number), 'track_number': track.number})
        return result

    def pending_events(self, detections: list[dict]) -> list[dict]:
        return [item for item in detections
                if (track := self.tracks.get(item['track_number'])) is not None
                and track.hits >= 2 and not track.reported]

    def mark_reported(self, item: dict) -> None:
        self.tracks[item['track_number']].reported = True
