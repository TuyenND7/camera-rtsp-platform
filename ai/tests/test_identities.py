import threading
import unittest
from types import SimpleNamespace
import numpy as np
from app.identities import IdentityService, match_identity, unit_feature
from app.image_size import image_size


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.a = np.eye(128, dtype=np.float32)[0]
        self.b = np.eye(128, dtype=np.float32)[1]

    def test_people_compete_not_individual_samples_and_ambiguous_matches_stay_unknown(self):
        self.assertEqual(match_identity(self.a, [('A', self.a), ('A', self.a), ('B', self.b)]), 'A')
        self.assertIsNone(match_identity(self.a, [('A', self.a), ('B', unit_feature(self.a+.05*self.b))]))
        self.assertIsNone(match_identity(self.a, [('B', self.b)]))
        self.assertIsNone(match_identity(self.a, []))
        for value in [[], [0]*128, [float('nan')]*128, [float('inf')]*128]:
            with self.assertRaises(ValueError):
                unit_feature(value)

    def service(self):
        service = IdentityService.__new__(IdentityService)
        service.lock, service.memory, service.threshold = threading.Lock(), {}, .5
        service.gallery = [('A', self.a)]
        service.engine = SimpleNamespace(person_feature=lambda *_: self.a)
        return service

    def item(self, track='c1-test-1'):
        return {'label': 'person', 'track_id': track, 'box': [0, 0, 100, 200]}

    def test_two_independent_observations_required_and_no_face_clears_known_name(self):
        service = self.service()
        def state(at, track='c1-test-1'):
            return service.annotate(None, [self.item(track)], at)[0]['identity']
        self.assertEqual(state(1), {'state': 'pending'})
        self.assertEqual(state(1.2), {'state': 'pending'})
        self.assertEqual(state(2), {'state': 'known', 'person_id': 'A'})
        self.assertEqual(state(2, 'c2-test-1'), {'state': 'pending'})
        service.engine.person_feature = lambda *_: None
        self.assertEqual(state(3), {'state': 'not_visible'})
        service.engine.person_feature = lambda *_: self.a
        self.assertEqual(state(4), {'state': 'pending'})
        self.assertEqual(state(5), {'state': 'known', 'person_id': 'A'})
        self.assertEqual(state(20), {'state': 'pending'})

    def test_empty_gallery_and_unavailable_model_never_produce_known_identity(self):
        service = self.service(); service.gallery = []
        self.assertEqual(service.annotate(None, [self.item()], 1)[0]['identity'], {'state': 'unmatched'})
        service.engine = None
        self.assertEqual(service.annotate(None, [self.item()], 2)[0]['identity'], {'state': 'unavailable'})
        animal = {'label': 'dog', 'box': [0, 0, 20, 20]}
        self.assertEqual(service.annotate(None, [animal], 3), [animal])
        self.assertNotIn('identity', animal)

    def test_different_camera_video_delays_do_not_erase_each_others_confirmation(self):
        service = self.service()
        self.assertEqual(service.annotate(None, [self.item('c1')], 10)[0]['identity']['state'], 'pending')
        self.assertEqual(service.annotate(None, [self.item('c2')], 8)[0]['identity']['state'], 'pending')
        self.assertEqual(service.annotate(None, [self.item('c1')], 11)[0]['identity']['state'], 'known')
        self.assertEqual(service.annotate(None, [self.item('c2')], 9)[0]['identity']['state'], 'known')

    def test_image_dimensions_are_checked_before_decode(self):
        import struct
        png = b'\x89PNG\r\n\x1a\n'+b'\0\0\0\rIHDR'+struct.pack('>II', 800, 600)
        self.assertEqual(image_size(png), (800, 600))
        jpeg = b'\xff\xd8\xff\xe0\x00\x04xx\xff\xc0\x00\x0b\x08\x01\xe0\x02\x80'+b'\0'*4
        self.assertEqual(image_size(jpeg), (640, 480))
        for invalid in [b'', b'GIF89a', b'<svg/>', b'\xff\xd8\xff\xe0\xff\xff']:
            with self.assertRaises(ValueError):
                image_size(invalid)
