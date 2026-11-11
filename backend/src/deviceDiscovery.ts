import net from 'net';
import http from 'http';
import https from 'https';
import os from 'os';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { Discovery } from 'onvif';

export interface KnownCamera { id: number; name: string; rtsp_url: string; onvif_url: string | null }
export interface DiscoveredDevice {
  ip: string;
  name: string;
  onvif_url: string | null;
  rtsp_port: number | null;
  protocols: Array<'onvif' | 'rtsp'>;
  added_cameras: Array<{ id: number; name: string }>;
}
export interface DiscoveryState {
  id: string;
  subnet: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  scanned_hosts: number;
  total_hosts: number;
  progress_percent: number;
  devices: DiscoveredDevice[];
  error: string | null;
}

const PORTS = [554, 8554, 80, 6688, 8000, 8080, 8899, 2020, 443];
const CONCURRENCY = 48;
const SOAP_TIME = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><tds:GetSystemDateAndTime xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>';

// Raw/malformed multicast replies must not become an unhandled EventEmitter error.
Discovery.on('error', () => undefined);

/** A single private /24, never arbitrary hosts, public IPs or unbounded ranges. */
export function normalizeDiscoverySubnet(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const [address, mask, extra] = value.trim().split('/');
  if (extra !== undefined || (mask !== undefined && mask !== '24') || net.isIP(address) !== 4) return null;
  const [a, b, c] = address.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null;
  return `${a}.${b}.${c}.0/24`;
}

function hostOf(url: string) { try { return new URL(url).hostname; } catch { return ''; } }
function inSubnet(ip: string, subnet: string) { return normalizeDiscoverySubnet(ip) === subnet && !['0', '255'].includes(ip.split('.')[3]); }

export function discoveryNetworks(serverHost: string, cameras: KnownCamera[]): string[] {
  const hosts = [process.env.CAMERA_DISCOVERY_SUBNET ?? '', serverHost, ...cameras.map((camera) => hostOf(camera.rtsp_url))];
  // Docker's interface belongs to the VM, not the Windows camera LAN.
  if (!existsSync('/.dockerenv')) {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses ?? []) if (address.family === 'IPv4' && !address.internal) hosts.push(address.address);
    }
  }
  return [...new Set(hosts.map(normalizeDiscoverySubnet).filter((value): value is string => value !== null))];
}

export function isOnvifReply(status: number, body: string, challenge: string): boolean {
  if (status === 401 && /\bonvif\b/i.test(challenge)) return true;
  return /https?:\/\/www\.onvif\.org\/ver(?:10|20)\//i.test(body)
    && /<(?:[\w.-]+:)?(?:GetSystemDateAndTimeResponse|GetDeviceInformationResponse|Fault)\b/i.test(body);
}

/** Probe only the ONVIF clock endpoint. Do not log in, configure or restart devices. */
export function probeOnvifEndpoint(ip: string, port: number, timeout = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    const secure = port === 443;
    const url = `${secure ? 'https' : 'http'}://${ip}:${port}/onvif/device_service`;
    let settled = false;
    const done = (value: string | null) => { if (!settled) { settled = true; resolve(value); } };
    const req = (secure ? https : http).request(url, {
      method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(SOAP_TIME), Connection: 'close' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 32_768) { done(null); req.destroy(); }
      });
      response.on('end', () => done(isOnvifReply(response.statusCode ?? 0, body, String(response.headers['www-authenticate'] ?? '')) ? url : null));
      response.on('error', () => done(null));
    });
    const deadline = setTimeout(() => { done(null); req.destroy(); }, timeout);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => done(null));
    req.end(SOAP_TIME);
  });
}

export function probeRtsp(ip: string, port: number, timeout = 850): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let settled = false;
    let text = '';
    const done = (value: boolean) => { if (!settled) { settled = true; clearTimeout(deadline); socket.destroy(); resolve(value); } };
    const deadline = setTimeout(() => done(false), timeout);
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => socket.write(`OPTIONS rtsp://${ip}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: CameraStation-Discovery\r\n\r\n`));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (/^RTSP\/1\.\d [1-5]\d\d\b/.test(text)) done(true);
      else if (text.length > 4096 || text.includes('\n')) done(false);
    });
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

function portOpen(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let settled = false;
    const done = (value: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(550, () => done(false));
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('close', () => done(false));
  });
}

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }

export function deviceFromProbe(raw: unknown, sender: string, subnet: string): Pick<DiscoveredDevice, 'ip' | 'name' | 'onvif_url'> | null {
  if (!inSubnet(sender, subnet)) return null;
  const match = object(object(object(raw).probeMatches).probeMatch);
  const addresses = typeof match.XAddrs === 'string' ? match.XAddrs.split(/\s+/) : [];
  for (const address of addresses) {
    try {
      const url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || !inSubnet(url.hostname, subnet) || url.hostname !== sender || url.username || url.password) continue;
      const rawScopes = match.scopes ?? match.Scopes;
      const scopes = typeof rawScopes === 'string' ? rawScopes : '';
      const nameScope = /onvif:\/\/www\.onvif\.org\/(?:name|hardware)\/([^\s]+)/i.exec(scopes)?.[1];
      let name = `Thiết bị ${sender}`;
      if (nameScope) { try { name = decodeURIComponent(nameScope).replace(/[\x00-\x1f]/g, '').slice(0, 80); } catch { /* keep fallback */ } }
      return { ip: sender, name, onvif_url: url.toString() };
    } catch { /* Ignore invalid addresses advertised by a device. */ }
  }
  return null;
}

interface ScanJob { state: DiscoveryState; created: number; cancelled: boolean }

