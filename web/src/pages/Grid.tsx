import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, Camera } from '../api';
import HlsPlayer, { HlsPlayerHandle } from '../HlsPlayer';
import Icon from '../Icon';
import PtzPanel from '../PtzPanel';
import LiveDevicePicker from '../LiveDevicePicker';
import SnapshotDialog, { LiveSnapshot } from '../SnapshotDialog';
import DeviceControlPanel from '../DeviceControlPanel';
import CameraSettingsDialog from '../CameraSettingsDialog';
import CameraFlashButton from '../CameraFlashButton';
import CameraAudioDialog from '../CameraAudioDialog';
import { cameraAudioChanged, getCameraAudio, setCameraAudio, type CameraAudio } from '../cameraAudio';
import useCameraTalk from '../useCameraTalk';
import EmergencyControls from '../EmergencyControls';
import LiveLayoutPicker, { LayoutSize } from '../LiveLayoutPicker';
import LiveClock from '../LiveClock';
import { useDevice } from '../device';
import { PageHeader, statusLabels } from '../ui';

type LiveTalk = ReturnType<typeof useCameraTalk>;

export default function Grid() {
  const device = useDevice();
  const [searchParams] = useSearchParams();
  const focusedCameraId = Number(searchParams.get('camera'));
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [slots, setSlots] = useState<Array<number | null>>([]);
  const [layout, setLayout] = useState<LayoutSize>(focusedCameraId > 0 ? 1 : 4);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsCameraId, setSettingsCameraId] = useState<number | null>(null);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const livePage = useRef<HTMLElement>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false), [expandedView, setExpandedView] = useState(false);
  const fullscreen = nativeFullscreen || expandedView;
  useEffect(() => {
    const element = livePage.current;
    const update = () => setNativeFullscreen(document.fullscreenElement === element);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpandedView(false); };
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('keydown', escape);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [fullscreen]);

  async function toggleFullscreen() {
    if (document.fullscreenElement === livePage.current) await document.exitFullscreen().catch(() => undefined);
    else if (expandedView) setExpandedView(false);
    else {
      try {
        if (!livePage.current?.requestFullscreen) { setExpandedView(true); return; }
        await livePage.current.requestFullscreen({ navigationUI: 'hide' });
      } catch { setExpandedView(true); }
    }
  }

  useEffect(() => {
    api.listCameras().then((items) => {
      setCameras(items);
      const enabled = items.filter((camera) => camera.enabled);
      const focused = enabled.find((camera) => camera.id === focusedCameraId);
      const size = focused ? 1 : 4;
      const initial = focused ? [focused] : enabled.slice(0, size);
      setLayout(size);
      setSlots(Array.from({ length: size }, (_, index) => initial[index]?.id ?? null));
    }).catch((error) => setErr(error.message));
  }, [focusedCameraId]);

  // Cập nhật trạng thái online/offline mà không đổi lựa chọn camera của người dùng.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.listCameras().then((items) => { setCameras(items); setErr(''); }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const cameraById = useMemo(() => new Map(cameras.map(camera => [camera.id, camera])), [cameras]);
  const visible = useMemo(
    () => Array.from({ length: layout }, (_, index) => cameraById.get(slots[index] ?? -1) ?? null),
    [cameraById, layout, slots]
  );
  const selected = useMemo(() => new Set(visible.flatMap(camera => camera ? [camera.id] : [])), [visible]);
  const cameraTalk = useCameraTalk(cameras, selected, false);
  const talkActive = cameraTalk.phase !== 'idle';

  function changeLayout(size: LayoutSize) {
    setLayout(size);
    setSlots(current => Array.from({ length: size }, (_, index) => current[index] ?? null));
    setPickerOpen(false);
  }

  function closeSlot(index: number) {
    setSlots(current => current.map((id, slot) => slot === index ? null : id));
  }

  function openPicker(index?: number) {
    const firstEmpty = visible.findIndex(camera => !camera);
    setPickerSlot(index ?? (firstEmpty >= 0 ? firstEmpty : null));
    setPickerOpen(true);
  }

  function chooseCamera(id: number, index: number) {
    if (!cameraById.has(id) || index < 0 || index >= layout) return;
    setSlots(current => {
      if (current.includes(id)) return current;
      return Array.from({ length: layout }, (_, slot) => slot === index ? id : current[slot] ?? null);
    });
    setPickerOpen(false);
  }
  return (
    <section ref={livePage} className={`mi-live-page${fullscreen ? ' is-fullscreen' : ''}`}>
      <PageHeader title="Live view" className="mi-live-heading" titleActions={<div className="mi-live-selectors">
          <button type="button" className="mi-camera-picker-button" onClick={() => openPicker()} aria-label={`Chọn camera Live view, đang chọn ${selected.size} camera`}><Icon name="video" size={18} />{selected.size}<Icon name="chevronDown" size={15} /></button>
          <LiveLayoutPicker value={layout} onChange={changeLayout} />
          <button type="button" className="mi-live-fullscreen-button" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} aria-label={fullscreen ? 'Thu nhỏ Live view' : 'Toàn màn hình Live view'} title={fullscreen ? 'Thu nhỏ Live view' : 'Toàn màn hình Live view'}><Icon name={fullscreen ? 'minimize' : 'maximize'} size={20} /></button>
          <button type="button" className="mi-live-screen-button" onClick={() => void device.sleep().catch(() => undefined)} aria-label="Tắt hiển thị, chạm đúp để mở" title="Tắt hiển thị, chạm đúp để mở"><Icon name="moon" size={19} /></button>
        </div>} center={<LiveClock />} actions={<div className="mi-live-actions">
          <EmergencyControls cameras={cameras} talk={cameraTalk} compact />
        </div>} />

      {err && <div className="notice error">Không tải được camera: {err}</div>}
      {!err && layout === 1 && visible[0] && <FocusView cameraTalk={cameraTalk} talkActive={talkActive} camera={visible[0]} cameras={cameras.filter(camera => camera.enabled)} onChoose={id => chooseCamera(id, 0)} onClose={() => closeSlot(0)} onSettings={() => { cameraTalk.stop(); setSettingsCameraId(visible[0]!.id); }} />}
      {!err && (layout !== 1 || !visible[0]) && <>
        <div className={`mi-camera-grid layout-${layout}`}>
          {visible.map((camera, index) => camera
            ? <CameraTile key={`slot-${index}`} cameraTalk={cameraTalk} talkActive={talkActive} camera={camera} onClose={() => closeSlot(index)} onSettings={() => { cameraTalk.stop(); setSettingsCameraId(camera.id); }} />
            : <button key={`slot-${index}`} type="button" className="empty-camera-tile" onClick={() => openPicker(index)} aria-label={`Chọn camera cho ô ${index + 1}`}><Icon name="plus" size={26} /><span>Chọn camera</span><small>Thêm vào ô {index + 1}</small></button>)}
        </div>
      </>}
      {settingsCameraId !== null && cameraById.has(settingsCameraId) && <CameraSettingsDialog key={settingsCameraId} camera={cameraById.get(settingsCameraId)!} onClose={() => setSettingsCameraId(null)} />}
      {pickerOpen && <LiveDevicePicker cameras={cameras} selected={selected} slot={pickerSlot} onChoose={id => { if (pickerSlot !== null) chooseCamera(id, pickerSlot); }} onClose={() => setPickerOpen(false)} />}
    </section>
  );
}

