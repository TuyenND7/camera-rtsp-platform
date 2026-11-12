import { useEffect, useRef, useState } from 'react';
import { api, Camera, TalkCapability } from './api';
import Icon from './Icon';
import { Microphone } from './microphone';

type Run = { microphone: Microphone; controller: AbortController; queue: ArrayBuffer[]; cameraIds: number[]; sending: boolean; sequence: number; id?: string; timer?: number; test: boolean };

export default function TalkPanel({ cameras, initial, onClose, onActive }: { cameras: Camera[]; initial: number[]; onClose: () => void; onActive: (active: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), run = useRef<Run | null>(null);
  const [capabilities, setCapabilities] = useState<Record<number, TalkCapability>>({});
  const [selected, setSelected] = useState<number[]>(initial);
  const [checking, setChecking] = useState(true), [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'talking' | 'testing'>('idle');
  const [level, setLevel] = useState(0), [micReady, setMicReady] = useState(false);
  const capabilityKey = cameras.map(c => `${c.id}:${c.enabled}:${c.status}:${c.rtsp_url}`).join('|');
  const initialKey = initial.join(',');
  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const eligible = cameras.filter(c => c.enabled && c.status === 'online' && capabilities[c.id]?.supported);
  const chosen = eligible.filter(c => selected.includes(c.id));

  function stop() {
    const current = run.current; run.current = null;
    if (current) {
      current.microphone.stop(); current.controller.abort(); current.queue.length = 0;
      if (current.timer) window.clearTimeout(current.timer);
      if (current.id) void api.stopTalk(current.id).catch(() => undefined);
    }
    onActive(false); setPhase('idle'); setLevel(0);
  }

  useEffect(() => {
    const element = dialog.current; element?.showModal();
    const leave = () => stop();
    const visibility = () => { if (document.hidden) stop(); };
    window.addEventListener('blur', leave); window.addEventListener('pagehide', leave);
    window.addEventListener('camera-station:stop-talk', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop(); element?.close();
      window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave);
      window.removeEventListener('camera-station:stop-talk', leave);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setChecking(true); setCapabilities({});
    async function probe() {
      try {
        const result: Record<number, TalkCapability> = {};
        for (let start = 0; start < cameras.length; start += 16) {
          const batch = cameras.slice(start, start + 16);
          if (!batch.length || cancelled) break;
          const items = await api.talkCapabilities(batch.map(c => c.id));
          items.forEach(item => { result[item.camera_id] = item; });
          if (!cancelled) setCapabilities({ ...result });
        }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'Không kiểm tra được camera.'); }
      finally { if (!cancelled) setChecking(false); }
    }
    void probe(); return () => { cancelled = true; };
  }, [capabilityKey]);

  useEffect(() => { if (!run.current) setSelected(initial); }, [initialKey]);

  useEffect(() => {
    const current = run.current;
    if (current?.id && current.cameraIds.some(id => !cameras.some(c => c.id === id && c.enabled && c.status === 'online'))) { stop(); setError('Camera đã mất kết nối. Cuộc đàm thoại đã dừng.'); }
  }, [cameras]);

  async function send(current: Run) {
    if (current.sending || !current.id) return;
    current.sending = true;
    try {
      while (run.current === current && current.queue.length) {
        const pcm = current.queue.shift()!;
        await api.talkAudio(current.id, current.sequence++, pcm, current.controller.signal);
        if (run.current === current) setPhase('talking');
      }
    } catch (e) {
      if (run.current === current) { stop(); setError(e instanceof Error ? e.message : 'Đường truyền audio bị gián đoạn.'); }
    } finally { current.sending = false; }
  }

  async function start(test = false) {
    if (run.current || !secure || (!test && (!chosen.length || checking))) return;
    setError(''); setPhase(test ? 'testing' : 'preparing');
    const current: Run = { microphone: new Microphone(), controller: new AbortController(), queue: [], cameraIds: chosen.map(c => c.id), sequence: 0, sending: false, test };
    run.current = current;
    try {
      await current.microphone.start(pcm => {
        if (run.current !== current) return;
        const samples = new Int16Array(pcm);
        let peak = 0; for (const sample of samples) peak = Math.max(peak, Math.abs(sample) / 32768);
        setLevel(Math.min(1, peak * 2));
        if (test || !current.id) return;
        if (current.queue.length >= 2) { stop(); setError('Đường truyền chậm. Hãy nhấn giữ để nói lại.'); return; }
        current.queue.push(pcm); void send(current);
      });
      if (run.current !== current) { current.microphone.stop(); return; }
      setMicReady(true);
      if (test) { current.timer = window.setTimeout(stop, 3000); return; }
      const session = await api.startTalk(current.cameraIds);
      if (run.current !== current) { void api.stopTalk(session.id).catch(() => undefined); return; }
      current.id = session.id; onActive(true);
      current.timer = window.setTimeout(() => { stop(); setError('Đã dừng sau 60 giây. Nhấn giữ để tiếp tục nói.'); }, session.max_seconds * 1000);
    } catch (e) {
      current.microphone.stop();
      if (run.current !== current) return;
      stop();
      const message = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Chưa được cấp quyền mic. Cho phép mic trong trình duyệt hoặc cài đặt ứng dụng, rồi nhấn giữ lại.'
        : e instanceof DOMException && e.name === 'NotReadableError' ? 'Không mở được mic. Kiểm tra quyền âm thanh của ứng dụng hoặc mic đang được ứng dụng khác sử dụng, rồi thử lại.'
        : e instanceof DOMException && e.name === 'NotFoundError' ? 'Không tìm thấy mic trên thiết bị này.' : e instanceof Error ? e.message : 'Không mở được mic.';
      setError(message);
    }
  }

  return <dialog ref={dialog} className="device-dialog talk-dialog" aria-labelledby="talk-title" onCancel={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const r = event.currentTarget.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
  }}>
    <header className="dialog-heading"><div><h2 id="talk-title"><Icon name="microphone" size={23} />Đàm thoại</h2><p>Chọn camera nhận giọng nói của bạn</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng đàm thoại"><Icon name="close" size={20} /></button></header>
    {!secure && <div className="notice error" role="alert">Mở địa chỉ HTTPS của máy chủ để sử dụng mic trên điện thoại, tablet hoặc máy tính.</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="talk-camera-list">
      {cameras.map(camera => { const capability = capabilities[camera.id], available = eligible.some(c => c.id === camera.id); return <label className={`talk-camera-row${available ? '' : ' unavailable'}`} key={camera.id}>
        <input type="checkbox" checked={available && selected.includes(camera.id)} disabled={!available || phase !== 'idle' || (!selected.includes(camera.id) && chosen.length >= 16)} onChange={event => setSelected(ids => event.target.checked ? [...ids, camera.id] : ids.filter(id => id !== camera.id))} />
        <Icon name="camera" size={22} /><span><strong>{camera.name}</strong><small>{capability?.reason ?? (checking ? 'Đang kiểm tra kênh đàm thoại…' : 'Chưa kiểm tra được camera')}</small></span>
        {available && <span className="talk-ready">Sẵn sàng</span>}
      </label>; })}
      {!cameras.length && <p className="muted">Thêm camera trong trang Thiết bị để đàm thoại.</p>}
    </div>
    <div className="talk-mic-check"><span>{phase === 'testing' ? 'Đang kiểm tra mic trên thiết bị này…' : micReady ? 'Mic đã được cấp quyền' : 'Mic trên thiết bị này'}</span><button type="button" onClick={() => phase === 'testing' ? stop() : void start(true)} disabled={!secure || (phase !== 'idle' && phase !== 'testing')}>{phase === 'testing' ? 'Dừng kiểm tra' : 'Kiểm tra mic'}</button></div>
    <div className="talk-level" role="meter" aria-label="Mức âm thanh mic" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><span style={{ width: `${level * 100}%` }} /></div>
    <footer className="talk-footer">
      <span aria-live="polite">{phase === 'talking' ? `Đang gửi giọng nói tới ${chosen.length} camera` : phase === 'preparing' ? 'Đang mở mic và kết nối camera…' : checking ? 'Đang kiểm tra camera…' : chosen.length ? `${chosen.length} camera đã chọn · nhả tay để dừng` : 'Chưa có camera sẵn sàng nhận giọng nói'}</span>
      <button type="button" className={`talk-hold-button${phase === 'talking' ? ' active' : ''}`} disabled={!secure || !chosen.length || checking || phase === 'testing'}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void start(); }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
        onKeyDown={event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) void start(); } }} onKeyUp={event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stop(); } }} onBlur={stop} aria-label="Nhấn giữ để nói" aria-pressed={phase === 'talking'}>
        <Icon name="microphone" size={23} />{phase === 'talking' ? 'Đang nói · nhả để dừng' : phase === 'preparing' ? 'Đang kết nối…' : 'Nhấn giữ để nói'}
      </button>
    </footer>
  </dialog>;
}
