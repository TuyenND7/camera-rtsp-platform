import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { Camera, DetectionEvent, DiscoveryState, RecordingDay } from '../src/api';

const MEDIA = '/__ui-preview__/sample.mp4';
const SAMPLE_DURATION = 120;
const user = { id: 1, username: 'UI Demo', role: 'admin' };

function camera(id: number, name: string, overrides: Partial<Camera> = {}): Camera {
  return { id, name, rtsp_url: `rtsp://192.0.2.${10 + id}:554/preview`, enabled: true, record: true,
    onvif_url: `http://192.0.2.${10 + id}/onvif/device_service`,
    codec: 'h264', status: 'online', ai_enabled: true, ai_fps: 2, ai_confidence: 0.5,
    ai_labels: ['person', 'car'], last_error: null, updated_at: new Date().toISOString(), ...overrides };
}

function days(): string[] {
  return Array.from({ length: 5 }, (_, index) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
    .format(new Date(Date.now() - index * 86_400_000)).replace(/-/g, ''));
}

function dayData(day: string): RecordingDay {
  const start = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T10:00:00+07:00`);
  return { playlist: MEDIA, day_playback: { original: MEDIA, archive: null, duration_s: SAMPLE_DURATION },
    thumb: { width: 160, height: 90, interval_s: 10 },
    segments: [0, 40, 80].map((offset) => ({ file: `preview_${offset}.ts`, url: MEDIA, size: 2_500_000,
      mtime: new Date(start + (offset + 40) * 1000).toISOString(), started_at: new Date(start + offset * 1000).toISOString(),
      duration_s: 40, offset_s: offset, archive_offset_s: null, thumb_url: '/__ui-preview__/scene.svg', thumb_tiles: 1 })) };
}

function scene(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <rect width="960" height="540" fill="#243b57"/><path d="M0 360H960V540H0Z" fill="#365672"/>
    <rect x="110" y="70" width="260" height="200" rx="8" fill="#a2c4dd"/><path d="M240 70V270M110 170H370" stroke="#6c91af" stroke-width="12"/>
    <rect x="470" y="240" width="350" height="150" rx="30" fill="#7f9fba"/><rect x="440" y="310" width="410" height="100" rx="20" fill="#a3bed2"/>
    <ellipse cx="280" cy="435" rx="180" ry="45" fill="#527691"/><text x="28" y="40" font-family="sans-serif" font-size="22" fill="white">UI PREVIEW · SAMPLE DATA</text></svg>`;
}

function json(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(status === 204 ? undefined : JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 65_536) throw new Error('Request too large');
  }
  return text ? JSON.parse(text) : {};
}

