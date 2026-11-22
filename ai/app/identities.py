"""Local, opt-in face matching. Embeddings and enrollment images never leave storage/DB."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
from pathlib import Path
from uuid import UUID

import numpy as np

MODEL = 'opencv-sface-2021dec'


def unit_feature(value):
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    if vector.size != 128 or not np.isfinite(vector).all():
        raise ValueError('Invalid face feature')
    norm = float(np.linalg.norm(vector))
    if norm < 1e-6:
        raise ValueError('Empty face feature')
    return vector / norm


def match_identity(feature, gallery, threshold=.50, margin=.08):
    """Compare people, not samples: two similar people must remain ambiguous."""
    scores = {}
    vector = unit_feature(feature)
    for person_id, sample in gallery:
        score = float(np.dot(vector, sample))
        scores[person_id] = max(scores.get(person_id, -1), score)
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if not ranked or ranked[0][1] < threshold or len(ranked) > 1 and ranked[0][1] - ranked[1][1] < margin:
        return None
    return ranked[0][0]


class FaceEngine:
    def __init__(self, models: Path):
        import cv2
        self.cv = cv2
        self.lock = threading.Lock()
        self.detector = cv2.FaceDetectorYN.create(str(models / 'face_detection_yunet_2023mar.onnx'), '', (320, 320), .9, .3, 100)
        self.recognizer = cv2.FaceRecognizerSF.create(str(models / 'face_recognition_sface_2021dec.onnx'), '')

    def faces(self, image, limit=1600, max_faces=8):
        cv = self.cv
        height, width = image.shape[:2]
        ratio = min(limit / max(height, width), 1)
        small = cv.resize(image, (max(1, round(width * ratio)), max(1, round(height * ratio))), interpolation=cv.INTER_AREA) if ratio < 1 else image
        self.detector.setInputSize((small.shape[1], small.shape[0]))
        _, faces = self.detector.detect(small)
        if faces is None:
            return []
        result = []
        for face in faces[:max_faces]:
            face = face.copy()
            face[:14] /= ratio
            if min(face[2:4]) < 40 or not np.isfinite(face).all():
                continue
            x, y, w, h = face[:4]
            crop = image[max(0, int(y)):min(height, int(y+h)), max(0, int(x)):min(width, int(x+w))]
            if crop.size == 0 or cv.Laplacian(cv.cvtColor(crop, cv.COLOR_BGR2GRAY), cv.CV_64F).var() < 25:
                continue
            aligned = self.recognizer.alignCrop(image, face)
            result.append((face, aligned, unit_feature(self.recognizer.feature(aligned))))
        return result

    def analyze(self, image):
        with self.lock:
            return self.faces(image)

    def person_feature(self, image, box):
        height, width = image.shape[:2]
        x1, y1, x2, y2 = box
        pad = (x2-x1)*.08
        crop = image[max(0, int(y1-pad)):min(height, int(y1+(y2-y1)*.7)), max(0, int(x1-pad)):min(width, int(x2+pad))]
        if crop.size == 0:
            return None
        with self.lock:
            faces = self.faces(crop, 640, 2)
        # A crowded/overlapping person box is not sufficient identity evidence.
        return faces[0][2] if len(faces) == 1 else None


class IdentityService:
    def __init__(self, root: Path, database_url: str, models=Path('/models')):
        self.root, self.database_url, self.models = root / '.identities', database_url, models
        self.engine = None
        self.gallery = ()
        self.revision = ''
        self.memory = {}
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True, name='face-enrollment')
        try:
            threshold = float(os.getenv('AI_FACE_THRESHOLD', '.50'))
        except ValueError:
            threshold = .50
        self.threshold = min(.8, max(.4, threshold)) if math.isfinite(threshold) else .50
        self.thread.start()

    def status(self, state, message=''):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.root / 'status.tmp'
        temporary.write_text(json.dumps({'state': state, 'message': message, 'updated_at': round(time.time()*1000), 'model': MODEL}))
        os.replace(temporary, self.root / 'status.json')

    def sync_gallery(self):
        import psycopg
        with psycopg.connect(self.database_url, connect_timeout=5) as conn:
            rows = conn.execute('SELECT id, person_id, embedding FROM identity_samples WHERE model = %s ORDER BY id LIMIT 2000', (MODEL,)).fetchall()
        samples = {str(row[0]) for row in rows}
        portraits = self.root / 'portraits'
        if portraits.is_dir():
            for portrait in portraits.glob('*.jpg'):
                if re.fullmatch(r'[a-f0-9-]{36}\.jpg', portrait.name) and portrait.stem not in samples and time.time()-portrait.stat().st_mtime > 60:
                    portrait.unlink(missing_ok=True)
        revision = hashlib.sha256('|'.join(str(row[0])+str(row[1]) for row in rows).encode()).hexdigest()
        if revision != self.revision:
            gallery = tuple((str(person_id), unit_feature(embedding)) for _, person_id, embedding in rows)
            with self.lock:
                self.gallery, self.revision = gallery, revision
                self.memory.clear()

    def run(self):
        while not self.stopping.is_set():
            try:
                jobs = self.root / 'jobs'
                jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
                for directory in list(jobs.iterdir()):
                    if directory.is_dir() and not directory.is_symlink() and re.fullmatch(r'[a-f0-9-]{36}', directory.name) and time.time()-directory.stat().st_mtime > 600:
                        shutil.rmtree(directory, ignore_errors=True)
                if self.engine is None:
                    if not all((self.models / name).is_file() for name in ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx']):
                        self.status('unavailable', 'Chưa cài model khuôn mặt trên máy chủ.')
                        self.stopping.wait(3)
                        continue
                    self.engine = FaceEngine(self.models)
                self.sync_gallery()
                self.status('ready')
                jobs = self.root / 'jobs'
                jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
                for directory in list(jobs.iterdir()):
                    if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r'[a-f0-9-]{36}', directory.name):
                        continue
                    if time.time() - directory.stat().st_mtime > 600:
                        shutil.rmtree(directory, ignore_errors=True)
                        continue
                    if (directory / 'request.json').is_file() and not (directory / 'result.json').exists():
                        self.status('ready')
                        self.process_job(directory)
            except Exception:
                # Do not log images, names, vectors or submitted files.
                self.gallery = ()
                self.status('error', 'Chưa đọc được bộ mẫu khuôn mặt.')
            self.stopping.wait(1)

    def process_job(self, directory):
        result = {'state': 'error', 'message': 'Không đọc được ảnh. Chọn ảnh JPEG/PNG rõ mặt.'}
        try:
            import cv2
            source = directory / 'input'
            if source.is_symlink() or source.stat().st_size > 4*1024*1024:
                raise ValueError('Invalid image')
            # Read JPEG/PNG headers before decoding to bound allocation.
            header = source.read_bytes()
            from .image_size import image_size
            width, height = image_size(header)
            if width < 40 or height < 40 or width*height > 16_000_000 or max(width, height) > 8192:
                raise ValueError('Image dimensions exceed limit')
            image = cv2.imdecode(np.frombuffer(header, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError('Decode failed')
            faces = self.engine.analyze(image)
            result = {'state': 'ready', 'faces': []}
            for index, (face, aligned, feature) in enumerate(faces[:8]):
                face_id = str(index)
                cv2.imwrite(str(directory / f'{face_id}.jpg'), cv2.resize(aligned, (168, 168)), [cv2.IMWRITE_JPEG_QUALITY, 90])
                (directory / f'{face_id}.json').write_text(json.dumps({'model': MODEL, 'embedding': feature.tolist()}))
                result['faces'].append({'id': face_id})
            if not result['faces']:
                result = {'state': 'error', 'message': 'Chưa thấy khuôn mặt đủ rõ. Chọn ảnh gần hơn, nhìn rõ mặt và đủ sáng.'}
        except Exception:
            pass
        finally:
            (directory / 'input').unlink(missing_ok=True)
        temporary = directory / 'result.tmp'
        temporary.write_text(json.dumps(result))
        os.replace(temporary, directory / 'result.json')

    def annotate(self, image, detections, at):
        people = sorted((d for d in detections if d['label'] == 'person'), key=lambda d: (d['box'][2]-d['box'][0])*(d['box'][3]-d['box'][1]), reverse=True)
        for index, detection in enumerate(people):
            status = {'state': 'pending'}
            detection['identity'] = status
            if self.engine is None:
                status['state'] = 'unavailable'
                continue
            with self.lock:
                gallery = self.gallery
                previous = self.memory.get(detection['track_id'])
                if previous and 0 <= at - previous['at'] < .75:
                    detection['identity'] = dict(previous['result'])
                    continue
            if index >= 4:
                continue
            try:
                feature = self.engine.person_feature(image, detection['box'])
                candidate = match_identity(feature, gallery, self.threshold) if feature is not None and gallery else None
                status['state'] = 'unmatched' if feature is not None else 'not_visible'
                count = previous['hits']+1 if candidate and previous and previous['candidate'] == candidate and 0 < at-previous['at'] <= 3 else 1
                if candidate:
                    status['state'] = 'pending'
                    if count >= 2:
                        status = {'state': 'known', 'person_id': candidate}
                detection['identity'] = status
                with self.lock:
                    clock = time.monotonic()
                    self.memory = {key: value for key, value in self.memory.items() if clock-value['touched'] < 30}
                    self.memory[detection['track_id']] = {'at': at, 'touched': clock, 'candidate': candidate, 'hits': count, 'result': dict(status)}
            except Exception:
                detection['identity'] = {'state': 'unavailable'}
        return detections
