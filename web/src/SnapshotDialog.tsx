import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

export type LiveSnapshot = { blob: Blob; cameraId: number; name: string; capturedAt: Date };

export default function SnapshotDialog({ snapshot, onClose }: { snapshot: LiveSnapshot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url] = useState(() => URL.createObjectURL(snapshot.blob));
  const [notice, setNotice] = useState('');
  const filename = `camera-${snapshot.cameraId}-${snapshot.capturedAt.toISOString().replace(/[:.]/g, '-')}.png`;
  useEffect(() => {
    dialog.current?.showModal();
    return () => { dialog.current?.close(); URL.revokeObjectURL(url); };
  }, [url]);

  async function copy() {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': snapshot.blob })]); setNotice('Đã sao chép ảnh'); }
    catch { setNotice('Chưa sao chép được ảnh trên thiết bị này. Bạn có thể tải ảnh bằng trình duyệt.'); }
  }

  return <dialog ref={dialog} className="device-dialog snapshot-dialog" aria-labelledby="snapshot-title" onCancel={onClose}>
    <header className="dialog-heading"><div><h2 id="snapshot-title">{snapshot.name}</h2><p>{snapshot.capturedAt.toLocaleString('vi-VN')} · Ảnh từ khung hình live</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng ảnh"><Icon name="close" /></button></header>
    <div className="snapshot-image"><img src={url} alt={`Ảnh chụp ${snapshot.name}`} /></div>
    {notice && <p className="muted" role="status">{notice}</p>}
    <footer className="snapshot-actions">{typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function' && <button type="button" onClick={() => void copy()}><Icon name="check" size={18} />Sao chép ảnh</button>}<a className="button primary" href={url} download={filename}><Icon name="folder" size={18} />Tải ảnh PNG</a></footer>
  </dialog>;
}
