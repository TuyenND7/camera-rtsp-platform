import { createHash, randomBytes } from 'crypto';
import { Socket, connect } from 'net';

type Reply = { code: number; headers: Record<string, string>; body: string };
export type TalkTrack = { control: string; payload: number; codec: 'PCMA' | 'PCMU' };
const BACKCHANNEL = 'www.onvif.org/ver20/backchannel';

export class TalkError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** ONVIF Streaming 5.3.2 defines SDP direction from the client's perspective:
 * sendonly is client -> camera; recvonly is the camera microphone -> client.
 * A track without an explicit direction is not a confirmed backchannel. */
export function talkTrack(sdp: string): TalkTrack | null {
  const parts = sdp.split(/(?:^|\r?\n)m=/);
  const sessionDirection = parts[0].match(/(?:^|\n)a=(recvonly|sendonly|sendrecv|inactive)\s*(?:\r?\n|$)/)?.[1];
  for (const part of parts.slice(1)) {
    if (!part.startsWith('audio ')) continue;
    const direction = part.match(/(?:^|\n)a=(recvonly|sendonly|sendrecv|inactive)\s*(?:\r?\n|$)/)?.[1] ?? sessionDirection;
    if (direction !== 'sendonly') continue;
    const control = part.match(/(?:^|\n)a=control:([^\r\n]+)/)?.[1]?.trim();
    if (!control || control === '*') continue;
    const payloads = part.split(/\r?\n/)[0].trim().split(/\s+/).slice(3);
    for (const value of payloads) {
      const payload = Number(value);
      if (!Number.isInteger(payload) || payload < 0 || payload > 127) continue;
      const map = part.match(new RegExp(`(?:^|\\n)a=rtpmap:${payload} ([^\\r\\n]+)`, 'i'))?.[1];
      const codec = map?.toUpperCase() ?? (payload === 8 ? 'PCMA/8000' : payload === 0 ? 'PCMU/8000' : '');
      if (/^PCM[AU]\/8000(?:\/1)?$/.test(codec)) return { control, payload, codec: codec.startsWith('PCMA') ? 'PCMA' : 'PCMU' };
    }
  }
  return null;
}

export function g711(sample: number, codec: TalkTrack['codec']): number {
  if (codec === 'PCMU') {
    const sign = sample < 0 ? 0x80 : 0;
    let value = Math.min(32635, Math.abs(sample)) + 0x84;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
    return ~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15)) & 255;
  }
  const sign = sample < 0 ? 0 : 0x80;
  let value = sample < 0 ? -sample - 1 : sample;
  value = Math.min(32767, value);
  let exponent = 0;
  for (let n = value >> 8; n; n >>= 1) exponent++;
  const mantissa = (value >> (exponent ? exponent + 3 : 4)) & 15;
  return (sign | (exponent << 4) | mantissa) ^ 0x55;
}

