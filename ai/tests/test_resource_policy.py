import unittest
import numpy as np
from app.resource_policy import MotionGate,capped_fps


class ResourcePolicyTests(unittest.TestCase):
    def test_sampling_caps_never_increase_a_cameras_requested_fps(self):
        self.assertEqual(capped_fps(.5,{'ai_max_fps':2}),.5)
        self.assertEqual(capped_fps(5,{'ai_max_fps':1}),1)
        self.assertEqual(capped_fps(2,{'ai_max_fps':float('nan')}),2)
    def test_quiet_frames_keep_periodic_inference_and_motion_wakes_immediately(self):
        gate=MotionGate();frame=np.zeros((90,160,3),dtype=np.uint8);budget={'adaptive_ai':True,'idle_seconds':5}
        self.assertTrue(gate.should_infer(frame,100,False,budget))
        self.assertFalse(gate.should_infer(frame,101,False,budget))
        self.assertTrue(gate.should_infer(frame,105,False,budget))
        changed=frame.copy();changed[20:50,20:50]=255
        self.assertTrue(gate.should_infer(changed,105.5,False,budget))
    def test_tracked_people_keep_full_sampling_and_old_frames_do_not_rewind_gate(self):
        gate=MotionGate();frame=np.zeros((90,160,3),dtype=np.uint8);budget={'adaptive_ai':True}
        self.assertTrue(gate.should_infer(frame,100,True,budget))
        self.assertTrue(gate.should_infer(frame,100.5,True,budget))
        self.assertFalse(gate.should_infer(frame,99,True,budget))
        self.assertTrue(gate.should_infer(frame,101,True,budget))
    def test_disabled_adaptive_mode_does_not_inspect_or_retain_image(self):
        gate=MotionGate()
        self.assertTrue(gate.should_infer(None,100,False,{'adaptive_ai':False}))
        self.assertIsNone(gate.sample)

if __name__=='__main__':unittest.main()
