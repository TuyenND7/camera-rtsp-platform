import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Camera } from './api';
import Icon from './Icon';
import { cameraHost, EmptyState, StatusBadge } from './ui';

export default function LiveDevicePicker({ cameras, selected, slot, onChoose, onClose }: {
  cameras: Camera[];
  selected: Set<number>;
  slot: number | null;
  onChoose: (id: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const search = query.trim().toLocaleLowerCase();
  const filtered = cameras.filter(camera => `${camera.name} ${cameraHost(camera.rtsp_url)}`.toLocaleLowerCase().includes(search));

  return <dialog ref={dialog} className="device-dialog live-device-dialog" aria-labelledby="live-device-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="dialog-heading"><div><h2 id="live-device-title">Danh sách thiết bị</h2><p>{slot !== null ? `Chọn camera cho ô ${slot + 1}` : 'Bỏ một camera hoặc tăng số ô để chọn thêm'}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng danh sách thiết bị"><Icon name="close" size={20} /></button></header>
    <div className="live-device-search"><Icon name="search" size={18} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm tên hoặc IP camera" aria-label="Tìm camera" /></div>
    <div className="live-device-list">
      {filtered.map(camera => <div key={camera.id} className="live-device-row" data-camera-id={camera.id}><span className="live-device-icon"><Icon name="camera" size={23} /></span><div className="live-device-name"><strong>{camera.name}</strong><small>{cameraHost(camera.rtsp_url)}</small></div><StatusBadge status={camera.status} />{selected.has(camera.id)
        ? <span className="live-device-selected"><Icon name="check" size={16} />Đang xem</span>
        : <button type="button" className="button primary" disabled={slot === null} onClick={() => onChoose(camera.id)}>Chọn</button>}
      </div>)}
      {!filtered.length && <EmptyState title={cameras.length ? 'Không tìm thấy camera' : 'Chưa có thiết bị'} action={!cameras.length && <Link to="/cameras" className="button">Thêm thiết bị</Link>}>{cameras.length ? 'Thử tìm bằng tên hoặc địa chỉ IP khác.' : 'Thêm camera ở trang Thiết bị để chọn vào Live view.'}</EmptyState>}
    </div>
    <footer className="dialog-footer"><span>{selected.size}/{cameras.length} camera đang xem</span><button type="button" onClick={onClose}>Đóng</button></footer>
  </dialog>;
}
