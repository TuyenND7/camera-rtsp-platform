export interface NativeDeviceState {
  version: 1; volume_percent: number; volume_supported: boolean;
  brightness_percent: number; system_brightness_percent: number; sleeping: boolean;
}
type Action = 'get' | 'volume' | 'brightness' | 'sleep' | 'wake';
type Bridge = { postMessage: (message: string) => void; onmessage?: (event: { data: string }) => void };
declare global { interface Window { CameraStationDevice?: Bridge } }

function valid(value: unknown): value is NativeDeviceState {
  const state = value as NativeDeviceState;
  const percent = (number: unknown, min = 0) => typeof number === 'number' && Number.isInteger(number) && number >= min && number <= 100;
  return !!state && state.version === 1 && percent(state.volume_percent) && typeof state.volume_supported === 'boolean'
    && (state.brightness_percent === -1 || percent(state.brightness_percent, 1)) && percent(state.system_brightness_percent, 1) && typeof state.sleeping === 'boolean';
}

export function connectNativeDevice(onState: (state: NativeDeviceState) => void) {
  const bridge = window.CameraStationDevice;
  if (!bridge?.postMessage) return null;
  let sequence = 0;
  const pending = new Map<string, { resolve: (state: NativeDeviceState) => void; reject: (error: Error) => void; timer: number }>();
  const previous = bridge.onmessage;
  bridge.onmessage = event => {
    try {
      const message = JSON.parse(event.data), request = pending.get(message.id);
      if (!request && message.event !== 'state') return;
      if (request) { pending.delete(message.id); clearTimeout(request.timer); }
      if ((request && message.ok !== true) || !valid(message.state)) { request?.reject(new Error('Chưa áp dụng được điều khiển thiết bị.')); return; }
      onState(message.state); request?.resolve(message.state);
    } catch { /* Ignore unrelated/malformed WebView messages. */ }
  };
  return {
    command(action: Action, value?: number): Promise<NativeDeviceState> {
      const id = `device-${Date.now()}-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => { pending.delete(id); reject(new Error('App chưa phản hồi. Thử mở lại trang Cài đặt.')); }, 2500);
        pending.set(id, { resolve, reject, timer });
        try { bridge.postMessage(JSON.stringify({ id, action, ...(value === undefined ? {} : { value }) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('Chưa kết nối được điều khiển thiết bị.')); }
      });
    },
    dispose() {
      bridge.onmessage = previous;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Trang đã đóng.')); }
      pending.clear();
    },
  };
}