function FocusView({ camera, cameras, onChoose, onClose, talkActive, onSettings, cameraTalk }: { cameraTalk: LiveTalk; talkActive: boolean; camera: Camera; cameras: Camera[]; onChoose: (id: number) => void; onClose: () => void; onSettings: () => void }) {
  return (
    <>
      <section className="mi-live-focus">
        <article className="mi-featured-camera">
          <LiveVideo cameraTalk={cameraTalk} talkActive={talkActive} camera={camera} className="mi-featured-video" offlineLabel={statusLabels[camera.status] ?? 'Camera chưa online'} onClose={onClose} onSettings={onSettings}>
            <div className="mi-featured-title"><i className={`status-dot ${camera.status}`} /><div><strong title={camera.name}>{camera.name}</strong>{camera.status !== 'online' && <small>{statusLabels[camera.status] ?? camera.status}</small>}</div></div>
          </LiveVideo>
        </article>
        <aside className="mi-device-panel">
          <PtzPanel key={camera.id} cameraId={camera.id} />
          <div className="mi-device-quick-actions"><Link className="button" to={`/playback/${camera.id}`}><Icon name="clock" size={17} />Xem lại</Link><button type="button" onClick={onSettings}><Icon name="settings" size={17} />Cài đặt</button></div>
          <details className="live-device-details"><summary>Thông tin thiết bị<Icon name="chevronDown" size={14} /></summary><dl><div><dt>Địa chỉ</dt><dd>{cameraHost(camera.rtsp_url)}</dd></div><div><dt>Video</dt><dd>{camera.codec.toUpperCase()}</dd></div><div><dt>Ghi hình</dt><dd>{camera.record ? 'Bật' : 'Tắt'}</dd></div></dl></details>
        </aside>
      </section>
      {cameras.length > 1 && <section className="mi-camera-carousel" aria-label="Chuyển camera">
        <div className="mi-carousel-items">{cameras.map((item) => <button key={item.id} type="button" className={item.id === camera.id ? 'active' : ''} onClick={() => onChoose(item.id)}><Icon name="camera" size={18} /><span>{item.name}</span><i className={`status-dot ${item.status}`} />{item.status !== 'online' && <small>{statusLabels[item.status] ?? item.status}</small>}</button>)}</div>
      </section>}
    </>
  );
}

function cameraHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'Camera RTSP'; }
}

function CameraTile({ camera, onClose, talkActive, onSettings, cameraTalk }: { cameraTalk: LiveTalk; talkActive: boolean; camera: Camera; onClose: () => void; onSettings: () => void }) {
  return (
    <article className="mi-camera-card">
      <LiveVideo cameraTalk={cameraTalk} talkActive={talkActive} camera={camera} className="mi-camera-video" offlineLabel={statusLabels[camera.status] ?? 'Camera chưa online'} onClose={onClose} onSettings={onSettings} actions={<><Link className="mi-camera-control" to={`/live?camera=${camera.id}`} title="Chỉ xem camera này" aria-label={`Chỉ xem ${camera.name}`}><Icon name="monitor" size={20} /></Link><Link className="mi-camera-control" to={`/playback/${camera.id}`} title="Xem Playback" aria-label={`Xem lại ${camera.name}`}><Icon name="clock" size={20} /></Link></>}>
        <div className="mi-camera-overlay">
          <div><i className={`status-dot ${camera.status}`} /><strong title={camera.name}>{camera.name}</strong>{camera.status !== 'online' && <small>{statusLabels[camera.status] ?? camera.status}</small>}</div>
        </div>
      </LiveVideo>
    </article>
  );
}

/**
 * Tự tải lại player khi camera chuyển sang online sau khi mất kết nối.
 * Nút kết nối lại chỉ hiện khi camera offline để tìm lại IP nếu DHCP đã đổi.
 */