export class RtspTalk {
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: { seq: string; resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private seq = 0;
  private challenge = '';
  private nonceCount = 0;
  private session = '';
  private uri: URL;
  private user: string;
  private password: string;
  private channel = 0;
  private rtpSequence = randomBytes(2).readUInt16BE();
  private timestamp = randomBytes(4).readUInt32BE();
  private ssrc = randomBytes(4).readUInt32BE();
  private track?: TalkTrack;
  private keepalive?: NodeJS.Timeout;
  private closed = false;
  onClose?: () => void;

  constructor(raw: string) {
    this.uri = new URL(raw);
    if (this.uri.protocol !== 'rtsp:' || !this.uri.hostname) throw new TalkError(422, 'Đàm thoại hiện hỗ trợ camera RTSP qua TCP.');
    this.user = decodeURIComponent(this.uri.username); this.password = decodeURIComponent(this.uri.password);
    this.uri.username = ''; this.uri.password = ''; this.uri.hash = '';
  }

  private fail(error: Error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
    this.close();
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 256 * 1024) { this.fail(new TalkError(502, 'Phản hồi camera vượt giới hạn.')); return; }
    while (this.buffer.length) {
      // The camera can interleave RTP/RTCP with RTSP responses.
      if (this.buffer[0] === 36) {
        if (this.buffer.length < 4) return;
        const size = 4 + this.buffer.readUInt16BE(2);
        if (this.buffer.length < size) return;
        this.buffer = this.buffer.subarray(size); continue;
      }
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString();
      const lines = header.split('\r\n'), headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      const length = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > 128 * 1024) { this.fail(new TalkError(502, 'Phản hồi camera không hợp lệ.')); return; }
      if (this.buffer.length < end + 4 + length) return;
      const reply = { code: Number(lines[0].split(' ')[1]), headers, body: this.buffer.subarray(end + 4, end + 4 + length).toString() };
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (this.pending && headers.cseq === this.pending.seq) {
        const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.resolve(reply);
      }
    }
  }

  private authorization(method: string, uri: string) {
    if (!this.challenge) return '';
    if (/^Basic /i.test(this.challenge)) return 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64');
    if (!/^Digest /i.test(this.challenge)) throw new TalkError(422, 'Camera dùng cách xác thực RTSP chưa được hỗ trợ.');
    const p: Record<string, string> = {};
    for (const m of this.challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1].toLowerCase()] = m[2] ?? m[3];
    const algorithm = (p.algorithm ?? 'MD5').toUpperCase();
    if (!p.realm || !p.nonce || !['MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'].includes(algorithm)) throw new TalkError(422, 'Xác thực RTSP chưa được hỗ trợ.');
    const hash = (s: string) => createHash(algorithm.startsWith('SHA-256') ? 'sha256' : 'md5').update(s).digest('hex');
    const quote = (s: string) => `"${s.replace(/[\r\n]/g, '').replace(/(["\\])/g, '\\$1')}"`;
    const cnonce = randomBytes(12).toString('hex'), nc = (++this.nonceCount).toString(16).padStart(8, '0');
    const qop = p.qop?.split(',').map(v => v.trim()).includes('auth') ? 'auth' : '';
    if (p.qop && !qop) throw new TalkError(422, 'Camera yêu cầu xác thực RTSP chưa được hỗ trợ.');
    let ha1 = hash(`${this.user}:${p.realm}:${this.password}`);
    if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${p.nonce}:${cnonce}`);
    const ha2 = hash(`${method}:${uri}`), response = hash(qop ? `${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${p.nonce}:${ha2}`);
    return `Digest username=${quote(this.user)}, realm=${quote(p.realm)}, nonce=${quote(p.nonce)}, uri=${quote(uri)}, response=${quote(response)}, algorithm=${algorithm}${qop ? `, qop=auth, nc=${nc}, cnonce=${quote(cnonce)}` : algorithm.endsWith('-SESS') ? `, cnonce=${quote(cnonce)}` : ''}${p.opaque ? `, opaque=${quote(p.opaque)}` : ''}`;
  }

  private async request(method: string, uri: string, extra: Record<string, string> = {}, retry = true): Promise<Reply> {
    if (this.closed || !this.socket || this.pending) throw new TalkError(502, 'Kênh đàm thoại đã đóng.');
    const seq = String(++this.seq), authorization = this.authorization(method, uri);
    const headers = { CSeq: seq, 'User-Agent': 'CameraStation', Require: BACKCHANNEL, ...(this.session ? { Session: this.session } : {}), ...extra, ...(authorization ? { Authorization: authorization } : {}) };
    const reply = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new TalkError(504, 'Camera không phản hồi kênh đàm thoại.')), 4000);
      this.pending = { seq, resolve, reject, timer };
      this.socket!.write(`${method} ${uri} RTSP/1.0\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    });
    if (reply.code === 401 && retry && reply.headers['www-authenticate']) {
      this.challenge = reply.headers['www-authenticate']; this.nonceCount = 0;
      return this.request(method, uri, extra, false);
    }
    if (reply.code === 551) throw new TalkError(422, 'Camera không hỗ trợ kênh nhận giọng nói ONVIF/RTSP (RTSP 551).');
    if (reply.code !== 200) throw new TalkError(reply.code === 401 ? 422 : 502, reply.code === 401 ? 'Tài khoản camera không được phép đàm thoại.' : 'Camera từ chối mở kênh đàm thoại.');
    return reply;
  }

  private resolveControl(control: string, base: string) {
    const url = new URL(control, base);
    if (url.protocol !== this.uri.protocol || url.hostname !== this.uri.hostname || (url.port || '554') !== (this.uri.port || '554')) throw new TalkError(422, 'Đường dẫn audio camera trỏ tới máy chủ khác.');
    url.username = ''; url.password = ''; url.hash = '';
    return url.href;
  }

  async describe(): Promise<TalkTrack | null> {
    this.socket = connect({ host: this.uri.hostname.replace(/^\[|\]$/g, ''), port: Number(this.uri.port || 554) });
    this.socket.on('data', data => this.consume(data));
    this.socket.on('error', () => this.fail(new TalkError(502, 'Không kết nối được tới camera.')));
    this.socket.on('close', () => this.fail(new TalkError(502, 'Camera đã ngắt kênh đàm thoại.')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new TalkError(504, 'Kết nối camera quá hạn.')); }, 4000);
      this.socket!.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket!.once('error', () => { clearTimeout(timer); reject(new TalkError(502, 'Không kết nối được tới camera.')); });
    });
    const reply = await this.request('DESCRIBE', this.uri.href, { Accept: 'application/sdp' });
    const track = talkTrack(reply.body);
    const fallback = new URL(this.uri); fallback.pathname = fallback.pathname.replace(/\/?$/, '/');
    if (track) this.track = { ...track, control: this.resolveControl(track.control, reply.headers['content-base'] ?? fallback.href) };
    return this.track ?? null;
  }

  async open() {
    if (!await this.describe()) throw new TalkError(422, 'Camera chưa cung cấp kênh nhận giọng nói ONVIF/RTSP.');
    const setup = await this.request('SETUP', this.track!.control, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    this.session = (setup.headers.session ?? '').split(';')[0];
    const channels = setup.headers.transport?.match(/interleaved=(\d+)-(\d+)/i);
    if (!this.session || !channels || Number(channels[1]) > 255) throw new TalkError(502, 'Camera không mở được audio qua TCP.');
    this.channel = Number(channels[1]);
    await this.request('PLAY', this.uri.href);
    this.keepalive = setInterval(() => { void this.request('GET_PARAMETER', this.uri.href).catch(() => this.close()); }, 10_000);
    return this.track!;
  }

  send(pcm: Buffer) {
    if (this.closed || !this.track || !this.socket || this.socket.writableLength > 16_384) throw new TalkError(502, 'Đường truyền audio tới camera bị gián đoạn.');
    const samples = pcm.length / 2, packet = Buffer.alloc(4 + 12 + samples);
    packet[0] = 36; packet[1] = this.channel; packet.writeUInt16BE(packet.length - 4, 2);
    packet[4] = 0x80; packet[5] = this.track.payload; packet.writeUInt16BE(this.rtpSequence++ & 0xffff, 6);
    packet.writeUInt32BE(this.timestamp, 8); packet.writeUInt32BE(this.ssrc, 12);
    for (let i = 0; i < samples; i++) packet[16 + i] = g711(pcm.readInt16LE(i * 2), this.track.codec);
    this.timestamp = (this.timestamp + samples) >>> 0;
    this.socket.write(packet);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new TalkError(502, 'Kênh đàm thoại đã đóng.')); this.pending = undefined; }
    if (this.session && this.socket?.writable) {
      let auth = '';
      try { auth = this.authorization('TEARDOWN', this.uri.href); } catch { /* Always release even when the camera changes its auth challenge. */ }
      this.socket.end(`TEARDOWN ${this.uri.href} RTSP/1.0\r\nCSeq: ${++this.seq}\r\nSession: ${this.session}\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`);
      setTimeout(() => this.socket?.destroy(), 200).unref();
    } else this.socket?.destroy();
    this.onClose?.();
  }
}
