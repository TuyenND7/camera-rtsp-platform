import { isUiPreview } from './preview';

const API_BASE = isUiPreview ? '/api' : (import.meta as any).env?.VITE_API_BASE ?? '/api';
export interface SessionUser { id: number; username: string; role: string }
export interface DeviceControls {
  camera_id: number;
  available: boolean;
  reason?: string;
  alarm_supported: boolean;
  alarm_active: boolean | null;
  light_supported: boolean;
  light_enabled: boolean | null;
  talking?: boolean;
  observed_at?: number;
  ends_at?: number | null;
  confirmed?: boolean;
}
export interface TalkCapability { camera_id: number; supported: boolean; reason: string; codec?: string }
export interface TalkSession { id: string; camera_ids: number[]; sample_rate: number; max_seconds: number }
export interface ServerSettings {
  public_base_url: string;
  storage_label: string;
  record_retention_hours: number;
  cleanup_threshold_percent: number;
  cleanup_target_percent: number;
  cleanup_interval_minutes: number;
}
export interface SettingsInfo { settings: ServerSettings; storage_root: string; record_timezone: string }
let csrf = '';
// Retire browser-readable bearer credentials from older builds.
localStorage.removeItem('token'); localStorage.removeItem('user');

export interface Camera {
  id: number;
  name: string;
  rtsp_url: string;
  enabled: boolean;
  record: boolean;
  codec: 'auto' | 'h264' | 'h265';
  ai_enabled?: boolean;
  ai_rtsp_url?: string | null;
  ai_fps?: number;
  ai_confidence?: number;
  ai_labels?: string[];
  onvif_url?: string | null;
  status: string;
  last_error?: string | null;
  updated_at?: string;
}

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

export interface DetectionEvent {
  id: number;
  camera_id: number;
  camera_name: string;
  detected_at: string;
  label: string;
  confidence: number;
  snapshot_url: string | null;
  metadata: { box?: number[]; ai_fps?: number };
}

export interface OnvifProfile {
  token: string;
  name: string;
  stream_uri: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
}

export interface OnvifProbeResult {
  device: {
    manufacturer: string | null;
    model: string | null;
    firmware_version: string | null;
    serial_number: string | null;
  };
  profiles: OnvifProfile[];
  suggested_main_uri: string;
  suggested_sub_uri: string | null;
}

export interface RecordingSegment {
  file: string;
  url: string;
  size: number;
  mtime: string;
  /** ISO UTC ('Z'), null nếu tên file không đúng mẫu. */
  started_at: string | null;
  duration_s: number;
  /** Vị trí (giây) trong playlist gốc cả ngày; null = đang ghi dở. */
  offset_s: number | null;
  /** Vị trí (giây) trong archive H.264 cả ngày (camera HEVC). */
  archive_offset_s: number | null;
  thumb_url: string | null;
  thumb_tiles: number;
}

export interface RecordingDay {
  playlist: string | null;
  day_playback?: {
    original: string | null;
    archive: string | null;
    duration_s: number;
  };
  thumb?: { width: number; height: number; interval_s: number };
  segments: RecordingSegment[];
}

export interface BrowserPlaybackState {
  status: 'ready' | 'processing' | 'error';
  playlist: string | null;
  error: string | null;
  start_position: number | null;
}

export interface PtzPreset {
  token: string;
  name: string;
}

export interface PtzInfo {
  supported: boolean;
  pan_tilt?: boolean;
  zoom?: boolean;
  reason?: string;
  position?: { x: number; y: number; zoom: number } | null;
  moving?: boolean;
  presets?: PtzPreset[];
}

export interface CameraVideoProfile {
  token: string; name: string; codec: string;
  width: number | null; height: number | null; fps: number | null; bitrate: number | null;
  resolutions: Array<{ width: number; height: number }>;
  fps_range: { min: number; max: number } | null;
  bitrate_range: { min: number; max: number } | null;
  editable: boolean; revision: string;
}
export interface CameraVideoSettings { supported: boolean; reason?: string; profiles: CameraVideoProfile[]; confirmed?: boolean }
export interface CameraVideoChange { profile_token: string; revision: string; width: number; height: number; fps?: number; bitrate?: number }

