"""Bound AI sampling without changing camera/NVR recording settings."""
import math
import numpy as np


def capped_fps(requested, runtime):
    cap = (runtime or {}).get('ai_max_fps',10)
    if not isinstance(cap,(int,float)) or not math.isfinite(cap): cap=10
    return max(.1,min(float(requested),max(.1,min(10,cap))))


class MotionGate:
    def __init__(self):
        self.sample=None
        self.last_inference=-math.inf

    def should_infer(self,frame,at,active_tracks,budget):
        if not (budget or {}).get('adaptive_ai',False):return True
        if at<=self.last_inference:return False
        # A currently tracked object keeps normal sampling for stable IDs/dwell.
        h,w=frame.shape[:2]
        sample=frame[::max(1,h//90),::max(1,w//160)].astype(np.float32).mean(axis=2)
        changed=self.sample is None or sample.shape!=self.sample.shape or float(np.abs(sample-self.sample).mean())>=2.0
        self.sample=sample
        interval=(budget or {}).get('idle_seconds',5)
        interval=max(1,min(10,interval)) if isinstance(interval,(int,float)) and math.isfinite(interval) else 5
        infer=bool(active_tracks or changed or at-self.last_inference>=interval)
        if infer:self.last_inference=at
        return infer
