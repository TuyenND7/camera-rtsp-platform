import { useEffect, useRef, useState } from 'react';
import type { Camera, DeviceControls, TalkCapability } from './api';
import Icon from './Icon';
import { statusLabels } from './ui';

export default function EmergencyCameraPicker({ cameras, selection, states, capabilities, locked, onApply, onClose }: {
  cameras: Camera[]; selection: number[] | null; states: Record<number, DeviceControls>; capabilities: Record<number, TalkCapability>;
  locked: boolean; onApply: (ids: number[] | null) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), all = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number[] | null>(selection === null ? null : [...selection]);
  const ids = cameras.filter(camera => draft === null || draft.includes(camera.id)).map(camera => camera.id);
  const allSelected = cameras.length > 0 && ids.length === cameras.length;
  useEffect(() => { if (all.current) all.current.indeterminate = ids.length > 0 && !allSelected; }, [ids.length, allSelected]);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="device-dialog emergency-camera-dialog" aria-labelledby="emergency-camera-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }} onKeyUp={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="dialog-heading"><div><h2 id="emergency-camera-title">Chọn camera khẩn cấp</h2><p>Chọn nơi nhận báo động và giọng nói của bạn</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng chọn camera khẩn cấp"><Icon name="close" /></button></header>
    <label className="emergency-camera-all"><strong>Tất cả camera</strong><input ref={all} type="checkbox" checked={allSelected} onChange={event => setDraft(event.target.checked ? null : [])} /></label>
    <div className="emergency-camera-list">{cameras.map(camera => {
      const online = camera.enabled && camera.status === 'online';
      const ready = [states[camera.id]?.alarm_supported ? 'Còi' : '', capabilities[camera.id]?.supported ? 'Mic' : ''].filter(Boolean).join(' · ');
      return <label key={camera.id} className="emergency-camera-row" data-camera-id={camera.id}><Icon name="camera" size={22} /><span><strong>{camera.name}</strong><small>{!camera.enabled ? 'Thiết bị đã tắt' : !online ? `${statusLabels[camera.status] ?? 'Chưa trực tuyến'} · vẫn chọn được, sẽ bỏ qua khi gửi` : ready ? `${ready} sẵn sàng` : 'Chưa có chức năng khẩn cấp sẵn sàng'}</small></span><i className={`status-dot ${camera.status}`} /><input type="checkbox" checked={ids.includes(camera.id)} onChange={event => {
        const checked = event.target.checked;
        setDraft(current => {
          const before = cameras.filter(item => current === null || current.includes(item.id)).map(item => item.id);
          const next = checked ? [...before, camera.id] : before.filter(id => id !== camera.id);
          return next.length === cameras.length ? null : next;
        });
      }} /></label>;
    })}{!cameras.length && <p className="muted">Chưa có camera để chọn.</p>}</div>
    {locked && <p className="emergency-selection-note" role="status">Dừng báo động hoặc đàm thoại để đổi camera.</p>}
    <footer className="dialog-footer"><span>{ids.length} camera đã chọn</span><button type="button" onClick={onClose}>Hủy</button><button type="button" className="emergency-apply" disabled={!ids.length || locked} onClick={() => onApply(draft === null ? null : ids)}>Áp dụng</button></footer>
  </dialog>;
}
