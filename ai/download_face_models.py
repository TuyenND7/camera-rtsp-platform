"""Download pinned, checksum-verified OpenCV Zoo face models (no camera data)."""
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

COMMIT = '48b10fa505aeb51fbd127fc60a5c660040e823b7'
MODELS = [
    ('face_detection_yunet', 'face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'),
    ('face_recognition_sface', 'face_recognition_sface_2021dec.onnx', '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'),
]


def main():
    target = Path(sys.argv[1] if len(sys.argv) > 1 else 'models')
    target.mkdir(parents=True, exist_ok=True)
    for directory, name, checksum in MODELS:
        file = target / name
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != checksum:
            url = f'https://media.githubusercontent.com/media/opencv/opencv_zoo/{COMMIT}/models/{directory}/{name}'
            temporary = file.with_suffix('.download')
            try:
                with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
                    while chunk := response.read(1024*1024):
                        output.write(chunk)
                if hashlib.sha256(temporary.read_bytes()).hexdigest() != checksum:
                    raise RuntimeError('Model checksum mismatch: '+name)
                os.replace(temporary, file)
            finally:
                temporary.unlink(missing_ok=True)
        license_file = target / (directory + '-LICENSE.txt')
        license_file.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/opencv/opencv_zoo/{COMMIT}/models/{directory}/LICENSE', timeout=30).read())
        print('Verified '+name)


if __name__ == '__main__':
    main()
