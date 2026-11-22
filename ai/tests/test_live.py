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
    def test_region_uses_full_person_geometry_and_filters_before_face_or_events(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main,'STORAGE_ROOT',Path(directory)):
            roi=dict(zones_enabled=True,zones=[dict(id='top',name='Top',points=[[0,0],[1,0],[1,.5],[0,.5]])])
            frame=SimpleNamespace(shape=(100,100,3)); seen=[]; annotated=[]
            def detect(image,*_):
                seen.append(image)
                return [dict(label='person',confidence=.9,box=[10,10,30,80]),dict(label='person',confidence=.9,box=[40,10,60,40])]
            detector=SimpleNamespace(detect=detect,identities=SimpleNamespace(annotate=lambda _,items,at:annotated.extend(items)))
            worker=main.CameraWorker(main.CameraConfig(1,'Fixture',None,2,.5,('person',),True,roi),detector)
            worker.process_surveillance=lambda *_:None
            worker.process_frame(frame,time.time())
            self.assertIs(seen[0],frame)
            self.assertEqual(len(annotated),1)
            self.assertEqual(annotated[0]['box'],[40,10,60,40])

    def test_identity_toggle_keeps_existing_worker_and_tracking_ids(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
            camera = main.CameraConfig(1, 'Fixture', None, 2, .5, ('person',))
            worker = main.CameraWorker(camera, None)
            worker.is_alive = lambda: True
            worker.stop = lambda: self.fail('Identity toggle must not stop tracking')
            prefix = worker.tracker.prefix
            runtime = main.Runtime.__new__(main.Runtime)
            runtime.workers = {1: worker}
            runtime.fetch_cameras = lambda: [main.replace(camera, ai_identity_enabled=True)]
            runtime.sync()
            self.assertIs(runtime.workers[1], worker)
            self.assertEqual(worker.tracker.prefix, prefix)
            self.assertTrue(worker.camera.ai_identity_enabled)

    def test_snapshot_thumbnail_is_bounded_atomic_and_optional(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        for fail_thumbnail in (False, True):
            with self.subTest(fail_thumbnail=fail_thumbnail), tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
                sizes = []
                def resize(frame, size, **_):
                    sizes.append(size)
                    if fail_thumbnail:
                        raise RuntimeError('resize fixture failure')
                    return frame
                def write(filename, *_):
                    Path(filename).write_bytes(b'fixture-jpeg-payload')
                    return True
                cv = SimpleNamespace(resize=resize, imwrite=write, IMWRITE_JPEG_QUALITY=1, INTER_AREA=3)
                worker = main.CameraWorker(main.CameraConfig(1, 'Fixture', None, 2, .5, ('person',)), None)
                with patch.object(main, 'cv2', cv):
                    if fail_thumbnail:
                        with self.assertLogs('camera-ai', level='WARNING'):
                            relative = worker.write_snapshot(SimpleNamespace(shape=(1620, 2880, 3)))
                    else:
                        relative = worker.write_snapshot(SimpleNamespace(shape=(1620, 2880, 3)))
                original = Path(directory) / relative
                self.assertTrue(original.exists())
                self.assertEqual(original.with_suffix('.thumb-v2.jpg').exists(), not fail_thumbnail)
                self.assertEqual(sizes, [(640, 360)])
                self.assertFalse(list(original.parent.glob('*.tmp.jpg')))

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

    def test_worker_saves_each_confirmed_person_once_and_uses_capture_time(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
            config = main.CameraConfig(3, 'Fixture', None, 2, .5, ('person',))
            detections = [{'label': 'person', 'confidence': .9, 'box': [0, 0, 100, 200]}, {'label': 'person', 'confidence': .8, 'box': [100, 0, 200, 200]}]
            worker = main.CameraWorker(config, SimpleNamespace(detect=lambda *_: detections))
            worker.process_surveillance = lambda *_: None
            saved = []
            worker.write_snapshot = lambda _: 'events/fixture.jpg'
            worker.insert_event = lambda *args: saved.append(args)
            at = time.time() - 3
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at)
            self.assertEqual(len(saved), 0)
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + .5)
            self.assertEqual(len(saved), 2)
            self.assertEqual(saved[0][2], at + .5)
            self.assertEqual(len(saved[0][-1]), 2)
            self.assertNotEqual(saved[0][0]['track_id'], saved[1][0]['track_id'])
            for offset in range(1, 30):
                worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + offset)
            self.assertEqual(len(saved), 2)
            detections.clear()
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + 30)
            self.assertEqual(json.loads(worker.history.file.read_text())['frames'][-1]['detections'], [])
            worker.stop()
            worker.process_frame(SimpleNamespace(shape=(360, 640, 3)), at + 31)
            self.assertEqual(len(saved), 2)

    def test_failed_event_save_is_retried_without_repeating_successful_events(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
            detections = [{'label': 'person', 'confidence': .9, 'box': [10, 20, 60, 100]}]
            worker = main.CameraWorker(main.CameraConfig(1, 'Fixture', None, 1, .5, ('person',)), SimpleNamespace(detect=lambda *_: detections))
            worker.process_surveillance = lambda *_: None
            worker.write_snapshot = lambda _: 'events/fixture.jpg'
            calls = []
            def save(*args):
                calls.append(args)
                if len(calls) == 1:
                    raise RuntimeError('database temporarily unavailable')
            worker.insert_event = save
            at = time.time() - 5
            frame = SimpleNamespace(shape=(360, 640, 3))
            worker.process_frame(frame, at)
            with self.assertLogs('camera-ai', level='ERROR'):
                worker.process_frame(frame, at + 1)
            worker.process_frame(frame, at + 2)
            worker.process_frame(frame, at + 3)
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0]['track_id'], calls[1][0]['track_id'])

    def test_live_sampling_converts_only_requested_frames(self):
        with patch.dict(sys.modules, {'cv2': SimpleNamespace(), 'psycopg': SimpleNamespace(), 'ultralytics': SimpleNamespace(YOLO=None)}), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}):
            main = importlib.import_module('app.main')
        with tempfile.TemporaryDirectory() as directory, patch.object(main, 'STORAGE_ROOT', Path(directory)):
            worker = main.CameraWorker(main.CameraConfig(3, 'Fixture', None, 2, .5, ('person',)), None)
            stream = Path(directory) / 'live' / '3'
            stream.mkdir(parents=True)
            at = time.time() - 2
            date = main.datetime.fromtimestamp(at, main.timezone.utc).isoformat()
            (stream / 'index.m3u8').write_text(f'#EXT-X-PROGRAM-DATE-TIME:{date}\n#EXTINF:2,\nseg_001.ts\n')
            converted, captured = [], []
            class Capture:
                index = 0
                def isOpened(self): return True
                def get(self, _): return 25
                def grab(self):
                    self.index += 1
                    return self.index <= 50
                def retrieve(self):
                    converted.append(self.index)
                    return True, SimpleNamespace()
                def release(self): worker.stop()
            video = SimpleNamespace(VideoCapture=lambda *_: Capture(), CAP_FFMPEG=1, CAP_PROP_N_THREADS=70, CAP_PROP_FPS=5)
            worker.process_frame = lambda _, timestamp: captured.append(timestamp)
            with patch.object(main, 'cv2', video):
                worker.run_live()
            self.assertEqual(len(converted), 4)
            self.assertAlmostEqual(captured[0], at, places=4)
            self.assertTrue(all(.5 <= b - a <= .54 for a, b in zip(captured, captured[1:])))


if __name__ == '__main__':
    unittest.main()
