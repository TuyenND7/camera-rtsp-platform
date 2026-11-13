import { useEffect, useRef } from 'react';
import type { Camera } from './api';
import { alarmDurationLabel } from './alarm';
import Icon from './Icon';

export default function AlarmConfirmDialog({ cameras, seconds, skipped = [], onConfirm, onClose }: {
  cameras: Pick<Camera, 'id' | 'name'>[]; seconds: number; skipped?: string[]; onConfirm: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), submitted = useRef(false);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal(); cancel.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="device-dialog alarm-confirm-dialog" aria-labelledby="alarm-confirm-title" aria-describedby="alarm-confirm-description" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }} onKeyUp={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="dialog-heading"><div><h2 id="alarm-confirm-title"><Icon name="bell" size={23} />Bật còi báo động?</h2><p id="alarm-confirm-description">Còi sẽ phát âm thanh lớn tại {cameras.length} camera dưới đây.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng xác nhận báo động"><Icon name="close" /></button></header>
    <div className="alarm-confirm-body"><ul>{cameras.map(camera => <li key={camera.id}>{camera.name}</li>)}</ul><p><strong>Thời lượng: {alarmDurationLabel(seconds)}</strong></p><p>{seconds === 0 ? 'Còi không có hẹn giờ tự tắt. Nhấn Dừng còi để kết thúc.' : `Còi sẽ tự dừng sau ${seconds} giây. Bạn có thể nhấn Dừng còi sớm hơn.`}</p>{!!skipped.length && <p className="muted">Chưa sẵn sàng, không nhận lệnh: {skipped.join(', ')}.</p>}</div>
    <footer className="dialog-footer"><button ref={cancel} type="button" onClick={onClose}>Hủy</button><button type="button" className="alarm-confirm-start" onClick={() => { if (submitted.current) return; submitted.current = true; onConfirm(); }}>Bật báo động</button></footer>
  </dialog>;
}
