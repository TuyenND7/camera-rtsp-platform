import { useState } from 'react';
import { api, type Camera } from './api';

const objects: Record<string, string> = { person: 'Người', car: 'Ô tô', motorcycle: 'Xe máy', bicycle: 'Xe đạp', truck: 'Xe tải', bus: 'Xe buýt' };
const defaults = (camera: Camera) => ({ ...camera, ai_enabled: camera.ai_enabled ?? false, ai_fps: camera.ai_fps ?? 2, ai_confidence: camera.ai_confidence ?? .5, ai_labels: camera.ai_labels ?? ['person'] });
export default function CameraAiSettings({ camera, onBusy }: { camera: Camera; onBusy: (value: boolean) => void }) {
  const [value, setValue] = useState(defaults(camera)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function change(patch: Partial<Camera>) {
    if (busy) return;
    setBusy(true); onBusy(true); setError('');
    try { setValue(defaults(await api.updateCamera(camera.id, patch))); }
    catch (error) { setError(error instanceof Error ? error.message : 'Chưa lưu được cấu hình nhận dạng.'); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className="camera-ai-settings">
    <label className="simple-check"><input type="checkbox" checked={value.ai_enabled} disabled={busy} onChange={event => void change(event.target.checked ? { ai_enabled: true, ai_rtsp_url: '' } : { ai_enabled: false })} />Phát hiện trên Live</label>
    {value.ai_enabled && <>
      <div className="form-grid"><label>Tốc độ<select aria-label="Tốc độ nhận dạng" value={value.ai_fps} disabled={busy} onChange={event => void change({ ai_fps: Number(event.target.value) })}>{[...new Set([.5, 1, 2, 3, 5, value.ai_fps])].sort((a, b) => a - b).map(fps => <option key={fps} value={fps}>{fps} hình/giây</option>)}</select></label><label>Độ tin cậy tối thiểu<select aria-label="Độ tin cậy tối thiểu" value={value.ai_confidence} disabled={busy} onChange={event => void change({ ai_confidence: Number(event.target.value) })}>{[...new Set([.3, .4, .5, .6, .7, .8, .9, value.ai_confidence])].sort((a, b) => a - b).map(confidence => <option key={confidence} value={confidence}>{Math.round(confidence * 100)}%</option>)}</select></label></div>
      <fieldset className="camera-ai-labels"><legend>Đối tượng</legend>{Object.entries(objects).map(([label, title]) => <label className="simple-check" key={label}><input type="checkbox" checked={value.ai_labels.includes(label)} disabled={busy || (value.ai_labels.length === 1 && value.ai_labels.includes(label))} onChange={event => void change({ ai_labels: event.target.checked ? [...value.ai_labels, label] : value.ai_labels.filter(item => item !== label) })} />{title}</label>)}</fieldset>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
