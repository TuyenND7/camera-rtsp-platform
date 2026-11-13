import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { connectNativeDevice, type NativeDeviceState } from './nativeDevice';

function stored(key: string, fallback: number) {
  try { const value = localStorage.getItem(key); const number = Number(value); return value !== null && Number.isFinite(number) && number >= 1 && number <= 100 ? number : fallback; } catch { return fallback; }
}
const DeviceContext = createContext<{
  native: NativeDeviceState | null; volume: number; brightness: number; playbackVolume: number; sleeping: boolean;
  setVolume: (value: number) => Promise<void>; setBrightness: (value: number) => Promise<void>; resetBrightness: () => Promise<void>;
  sleep: () => Promise<void>; wake: () => Promise<void>; refresh: () => void; error: string;
}>({ native: null, volume: 100, brightness: 100, playbackVolume: 1, sleeping: false, setVolume: async () => {}, setBrightness: async () => {}, resetBrightness: async () => {}, sleep: async () => {}, wake: async () => {}, refresh: () => {}, error: '' });

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [native, setNative] = useState<NativeDeviceState | null>(null), [error, setError] = useState('');
  const [volume, setVolume] = useState(() => {
    try { const value = localStorage.getItem('camera-station.playback-volume'); return value === '0' ? 0 : stored('camera-station.playback-volume', 100); } catch { return 100; }
  });
  const [brightness, setBrightness] = useState(() => stored('camera-station.content-brightness', 100));
  const [sleeping, setSleeping] = useState(false), [host, setHost] = useState<Element>(() => document.body);
  const client = useRef<ReturnType<typeof connectNativeDevice>>(null), curtain = useRef<HTMLDivElement>(null);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  useEffect(() => {
    client.current = connectNativeDevice(state => setNative(current => JSON.stringify(current) === JSON.stringify(state) ? current : state));
    void client.current?.command('get').catch(() => undefined);
    const refresh = () => { if (!document.hidden) void client.current?.command('get').catch(() => undefined); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { client.current?.dispose(); client.current = null; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    const update = () => setHost(document.fullscreenElement ?? document.body);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => { if (sleeping && !native) { const previous = document.activeElement; curtain.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; } }, [sleeping, native, host]);
  const command = useCallback(async (action: 'volume' | 'brightness' | 'sleep' | 'wake', value?: number) => {
    setError('');
    try { await client.current?.command(action, value); }
    catch (error) { const message = error instanceof Error ? error.message : 'Chưa điều khiển được thiết bị.'; setError(message); throw new Error(message); }
  }, []);
  async function changeVolume(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 100) return;
    if (native?.volume_supported) await command('volume', value);
    else { setVolume(value); try { localStorage.setItem('camera-station.playback-volume', String(value)); } catch {} }
  }
  async function changeBrightness(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) return;
    if (native) await command('brightness', value);
    else { setBrightness(Math.max(10, value)); try { localStorage.setItem('camera-station.content-brightness', String(Math.max(10, value))); } catch {} }
  }
  async function resetBrightness() { if (native) await command('brightness', -1); else await changeBrightness(100); }
  async function sleep() {
    window.dispatchEvent(new Event('camera-station:stop-talk'));
    if (native) await command('sleep'); else { lastTap.current.at = 0; setSleeping(true); }
  }
  async function wake() { if (native) await command('wake'); else setSleeping(false); }
  return <DeviceContext.Provider value={{ native, volume: native?.volume_supported ? native.volume_percent : volume,
    brightness: native ? native.brightness_percent < 0 ? native.system_brightness_percent : native.brightness_percent : brightness,
    playbackVolume: native?.volume_supported ? 1 : volume / 100, sleeping: native?.sleeping ?? sleeping,
    setVolume: changeVolume, setBrightness: changeBrightness, resetBrightness, sleep, wake, refresh: () => { void client.current?.command('get').catch(() => undefined); }, error }}>
    {children}
    {!native && createPortal(<>
      {brightness < 100 && <div className="device-dimmer" aria-hidden="true" style={{ opacity: (100 - brightness) / 100 }} />}
      {sleeping && <div ref={curtain} className="device-screen-curtain" role="button" tabIndex={0} aria-label="Màn hình tối. Chạm đúp để mở lại" onPointerUp={event => {
        const now = performance.now(), last = lastTap.current;
        if (last.at > 0 && now - last.at < 400 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 50) void wake();
        else lastTap.current = { at: now, x: event.clientX, y: event.clientY };
      }} onDoubleClick={() => void wake()} onKeyDown={event => { if (['Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); void wake(); } }}><span>Chạm đúp để mở màn hình</span></div>}
    </>, host)}
  </DeviceContext.Provider>;
}
export const useDevice = () => useContext(DeviceContext);
