import { useEffect, useId, useRef } from 'react';
import Icon from './Icon';
import type { CameraAudio } from './cameraAudio';

export default function CameraAudioDialog({ name, value, onChange, onClose }: { name: string; value: CameraAudio; onChange: (patch: Partial<CameraAudio>) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="device-dialog camera-audio-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header className="dialog-heading"><div><h2 id={id}>Âm lượng · {name}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng âm lượng"><Icon name="close" /></button></header>
    <div className="camera-audio-fields">
      <label><span>Nghe âm thanh camera<output>{Math.round(value.listen)}%</output></span><input type="range" min={0} max={100} step={1} value={value.listen} onChange={event => onChange({ listen: Number(event.target.value) })} aria-label={`Âm lượng nghe ${name}`} /></label>
      <label><span>Giọng nói tới loa camera<output>{value.talk === 0 ? 'Tắt' : `${value.talk}×`}</output></span><input type="range" min={0} max={400} step={25} value={Math.round(value.talk * 100)} onChange={event => onChange({ talk: Number(event.target.value) / 100 })} aria-label={`Mức giọng nói tới ${name}`} /></label>
    </div>
  </dialog>;
}