export interface StorageStatus {
  label: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_percent: number;
  recording_bytes: number;
  recording_days: number;
  cleanup_threshold_percent: number;
  cleanup_target_percent: number;
  recent_cleanups?: Array<{ at: string; camera_id: number; day: string; bytes: number; reason: string; used_percent: number | null }>;
}

function authHeaders(): Record<string, string> {
  return { 'X-Requested-With': 'CameraStation', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    csrf = '';
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  async cameraVideoSettings(id: number) {
    return handle<CameraVideoSettings>(await fetch(`${API_BASE}/cameras/${id}/video-settings`, { headers: authHeaders(), cache: 'no-store' }));
  },
  async setCameraVideoSettings(id: number, change: CameraVideoChange) {
    return handle<CameraVideoSettings>(await fetch(`${API_BASE}/cameras/${id}/video-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(change) }));
  },
  async deviceControls(cameraId: number) {
    return handle<DeviceControls>(await fetch(`${API_BASE}/cameras/${cameraId}/controls`, { headers: authHeaders(), cache: 'no-store' }));
  },
  async setDeviceControl(cameraId: number, action: 'alarm' | 'light', enabled: boolean, durationSeconds = 10) {
    return handle<DeviceControls>(await fetch(`${API_BASE}/cameras/${cameraId}/controls`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ action, enabled, duration_seconds: durationSeconds }) }));
  },
  async talkCapabilities(cameraIds: number[]) {
    return handle<TalkCapability[]>(await fetch(`${API_BASE}/talk/capabilities`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ camera_ids: cameraIds }) }));
  },
  async startTalk(cameraIds: number[]) {
    return handle<TalkSession>(await fetch(`${API_BASE}/talk/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ camera_ids: cameraIds }) }));
  },
  async talkAudio(id: string, sequence: number, pcm: ArrayBuffer, signal: AbortSignal) {
    const response = await fetch(`${API_BASE}/talk/sessions/${encodeURIComponent(id)}/audio`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream', 'X-Audio-Sequence': String(sequence) }, body: pcm, signal });
    if (!response.ok) await handle<never>(response);
  },
  async stopTalk(id: string) {
    // Keep cleanup alive during navigation/pagehide. No URL credentials.
    await fetch(`${API_BASE}/talk/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders(), keepalive: true });
  },
  async session(): Promise<SessionUser | null> {
    const response = await fetch(`${API_BASE}/auth/session`, { cache: 'no-store' });
    if (response.status === 401) { csrf = ''; return null; }
    const data = await handle<{ user: SessionUser; csrf: string }>(response);
    csrf = data.csrf; return data.user;
  },
  async logout() {
    await handle<void>(await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders() }));
    csrf = '';
  },
  async health() {
    return handle<{ ok: boolean }>(await fetch(`${API_BASE}/health`));
  },
  async discoveryOptions() {
    return handle<{ subnets: string[]; default_subnet: string }>(await fetch(`${API_BASE}/cameras/discovery/options`, { headers: authHeaders() }));
  },

  async discoverDevices(subnet: string) {
    return handle<DiscoveryState>(await fetch(`${API_BASE}/cameras/discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ subnet }) }));
  },

  async discoveryStatus(id: string) {
    return handle<DiscoveryState>(await fetch(`${API_BASE}/cameras/discovery/${encodeURIComponent(id)}`, { headers: authHeaders() }));
  },

  async cancelDiscovery(id: string) {
    return handle<DiscoveryState>(await fetch(`${API_BASE}/cameras/discovery/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }));
  },
  async login(username: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ username, password }),
    });
    if (res.status === 401) throw new Error('Tài khoản hoặc mật khẩu không đúng.');
    const data = await handle<{ csrf: string; user: SessionUser }>(res);
    csrf = data.csrf; return data;
  },

  async listCameras() {
    const res = await fetch(`${API_BASE}/cameras`, { headers: authHeaders() });
    return handle<Camera[]>(res);
  },

  async getCamera(id: number) {
    const res = await fetch(`${API_BASE}/cameras/${id}`, { headers: authHeaders() });
    return handle<Camera>(res);
  },

  async createCamera(data: Partial<Camera>) {
    const res = await fetch(`${API_BASE}/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    });
    return handle<Camera>(res);
  },

  async updateCamera(id: number, data: Partial<Camera>) {
    const res = await fetch(`${API_BASE}/cameras/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    });
    return handle<Camera>(res);
  },

  async probeOnvif(data: { url: string; username: string; password: string }) {
    const res = await fetch(`${API_BASE}/cameras/onvif/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(data),
    });
    return handle<OnvifProbeResult>(res);
  },

  async deleteCamera(id: number) {
    const res = await fetch(`${API_BASE}/cameras/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return handle<void>(res);
  },

  async recordingDays(cameraId: number) {
    const res = await fetch(`${API_BASE}/recordings/${cameraId}/days`, {
      headers: authHeaders(),
    });
    return handle<string[]>(res);
  },

  async recordingDay(cameraId: number, day: string) {
    const res = await fetch(`${API_BASE}/recordings/${cameraId}/${day}`, {
      headers: authHeaders(),
    });
    return handle<RecordingDay>(res);
  },

  async storageStatus() {
    const res = await fetch(`${API_BASE}/recordings/storage`, { headers: authHeaders() });
    return handle<StorageStatus>(res);
  },

  recordingPlaylist(cameraId: number, day: string, from?: string) {
    const query = from ? `?from=${encodeURIComponent(from)}` : '';
    return `${API_BASE}/recordings/${cameraId}/${day}/playlist${query}`;
  },

  async prepareBrowserPlayback(cameraId: number, day: string, from?: string) {
    const res = await fetch(`${API_BASE}/recordings/${cameraId}/${day}/browser-playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(from ? { from } : {}),
    });
    return handle<BrowserPlaybackState>(res);
  },

  /** Quét lại IP (nếu camera đổi IP) và khởi động lại luồng ngay. */
  async reconnectCamera(id: number) {
    const res = await fetch(`${API_BASE}/cameras/${id}/reconnect`, {
      method: 'POST',
      headers: authHeaders(),
    });
    return handle<{ ok: boolean; moved: { from: string; to: string } | null }>(res);
  },

  async ptzInfo(cameraId: number) {
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/ptz`, { headers: authHeaders() });
    return handle<PtzInfo>(res);
  },

  /** keepalive: vẫn gửi được lệnh dừng khi người dùng đóng tab/chuyển trang. */
  async ptzCommand(cameraId: number, command: 'move' | 'stop' | 'home', body?: { x: number; y: number; zoom: number }) {
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/ptz/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body ?? {}),
      keepalive: true,
    });
    return handle<{ ok: boolean }>(res);
  },

  async ptzSavePreset(cameraId: number, name: string) {
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/ptz/presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    return handle<PtzInfo>(res);
  },

  async ptzGotoPreset(cameraId: number, token: string) {
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/ptz/presets/${encodeURIComponent(token)}/goto`, {
      method: 'POST',
      headers: authHeaders(),
    });
    return handle<{ ok: boolean }>(res);
  },

  async ptzDeletePreset(cameraId: number, token: string) {
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/ptz/presets/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    return handle<PtzInfo>(res);
  },

  async listEvents(filters: { cameraId?: number; from?: string; to?: string; label?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    const res = await fetch(`${API_BASE}/events?${query.toString()}`, { headers: authHeaders() });
    return handle<DetectionEvent[]>(res);
  },

  async getSettings() {
    return handle<SettingsInfo>(await fetch(`${API_BASE}/settings`, { headers: authHeaders() }));
  },

  async saveSettings(settings: ServerSettings) {
    return handle<{ settings: ServerSettings }>(await fetch(`${API_BASE}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(settings),
    }));
  },
};