function LiveVideo({ camera, className, offlineLabel, children, actions, onClose, talkActive, onSettings, cameraTalk }: { cameraTalk: LiveTalk; talkActive: boolean; camera: Camera; className: string; offlineLabel: string; children: React.ReactNode; actions?: React.ReactNode; onClose: () => void; onSettings: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const player = useRef<HlsPlayerHandle>(null);
  const previousStatus = useRef(camera.status);
  const [reconnecting, setReconnecting] = useState(false);
  const [notice, setNotice] = useState('');
  const [controlsVisible, setControlsVisible] = useState(false);
  const [muted, setMuted] = useState(true);
  const [hasAudio, setHasAudio] = useState<boolean | null>(null);
  const [audio, setAudio] = useState(() => getCameraAudio(camera.id)), [audioOpen, setAudioOpen] = useState(false);
  const offline = camera.status !== 'online';
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const ownTalk = cameraTalk.cameraIds.includes(camera.id) && cameraTalk.phase !== 'idle';
  const micLabel = ownTalk ? `${cameraTalk.phase === 'preparing' ? 'Hủy kết nối mic' : 'Kết thúc đàm thoại'}${cameraTalk.broadcast ? ' nhóm ·' : ''} ${camera.name}` : `Nói với ${camera.name}`;

  useEffect(() => { if (cameraTalk.cameraId === camera.id && cameraTalk.message) setNotice(cameraTalk.message); }, [cameraTalk.cameraId, cameraTalk.message, camera.id]);

  useEffect(() => { setControlsVisible(false); setNotice(''); setMuted(true); setHasAudio(null); setAudioOpen(false); setAudio(getCameraAudio(camera.id)); }, [camera.id]);
  useEffect(() => {
    const update = () => setAudio(getCameraAudio(camera.id));
    window.addEventListener(cameraAudioChanged, update); window.addEventListener('storage', update);
    return () => { window.removeEventListener(cameraAudioChanged, update); window.removeEventListener('storage', update); };
  }, [camera.id]);
  function changeAudio(patch: Partial<CameraAudio>) {
    setAudio(setCameraAudio(camera.id, patch));
    if (patch.listen !== undefined) setMuted(patch.listen === 0);
  }

  useEffect(() => {
    if (!controlsVisible) return;
    const timer = window.setTimeout(() => {
      if (!controls.current?.contains(document.activeElement)) setControlsVisible(false);
    }, 5000);
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setControlsVisible(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setControlsVisible(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [controlsVisible]);

  useEffect(() => {
    if (camera.status === 'online' && previousStatus.current !== 'online') {
      player.current?.reload();
      setNotice('');
    }
    previousStatus.current = camera.status;
  }, [camera.status]);

  useEffect(() => {
    if (!notice || offline) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice, offline]);

  async function reload() {
    player.current?.reload();
    if (!offline) {
      setNotice('Đã tải lại luồng live');
      return;
    }
    setReconnecting(true);
    setNotice('');
    try {
      const result = await api.reconnectCamera(camera.id);
      setNotice(result.moved ? `Camera đổi IP ${result.moved.from} → ${result.moved.to}, đang kết nối lại…` : 'Đang kết nối lại camera…');
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setReconnecting(false);
    }
  }

  async function capture() {
    if (!player.current || capturing) return;
    setCapturing(true);
    try { const blob = await player.current.snapshot(); setSnapshot({ blob, cameraId: camera.id, name: camera.name, capturedAt: new Date() }); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Chưa chụp được ảnh.'); }
    finally { setCapturing(false); }
  }

  return (
    <div ref={container} className={`${className}${controlsVisible ? ' controls-visible' : ''}`} tabIndex={0} role="group" aria-label={`${camera.name}, nhấn Enter để hiện hoặc ẩn điều khiển`} onClick={event => {
      if (!(event.target as Element).closest('button, a, input, label, dialog')) setControlsVisible(value => !value);
    }} onKeyDown={event => {
      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setControlsVisible(value => !value); }
    }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setControlsVisible(false); }}>
      {!offline && <HlsPlayer ref={player} src={`/live/${camera.id}/index.m3u8`} live controls={false} volume={audio.listen / 100} muted={muted || audio.listen === 0 || talkActive} onAudioAvailable={setHasAudio} />}
      {offline && (
        <div className="mi-stream-state">
          <strong className="mi-stream-label"><i className={`status-dot ${camera.status}`} />{offlineLabel}</strong>
          {notice && <p className="mi-stream-message" role="status">{notice}</p>}
          <button type="button" onClick={() => void reload()} disabled={reconnecting}>{reconnecting ? 'Đang tìm camera…' : 'Kết nối lại'}</button>
        </div>
      )}
      {notice && !offline && <div className="mi-live-notice" role="status">{notice}</div>}
      {children}
      <button type="button" className={`mi-camera-talk${ownTalk ? ' active' : ''}`} disabled={offline || cameraTalk.blocked || (talkActive && !ownTalk)} onClick={() => cameraTalk.toggle(camera)} aria-pressed={ownTalk} aria-label={micLabel} title={ownTalk ? `${micLabel} · tự dừng khi im lặng 5 giây` : `${micLabel} · nhấn lại để kết thúc`}>
        <Icon name="microphone" size={21} />
        {ownTalk && <span className="mi-camera-talk-level" aria-hidden="true"><span style={{ width: `${cameraTalk.level * 100}%` }} /></span>}
      </button>
      <button type="button" className={`mi-camera-control mi-camera-audio${!muted && audio.listen > 0 ? ' active' : ''}`} disabled={offline || hasAudio === false || talkActive} onClick={() => { if (muted && audio.listen === 0) changeAudio({ listen: 100 }); else setMuted(value => !value); }} aria-pressed={!muted && audio.listen > 0} aria-label={`${muted || audio.listen === 0 ? 'Bật' : 'Tắt'} âm thanh ${camera.name}`} title={offline ? 'Camera chưa trực tuyến' : hasAudio === false ? 'Luồng camera không có âm thanh' : `${muted ? 'Bật' : 'Tắt'} âm thanh`} data-audio-state={muted || audio.listen === 0 ? 'muted' : 'audible'}><Icon name={muted || audio.listen === 0 ? 'volumeMuted' : 'volume'} size={20} /></button>
      <button type="button" className="mi-camera-audio-settings" onClick={() => setAudioOpen(true)} aria-label={`Âm lượng ${camera.name}`} title="Âm lượng nghe và giọng nói"><Icon name="chevronDown" size={16} /></button>
      <div ref={controls} className="mi-camera-controls" hidden={!controlsVisible}>{actions}<button type="button" className="mi-camera-control" onClick={onSettings} aria-label={`Cài đặt ${camera.name}`} title="Cài đặt camera"><Icon name="settings" size={20} /></button><CameraFlashButton cameraId={camera.id} name={camera.name} online={!offline} visible={controlsVisible} onNotice={setNotice} /><button type="button" className="mi-camera-control" disabled={offline} onClick={() => setControlsOpen(true)} aria-label={`Điều khiển còi và đèn ${camera.name}`} title="Còi và đèn camera"><Icon name="bell" size={20} /></button><button type="button" className="mi-camera-control" disabled={offline || capturing} onClick={() => void capture()} aria-label={`Chụp ảnh ${camera.name}`} title="Chụp khung hình đang xem"><Icon name="camera" size={20} /></button><button type="button" className="mi-camera-control mi-camera-close" onClick={onClose} aria-label={`Bỏ ${camera.name} khỏi Live view`} title="Bỏ camera khỏi ô này"><Icon name="close" size={20} /></button></div>
      {snapshot && <SnapshotDialog snapshot={snapshot} onClose={() => setSnapshot(null)} />}
      {controlsOpen && <DeviceControlPanel cameras={[camera]} onClose={() => setControlsOpen(false)} />}
      {audioOpen && <CameraAudioDialog name={camera.name} value={audio} onChange={changeAudio} onClose={() => setAudioOpen(false)} />}
    </div>
  );
}
