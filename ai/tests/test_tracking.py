import unittest

from app.tracking import ObjectTracker


def detection(x=10, label='person', scale=1):
    return {'label': label, 'confidence': .9, 'box': [v * scale for v in (x, 20, x + 40, 100)]}


class TrackingTests(unittest.TestCase):
    def test_stationary_object_is_reported_once_even_after_old_cooldown(self):
        tracker = ObjectTracker(1)
        first = tracker.update([detection()], 100, 640, 360)
        self.assertEqual(tracker.pending_events(first), [])
        second = tracker.update([detection()], 101, 640, 360)
        self.assertEqual(len(tracker.pending_events(second)), 1)
        tracker.mark_reported(second[0])
        for at in range(102, 150):
            current = tracker.update([detection()], at, 640, 360)
            self.assertEqual(current[0]['track_id'], first[0]['track_id'])
            self.assertEqual(tracker.pending_events(current), [])

    def test_multiple_objects_keep_ids_when_detection_order_changes(self):
        tracker = ObjectTracker(2)
        first = tracker.update([detection(10), detection(150)], 100, 640, 360)
        second = tracker.update([detection(120), detection(40)], 100.5, 640, 360)
        self.assertEqual([x['track_id'] for x in second], [first[1]['track_id'], first[0]['track_id']])
        crossing = tracker.update([detection(40), detection(120)], 101.5, 640, 360)
        self.assertEqual([x['track_id'] for x in crossing], [first[1]['track_id'], first[0]['track_id']])
        self.assertEqual(len(set(x['track_id'] for x in crossing)), 2)

    def test_brief_occlusion_keeps_id_and_long_absence_starts_new_sighting(self):
        tracker = ObjectTracker(1, max_idle_seconds=8)
        first = tracker.update([detection()], 100, 640, 360)[0]
        tracker.update([], 101, 640, 360)
        returning = tracker.update([detection()], 105, 640, 360)[0]
        self.assertEqual(returning['track_id'], first['track_id'])
        tracker.update([], 114, 640, 360)
        new = tracker.update([detection()], 115, 640, 360)[0]
        self.assertNotEqual(new['track_id'], first['track_id'])

    def test_classes_cameras_and_worker_restarts_have_separate_ids(self):
        tracker = ObjectTracker(1)
        objects = tracker.update([detection(label='person'), detection(label='cat')], 100, 640, 360)
        changed_order = tracker.update([detection(label='cat'), detection(label='person')], 101, 640, 360)
        self.assertEqual([x['track_id'] for x in changed_order], [objects[1]['track_id'], objects[0]['track_id']])
        other = ObjectTracker(2).update([detection()], 100, 640, 360)[0]
        restarted = ObjectTracker(1).update([detection()], 100, 640, 360)[0]
        self.assertEqual(len({objects[0]['track_id'], other['track_id'], restarted['track_id']}), 3)

    def test_resolution_changes_and_stale_frames_do_not_reassign_ids(self):
        tracker = ObjectTracker(1)
        first = tracker.update([detection()], 100, 640, 360)[0]
        self.assertEqual(tracker.update([detection(400)], 99, 640, 360), [])
        resized = tracker.update([detection(scale=2)], 101, 1280, 720)[0]
        self.assertEqual(resized['track_id'], first['track_id'])

    def test_distant_new_object_does_not_reuse_a_lost_track(self):
        tracker = ObjectTracker(1)
        first = tracker.update([detection()], 100, 640, 360)[0]
        new = tracker.update([detection(500)], 101, 640, 360)[0]
        self.assertNotEqual(new['track_id'], first['track_id'])


if __name__ == '__main__':
    unittest.main()
