"""Bound JPEG/PNG allocation before passing uploaded images to OpenCV."""
import struct


def image_size(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24 and data[12:16] == b'IHDR':
        return struct.unpack('>II', data[16:24])
    if not data.startswith(b'\xff\xd8'):
        raise ValueError('JPEG or PNG required')
    at = 2
    while at + 4 <= len(data):
        if data[at] != 255:
            raise ValueError('Invalid JPEG marker')
        while at < len(data) and data[at] == 255:
            at += 1
        if at+3 > len(data):
            raise ValueError('Truncated JPEG marker')
        marker = data[at]
        at += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        length = int.from_bytes(data[at:at+2], 'big')
        if length < 2 or at + length > len(data):
            break
        if marker in (0xC0, 0xC1, 0xC2) and length >= 7:
            height, width = struct.unpack('>HH', data[at+3:at+7])
            return width, height
        if marker == 0xDA:
            break
        at += length
    raise ValueError('Invalid JPEG dimensions')
