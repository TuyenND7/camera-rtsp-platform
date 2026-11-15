import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.live import FrameHistory, playlist_segments


class LiveTests(unittest.TestCase):
    def test_playlist_clock_advances_and_rejects_paths_without_time(self):
        entries = playlist_segments('#EXTINF:2,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-15T12:00:00.000+0000\nseg_001.ts\n#EXTINF:2,\nseg_002.ts\n#EXTINF:2,\n../../config.bin\n')
        self.assertEqual([e.name for e in entries], ['seg_001.ts', 'seg_002.ts'])
        self.assertEqual(entries[1].at - entries[0].at, 2)
        self.assertEqual(playlist_segments('#EXTINF:2,\nseg_1.ts\n'), [])
        self.assertEqual(playlist_segments('#EXTINF:nan,\n#EXT-X-PROGRAM-DATE-TIME:bad\nseg_1.ts\n'), [])

    def test_empty_frames_clear_old_boxes_and_history_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = FrameHistory(root, 3)
            history.add(time.time(), 640, 360, [{'label': 'person', 'confidence': .8, 'box': [1, 2, 3, 4]}])
            history.add(time.time(), 640, 360, [])
            result = json.loads(history.file.read_text())
            self.assertEqual(result['frames'][-1]['detections'], [])
            self.assertTrue(result['synchronized'])
            history.clear('stopped')
            self.assertEqual(json.loads(history.file.read_text())['frames'], [])
            self.assertFalse(history.file.with_suffix('.tmp').exists())

    def test_worker_groups_people_and_uses_capture_time_for_event(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
            config = main.CameraConfig(3, 'Fixture', None, 2, .5, ('person',))
            detections = [{'label': 'person', 'confidence': .9, 'box': [0, 0, 100, 200]}, {'label': 'person', 'confidence': .8, 'box': [100, 0, 200, 200]}]
            worker = main.CameraWorker(config, SimpleNamespace(detect=lambda *_: detections))
            saved = []
            worker.write_snapshot = lambda _: 'events/fixture.jpg'
            worker.insert_event = lambda *args: saved.append(args)
            at = time.time() - 3
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at)
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0][2], at)
            self.assertEqual(len(saved[0][-1]), 2)
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + .5)
            self.assertEqual(len(saved), 1)
            detections.clear()
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + 1)
            self.assertEqual(json.loads(worker.history.file.read_text())['frames'][-1]['detections'], [])
            worker.stop()
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + 2)
            self.assertEqual(len(saved), 1)


if __name__ == '__main__':
    unittest.main()
