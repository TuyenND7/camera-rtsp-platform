import { useState } from 'react';
import Icon from './Icon';
import { useSurveillance } from './surveillanceContext';
import { detectionLabel } from './liveDetections';

export default function PinnedObjects() {
  const surveillance = useSurveillance(), [error, setError] = useState(''), [busy, setBusy] = useState<string | null>(null);
  if (!surveillance?.pins.length) return null;
  const tracking = surveillance.pins.filter(pin => pin.state === 'tracking').length;
  return <section className="surveillance-pinned" aria-label="Đối tượng đã ghim">
    <header><Icon name="shield" size={18} /><strong>Đang theo dõi</strong><span>{tracking}/{surveillance.pins.length}</span></header>
    <div className="surveillance-pin-list">{surveillance.pins.map(pin => <article key={pin.id} className={`surveillance-pin ${pin.state}`}><button type="button" className="surveillance-pin-open" onClick={() => surveillance.watch({ cameraId: pin.camera_id, trackId: pin.track_id, pin })}><i className={`status-dot ${pin.state === 'tracking' ? 'online' : 'connecting'}`} /><span><strong>{detectionLabel({ label: pin.label, track_number: pin.track_number, identity: pin.identity })}</strong><small>{pin.camera_name} · {pin.state === 'tracking' ? 'Đang thấy' : 'Chưa thấy lại'}{pin.automatic ? ' · Tự ghim' : ''}</small></span></button>{surveillance.canManage && <button type="button" className="icon-button" aria-label={`Bỏ ghim ID ${pin.track_number} ở ${pin.camera_name}`} disabled={busy === pin.id} onClick={() => {
      setBusy(pin.id); setError(''); void surveillance.unpin(pin.id).catch(error => setError(error instanceof Error ? error.message : 'Chưa bỏ ghim được đối tượng.')).finally(() => setBusy(null));
    }}><Icon name="close" size={16} /></button>}</article>)}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