class DeviceDiscoveryManager {
  private jobs = new Map<string, ScanJob>();
  private active: ScanJob | null = null;

  get(id: string): DiscoveryState | null { const job = this.jobs.get(id); return job ? this.snapshot(job) : null; }
  cancel(id: string): DiscoveryState | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state.status === 'running') { job.cancelled = true; job.state.status = 'cancelled'; }
    return this.snapshot(job);
  }

  start(subnet: string, cameras: KnownCamera[]): DiscoveryState {
    const normalized = normalizeDiscoverySubnet(subnet);
    if (!normalized) throw new Error('Chỉ hỗ trợ dải mạng nội bộ /24, ví dụ 192.168.0.0/24.');
    if (this.active) {
      if (!this.active.cancelled && this.active.state.subnet === normalized) return this.snapshot(this.active);
      throw new Error('Một lượt dò đang kết thúc. Vui lòng thử lại sau vài giây.');
    }
    for (const [id, job] of this.jobs) if (Date.now() - job.created > 10 * 60_000 || this.jobs.size >= 8) this.jobs.delete(id);
    const job: ScanJob = { created: Date.now(), cancelled: false, state: { id: randomUUID(), subnet: normalized, status: 'running', scanned_hosts: 0, total_hosts: 254, progress_percent: 0, devices: [], error: null } };
    this.jobs.set(job.state.id, job); this.active = job;
    void this.run(job, cameras).finally(() => { if (this.active === job) this.active = null; });
    return this.snapshot(job);
  }

  private snapshot(job: ScanJob): DiscoveryState {
    return { ...job.state, devices: [...job.state.devices].sort((a, b) => Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3])).map((device) => ({ ...device, protocols: [...device.protocols], added_cameras: [...device.added_cameras] })) };
  }

  private async run(job: ScanJob, cameras: KnownCamera[]) {
    const { subnet } = job.state;
    const found = new Map<string, DiscoveredDevice>();
    const known = new Map<string, KnownCamera[]>();
    for (const camera of cameras) { const ip = hostOf(camera.rtsp_url); known.set(ip, [...(known.get(ip) ?? []), camera]); }
    const add = (ip: string, protocol: 'onvif' | 'rtsp', onvifUrl: string | null = null, port: number | null = null, name?: string) => {
      if (job.cancelled || !inSubnet(ip, subnet)) return;
      let device = found.get(ip);
      if (!device) {
        const added = known.get(ip) ?? [];
        device = { ip, name: added[0]?.name || name || `Thiết bị ${ip}`, onvif_url: null, rtsp_port: null, protocols: [], added_cameras: added.map(({ id, name: cameraName }) => ({ id, name: cameraName })) };
        found.set(ip, device); job.state.devices.push(device);
      }
      if (!device.protocols.includes(protocol)) device.protocols.push(protocol);
      if (onvifUrl) device.onvif_url = onvifUrl;
      if (port) device.rtsp_port = port;
      if (name && !device.added_cameras.length) device.name = name;
    };
    const onDevice = (raw: object, remote: { address: string }) => {
      const device = deviceFromProbe(raw, remote.address, subnet);
      if (device) add(device.ip, 'onvif', device.onvif_url, null, device.name);
    };
    const multicast = new Promise<void>((resolve) => {
      Discovery.on('device', onDevice);
      try { Discovery.probe({ timeout: 2200, resolve: false }, () => undefined); } catch { /* Unicast scan below also works through Docker Desktop NAT. */ }
      setTimeout(() => { Discovery.removeListener('device', onDevice); resolve(); }, 2500);
    });
    const prefix = subnet.split('.').slice(0, 3).join('.');
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).sort((a, b) => Number(known.has(b)) - Number(known.has(a)));
    const remaining = new Map(hosts.map((host) => [host, PORTS.length]));
    let checked = 0;
    const runChecks = async (checks: Array<{ ip: string; port: number }>) => {
      let next = 0;
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (!job.cancelled && next < checks.length) {
          const { ip, port } = checks[next++];
          if (port === 554 || port === 8554) {
            if (await probeRtsp(ip, port)) add(ip, 'rtsp', null, port);
          } else if (await portOpen(ip, port)) {
            const url = await probeOnvifEndpoint(ip, port);
            if (url) add(ip, 'onvif', url);
          }
          job.state.progress_percent = Math.floor(++checked / (hosts.length * PORTS.length) * 100);
          const count = (remaining.get(ip) ?? 1) - 1;
          remaining.set(ip, count);
          if (count === 0) job.state.scanned_hosts++;
        }
      }));
    };
    const deadline = setTimeout(() => { job.cancelled = true; job.state.status = 'error'; job.state.error = 'Lượt dò đã hết thời gian. Bạn có thể dò lại hoặc thêm thiết bị thủ công.'; }, 40_000);
    try {
      await Promise.all([multicast, (async () => {
        // Find video services across the whole LAN first, then prioritise their
        // ONVIF endpoints. This also works when multicast cannot cross Docker NAT.
        await runChecks(hosts.flatMap((ip) => [554, 8554].map((port) => ({ ip, port }))));
        const ordered = [...hosts].sort((a, b) => Number(found.has(b)) - Number(found.has(a)));
        await runChecks(ordered.flatMap((ip) => PORTS.filter((port) => port !== 554 && port !== 8554).map((port) => ({ ip, port }))));
      })()]);
      if (!job.cancelled) job.state.status = 'complete';
    } catch {
      job.state.status = 'error'; job.state.error = 'Không thể dò mạng. Kiểm tra kết nối LAN của máy chủ rồi thử lại.';
    } finally { clearTimeout(deadline); }
  }
}

export const deviceDiscovery = new DeviceDiscoveryManager();