/** Installed only by `vite --mode ui-preview`; it has no database or network client. */
export function uiPreviewPlugin(): Plugin {
  let settings = { public_base_url: '', storage_label: 'Ổ lưu trữ mẫu', record_retention_hours: 0,
    cleanup_threshold_percent: 90, cleanup_target_percent: 85, cleanup_interval_minutes: 10 };
  let cameras = [
    camera(1, 'Phòng khách · ONVIF mẫu'),
    camera(2, 'Sân trước · chỉ RTSP', { onvif_url: null }),
    camera(3, 'Cổng chính · mất kết nối', { status: 'error', last_error: 'Camera chưa phản hồi. Kiểm tra nguồn điện và kết nối mạng rồi thử lại.' }),
    camera(4, 'Hành lang · đang kết nối', { onvif_url: null, status: 'connecting', ai_enabled: false }),
    camera(5, 'Kho · mẫu', { onvif_url: null, enabled: false, status: 'stopped', record: false, ai_enabled: false }),
    camera(6, 'Cửa hàng · ONVIF cố định', { ai_enabled: false }),
  ];
  let nextId = 7;
  let discovery: DiscoveryState = { id: 'ui-preview', subnet: '192.168.50.0/24', status: 'complete',
    scanned_hosts: 254, total_hosts: 254, progress_percent: 100, error: null,
    devices: [{ ip: '192.168.50.20', name: 'Camera ONVIF mẫu', onvif_url: 'http://192.168.50.20/onvif/device_service',
      rtsp_port: 554, protocols: ['onvif', 'rtsp'], added_cameras: [] },
      { ip: '192.168.50.21', name: 'Camera chỉ RTSP mẫu', onvif_url: null,
        rtsp_port: 554, protocols: ['rtsp'], added_cameras: [] }] };
  const presets = new Map<number, Array<{ token: string; name: string }>>();

  function connect(cam: Camera) {
    cam.enabled = true;
    cam.status = cam.id === 3 ? 'error' : cam.id === 4 ? 'connecting' : 'online';
    cam.last_error = cam.id === 3 ? 'Camera chưa phản hồi. Kiểm tra nguồn điện và kết nối mạng rồi thử lại.' : null;
    cam.updated_at = new Date().toISOString();
  }

  function ptzUnavailable(cam: Camera): string | null {
    if (!cam.enabled || cam.status !== 'online') return 'Thiết bị mẫu chưa trực tuyến.';
    if (!cam.onvif_url) return 'Camera mẫu chỉ hỗ trợ RTSP, không có ONVIF.';
    if (cam.id === 6) return 'Camera mẫu hỗ trợ ONVIF nhưng không có chức năng quay quét.';
    return null;
  }

  return {
    name: 'camera-ui-preview',
    apply: 'serve',
    async configureServer(server) {
      // Docker builds only the web directory. Load the shared validator when
      // preview is running, rather than bundling backend source into Vite config.
      const validatorPath = path.resolve(server.config.root, '../backend/src/settingsValidation.ts').replace(/\\/g, '/');
      const { validateSettings } = await server.ssrLoadModule(`/@fs/${validatorPath}`) as typeof import('../../backend/src/settingsValidation');
      const mediaFile = path.resolve(server.config.root, 'dev/media/sample.mp4');
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        if (pathname === '/__ui-preview__/scene.svg') {
          res.setHeader('Content-Type', 'image/svg+xml'); res.end(scene()); return;
        }
        if (pathname === MEDIA) {
          const size = fs.statSync(mediaFile).size;
          const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
          if (start > end || start >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.end(); return; }
          if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`); }
          res.setHeader('Content-Length', end - start + 1);
          if (method === 'HEAD') res.end();
          else { const stream = fs.createReadStream(mediaFile, { start, end }); res.on('close', () => stream.destroy()); stream.pipe(res); }
          return;
        }
        if (pathname !== '/api' && !pathname.startsWith('/api/')) { next(); return; }
        try {
          if (pathname === '/api/auth/session' || pathname === '/api/auth/login') {
            req.resume(); json(res, { user, csrf: 'ui-preview-only' }); return;
          }
          if (pathname === '/api/auth/logout') { req.resume(); json(res, null, 204); return; }
          if (pathname === '/api/health') { json(res, { ok: true, preview: true }); return; }
          if (pathname === '/api/talk/capabilities') {
            const ids = (await body(req)).camera_ids;
            json(res, cameras.filter(c => Array.isArray(ids) && ids.includes(c.id)).map(c => ({ camera_id: c.id,
              supported: c.status === 'online' && c.enabled && c.id !== 2,
              reason: c.status !== 'online' || !c.enabled ? 'Camera mẫu chưa trực tuyến.' : c.id === 2 ? 'Camera mẫu chưa cung cấp kênh nhận giọng nói.' : 'Kênh đàm thoại mẫu · không gửi audio tới camera thật', codec: 'PCMA' })));
            return;
          }
          if (pathname.startsWith('/api/talk/sessions')) { req.resume(); json(res, { error: 'Bản xem trước không gửi giọng nói tới camera thật.' }, 422); return; }
          if (pathname === '/api/settings') {
            if (method === 'PUT') {
              try { settings = validateSettings(await body(req)); json(res, { settings }); }
              catch (error) { json(res, { error: (error as Error).message }, 400); }
            } else if (method === 'GET') json(res, { settings, storage_root: '/storage', record_timezone: 'Asia/Ho_Chi_Minh' });
            else { req.resume(); json(res, { error: 'Phương thức không được hỗ trợ.' }, 405); }
            return;
          }
          if (pathname === '/api/recordings/storage') {
            json(res, { label: settings.storage_label, total_bytes: 1_000_000_000_000, used_bytes: 420_000_000_000,
              free_bytes: 580_000_000_000, used_percent: 42, recording_bytes: 300_000_000_000, recording_days: 5,
              cleanup_threshold_percent: settings.cleanup_threshold_percent, cleanup_target_percent: settings.cleanup_target_percent,
              recent_cleanups: [{ at: new Date().toISOString(), camera_id: 1, day: days()[4], bytes: 15_000_000_000, reason: 'quota', used_percent: 90 }] }); return;
          }
          if (pathname === '/api/cameras/discovery/options') { json(res, { subnets: ['192.168.50.0/24'], default_subnet: '192.168.50.0/24' }); return; }
          if (pathname === '/api/cameras/discovery' || pathname.startsWith('/api/cameras/discovery/')) {
            if (method === 'POST') discovery = { ...discovery, subnet: String((await body(req)).subnet ?? discovery.subnet), status: 'complete' };
            if (method === 'DELETE') discovery = { ...discovery, status: 'cancelled' };
            json(res, discovery, method === 'POST' ? 202 : 200); return;
          }
          if (pathname === '/api/cameras/onvif/probe') {
            const data = await body(req); const host = new URL(String(data.url)).hostname;
            const cam = cameras.find(value => new URL(value.rtsp_url).hostname === host);
            if ((cam && !cam.onvif_url) || discovery.devices.some(device => device.ip === host && !device.onvif_url)) {
              json(res, { error: 'Thiết bị mẫu chỉ hỗ trợ RTSP, không có ONVIF.' }, 400); return;
            }
            if (cam && cam.status !== 'online') { json(res, { error: 'Thiết bị mẫu chưa trực tuyến.' }, 503); return; }
            const uri = `rtsp://${host}:554/preview`;
            json(res, { device: { manufacturer: 'UI Preview', model: 'Camera mẫu', firmware_version: 'demo', serial_number: 'DEMO-001' },
              profiles: [{ token: 'main', name: 'Main stream mẫu', stream_uri: uri, codec: 'h264', width: 640, height: 360, fps: 10, bitrate: 500 }],
              suggested_main_uri: uri, suggested_sub_uri: uri }); return;
          }
          if (pathname === '/api/cameras') {
            if (method === 'POST') { const id = nextId++; const item = { ...camera(id, 'Camera mẫu', { onvif_url: null }), ...await body(req), id }; if (!item.enabled) item.status = 'stopped'; cameras.push(item); json(res, item, 201); }
            else json(res, cameras);
            return;
          }
          const item = pathname.match(/^\/api\/cameras\/(\d+)(?:\/(.*))?$/);
          if (item) {
            const id = Number(item[1]); const cam = cameras.find(value => value.id === id); const action = item[2];
            if (!cam) { json(res, { error: 'Không tìm thấy camera mẫu' }, 404); return; }
            if (!action) {
              if (method === 'PUT') {
                const data = await body(req); Object.assign(cam, data, { id });
                if (data.enabled === false) { cam.status = 'stopped'; cam.last_error = null; }
                else if (data.enabled === true) connect(cam);
              }
              if (method === 'DELETE') { cameras = cameras.filter(value => value.id !== id); json(res, null, 204); }
              else json(res, cam);
              return;
            }
            if (action === 'stop' || action === 'start' || action === 'reconnect') {
              req.resume();
              if (action === 'stop') { cam.enabled = false; cam.status = 'stopped'; cam.last_error = null; }
              else connect(cam);
              if (cam.status === 'error') json(res, { error: cam.last_error }, 503);
              else json(res, { ok: true, moved: null });
              return;
            }
            if (action.startsWith('ptz')) {
              const reason = ptzUnavailable(cam);
              if (reason) { req.resume(); json(res, method === 'GET' ? { supported: false, reason } : { error: reason }, method === 'GET' ? 200 : 409); return; }
              const list = presets.get(id) ?? [{ token: 'home', name: 'Góc mặc định' }];
              if (action === 'ptz/presets' && method === 'POST') list.push({ token: String(Date.now()), name: String((await body(req)).name ?? 'Góc mẫu') });
              if (method === 'DELETE') { const token = decodeURIComponent(action.split('/')[2]); presets.set(id, list.filter(value => value.token !== token)); }
              else presets.set(id, list);
              req.resume(); json(res, { ok: true, supported: true, position: { x: 0, y: 0, zoom: 0 }, moving: false, presets: presets.get(id) }); return;
            }
          }
          const recordings = pathname.match(/^\/api\/recordings\/(\d+)\/(days|\d{8})(?:\/(.*))?$/);
          if (recordings) {
            if (recordings[2] === 'days') { json(res, days()); return; }
            if (recordings[3] === 'browser-playback') { req.resume(); json(res, { status: 'ready', playlist: MEDIA, error: null, start_position: 0 }); return; }
            json(res, dayData(recordings[2])); return;
          }
          if (pathname === '/api/events') {
            const day = days()[0]; const start = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T10:00:00+07:00`);
            let events: DetectionEvent[] = cameras.filter(cam => cam.ai_enabled).map((cam, index) => ({ id: index + 1, camera_id: cam.id, camera_name: cam.name,
              detected_at: new Date(start + index * 30_000).toISOString(), label: index % 2 ? 'car' : 'person', confidence: 0.93,
              snapshot_url: '/__ui-preview__/scene.svg', metadata: { box: [120, 80, 300, 240], ai_fps: 2 } }));
            if (url.searchParams.get('cameraId')) events = events.filter(value => value.camera_id === Number(url.searchParams.get('cameraId')));
            if (url.searchParams.get('label')) events = events.filter(value => value.label === url.searchParams.get('label'));
            json(res, events.slice(0, Number(url.searchParams.get('limit') ?? 100))); return;
          }
          req.resume(); json(res, { error: 'Chưa có dữ liệu mẫu cho thao tác này.' }, 404);
        } catch { json(res, { error: 'Dữ liệu mẫu không hợp lệ.' }, 400); }
      });
    },
  };
}
