"""Local ROI and time/motion heuristics. No cloud or hardware alarm calls.

Tracks remain camera-local. Pacing describes repeated direction reversals, not
intent, theft or a biometric identity. Missing/unclear faces are never strangers.
"""
from collections import deque
import math

DEFAULTS = dict(zones_enabled=False, zones=[], intrusion_enabled=False,
                loitering_enabled=False, pacing_enabled=False, unfamiliar_enabled=False,
                manual_pin_enabled=True, auto_pin_enabled=False, popup_enabled=True,
                intrusion_seconds=2, loitering_seconds=30, pacing_reversals=3, pacing_window_seconds=60)


def policy(raw=None):
    return {**DEFAULTS, **(raw if isinstance(raw, dict) else {})}


def inside(point, polygon):
    x, y = point
    result = False
    for i, (ax, ay) in enumerate(polygon):
        bx, by = polygon[(i+1) % len(polygon)]
        cross = (bx-ax)*(y-ay)-(by-ay)*(x-ax)
        if abs(cross) < 1e-9 and min(ax,bx)-1e-9 <= x <= max(ax,bx)+1e-9 and min(ay,by)-1e-9 <= y <= max(ay,by)+1e-9:
            return True
        if (ay > y) != (by > y) and x < (bx-ax)*(y-ay)/(by-ay)+ax:
            result = not result
    return result


def anchor(item, width, height):
    x1, y1, x2, y2 = item['box']
    return ((x1+x2)/2/width, (y2 if item['label'] == 'person' else (y1+y2)/2)/height)


def zones_for(item, width, height, settings):
    if not settings['zones_enabled']:
        return [dict(id='whole', name=None)]
    point = anchor(item, width, height)
    return [z for z in settings['zones'] if inside(point, z['points'])]


class SurveillanceRules:
    def __init__(self):
        self.states = {}
        self.cooldowns = {}
        self.config = None
        self.last_at = -math.inf

    def evaluate(self, detections, at, width, height, settings, fps=2, identities_ready=False):
        if at <= self.last_at:
            return []
        if settings != self.config:
            self.states.clear()
            self.cooldowns.clear()
            self.config = {**settings}
        self.last_at = at
        gap_limit = max(2, min(25, 2/max(.1, fps)+.5))
        self.states = {key: s for key, s in self.states.items() if at-s['last'] <= gap_limit}
        self.cooldowns = {key: t for key, t in self.cooldowns.items() if at-t < 120}
        occupied = set()
        alerts = []
        for item in detections:
            if item['label'] != 'person':
                continue
            for zone in zones_for(item, width, height, settings):
                key = (item['track_id'], zone['id'])
                occupied.add(key)
                s = self.states.get(key)
                point = anchor(item, width, height)
                if s is None:
                    s = dict(first=at, last=at, hits=0, unknown_since=None, unknown_hits=0,
                             pivot=point, direction=None, turns=deque(), emitted=set())
                    self.states[key] = s
                s['hits'] += 1
                s['last'] = at
                distance = math.dist(point, s['pivot'])
                if distance >= .10:
                    vector = tuple((point[i]-s['pivot'][i])/distance for i in (0,1))
                    if s['direction'] and sum(a*b for a,b in zip(vector,s['direction'])) <= -.6:
                        s['turns'].append(at)
                    s['direction'], s['pivot'] = vector, point
                while s['turns'] and at-s['turns'][0] > settings['pacing_window_seconds']:
                    s['turns'].popleft()
                unknown = identities_ready and (item.get('identity') or {}).get('state') == 'unmatched'
                if unknown:
                    if s['unknown_since'] is None: s['unknown_since'] = at
                    s['unknown_hits'] += 1
                else:
                    s['unknown_since'], s['unknown_hits'] = None, 0
                elapsed = at-s['first']
                candidates = []
                if settings['intrusion_enabled'] and elapsed >= settings['intrusion_seconds']:
                    candidates.append(('intrusion', dict(visible_seconds=round(elapsed,1))))
                if settings['loitering_enabled'] and elapsed >= settings['loitering_seconds']:
                    candidates.append(('loitering', dict(visible_seconds=round(elapsed,1))))
                if settings['pacing_enabled'] and len(s['turns']) >= settings['pacing_reversals']:
                    candidates.append(('pacing', dict(reversals=len(s['turns']), window_seconds=settings['pacing_window_seconds'])))
                if settings['unfamiliar_enabled'] and unknown and s['unknown_hits'] >= 3 and at-s['unknown_since'] >= 2:
                    candidates.append(('unfamiliar', dict(visible_seconds=round(at-s['unknown_since'],1))))
                for kind, metrics in candidates:
                    if s['hits'] < 2 or kind in s['emitted'] or at-self.cooldowns.get((item['track_id'],zone['id'],kind),-math.inf) < 30:
                        continue
                    alerts.append(dict(kind=kind, zone_id=zone['id'], zone_name=zone['name'], item=item, metrics=metrics))
        # A track leaving a region must dwell again; do not count time outside.
        present = {d['track_id'] for d in detections}
        self.states = {key: s for key,s in self.states.items() if key in occupied or (key[0] not in present and at-s['last'] <= gap_limit)}
        return alerts

    def cooling_down(self, alert, at):
        return at-self.cooldowns.get((alert['item']['track_id'],alert['zone_id'],alert['kind']),-math.inf) < 30

    def committed(self, alert, at):
        key = (alert['item']['track_id'], alert['zone_id'])
        if key in self.states:
            self.states[key]['emitted'].add(alert['kind'])
        self.cooldowns[(alert['item']['track_id'],alert['zone_id'],alert['kind'])] = at
