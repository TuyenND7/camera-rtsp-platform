import { useEffect, useRef, useState } from 'react';
import type { Camera, Point, SurveillanceZone } from './api';
import HlsPlayer from './HlsPlayer';
import Icon from './Icon';
import { regionBounds, regionRectangle } from './regionGeometry';

type Gesture = { id: string; pointerId: number; first: Point; current: Point; name: string };

export default function RegionEditor({ camera, zones, onChange, disabled = false }: {
  camera: Camera; zones: SurveillanceZone[]; onChange: (zones: SurveillanceZone[]) => void; disabled?: boolean;
}) {
  const feed = useRef<HTMLDivElement>(null), canvas = useRef<SVGSVGElement>(null), gesture = useRef<Gesture | null>(null);
  const [selected, setSelected] = useState(zones[0]?.id ?? ''), [drawing, setDrawing] = useState<{ id: string; name: string } | null>(null);
  const [preview, setPreview] = useState<Point[] | null>(null), [message, setMessage] = useState('');
  const [videoSize, setVideoSize] = useState({ width: 16, height: 9, ready: false });
  const [canvasWidth, setCanvasWidth] = useState(320);
  const online = camera.status === 'online';
  const selectedZone = zones.find(zone => zone.id === selected) ?? zones[0];

  useEffect(() => {
    const video = feed.current?.querySelector('video');
    setVideoSize({ width: 16, height: 9, ready: false });
    if (!video) return;
    const update = () => {
      if (video.videoWidth && video.videoHeight) setVideoSize({ width: video.videoWidth, height: video.videoHeight, ready: true });
    };
    video.addEventListener('loadedmetadata', update); video.addEventListener('resize', update); update();
    return () => { video.removeEventListener('loadedmetadata', update); video.removeEventListener('resize', update); };
  }, [camera.id, online]);

  useEffect(() => {
    if (selected && !zones.some(zone => zone.id === selected)) setSelected(zones[0]?.id ?? '');
  }, [zones, selected]);
  useEffect(() => {
    const element = feed.current;
    if (!element) return;
    const update = () => setCanvasWidth(element.clientWidth || 320);
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (disabled) cancelDrawing(); }, [disabled]);

  const point = (event: React.PointerEvent): Point => {
    const bounds = canvas.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))];
  };
  function begin(event: React.PointerEvent, corner?: 'first' | 'last') {
    if (disabled || !videoSize.ready || event.button !== 0 || gesture.current) return;
    let target = drawing;
    let first = point(event);
    if (corner && selectedZone) {
      const [left, top, right, bottom] = regionBounds(selectedZone.points);
      first = corner === 'first' ? [right, bottom] : [left, top];
      target = { id: selectedZone.id, name: selectedZone.name };
      setDrawing(target);
    }
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    canvas.current?.setPointerCapture(event.pointerId);
    gesture.current = { ...target, pointerId: event.pointerId, first, current: point(event) };
    setPreview(regionRectangle(first, point(event))); setMessage('');
  }
  function move(event: React.PointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.current = point(event);
    setPreview(regionRectangle(active.first, active.current));
  }
  function finish(event: React.PointerEvent) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const points = regionRectangle(active.first, point(event));
    gesture.current = null; setPreview(null);
    if (canvas.current?.hasPointerCapture(event.pointerId)) canvas.current.releasePointerCapture(event.pointerId);
    if (!points) { setMessage('Vùng quá nhỏ. Kéo rộng hơn một chút.'); return; }
    const next: SurveillanceZone = { id: active.id, name: active.name, points };
    onChange(zones.some(zone => zone.id === active.id) ? zones.map(zone => zone.id === active.id ? next : zone) : [...zones, next]);
    setSelected(active.id); setDrawing(null); setMessage('');
  }
  function cancelDrawing() { gesture.current = null; setDrawing(null); setPreview(null); setMessage(''); }
  function add() {
    const numbers = zones.map(zone => Number(/^Vùng (\d+)$/.exec(zone.name)?.[1]));
    const number = [1, 2, 3].find(value => !numbers.includes(value)) ?? zones.length + 1;
    setDrawing({ id: `zone-${crypto.randomUUID().slice(0, 8)}`, name: `Vùng ${number}` }); setPreview(null); setMessage('');
  }

  return <div className="region-editor">
    <div className="region-editor-toolbar">
      <label className="region-selector"><span className="sr-only">Vùng đang chỉnh</span><select aria-label="Vùng đang chỉnh" value={selectedZone?.id ?? ''} disabled={disabled || !!drawing || !zones.length} onChange={event => { setSelected(event.target.value); setMessage(''); }}>
        {!zones.length && <option value="">Chưa có vùng</option>}{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
      </select></label>
      <button type="button" disabled={disabled || !videoSize.ready || !!drawing || zones.length >= 3} onClick={add}><Icon name="plus" size={17} />Thêm vùng</button>
      {selectedZone && <><button type="button" disabled={disabled || !videoSize.ready || !!drawing} onClick={() => { setDrawing({ id: selectedZone.id, name: selectedZone.name }); setMessage(''); }}><Icon name="edit" size={17} />Vẽ lại</button><button type="button" className="danger-text" disabled={disabled || !!drawing} onClick={() => { onChange(zones.filter(zone => zone.id !== selectedZone.id)); setMessage(''); }} aria-label={`Xóa ${selectedZone.name}`}><Icon name="trash" size={17} /></button></>}
    </div>
    <div className={`region-canvas${drawing ? ' drawing' : ''}`} style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}` }}>
      <div className="region-feed" ref={feed}>{online && <HlsPlayer src={`/live/${camera.id}/index.m3u8`} live controls={false} muted volume={0} />}</div>
      {!videoSize.ready && <div className="region-feed-status" role="status">{online ? 'Đang tải khung hình…' : 'Camera chưa trực tuyến'}</div>}
      <svg ref={canvas} className="region-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Vẽ vùng nhận dạng trên camera" role="img"
        onPointerDown={event => begin(event)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelDrawing}>
        {zones.map(zone => {
          const points = drawing?.id === zone.id && preview ? preview : zone.points;
          const [left, top, right, bottom] = regionBounds(points), active = selectedZone?.id === zone.id;
          return <g key={zone.id} className={active ? 'selected' : ''}>
            <polygon points={points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')} onClick={() => { if (!drawing) setSelected(zone.id); }} />
            <text x={left * 1000 + 12} y={Math.min(top * 1000 + 48, bottom * 1000 - 8)}>{zone.name}</text>
            {active && !disabled && !drawing && <>{([[left, top], [right, bottom]] as Point[]).map(([x, y], index) => <g key={index}><circle className="region-handle-target" cx={x * 1000} cy={y * 1000} r={24 * 1000 / canvasWidth} onPointerDown={event => begin(event, index === 0 ? 'first' : 'last')} /><circle className="region-handle" cx={x * 1000} cy={y * 1000} r={6 * 1000 / canvasWidth} /></g>)}</>}
          </g>;
        })}
        {drawing && preview && !zones.some(zone => zone.id === drawing.id) && <polygon className="region-draft" points={preview.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')} />}
      </svg>
    </div>
    {drawing ? <div className="region-draw-instruction" role="status"><span>Kéo từ một góc đến góc đối diện để vẽ {drawing.name.toLowerCase()}.</span><button type="button" onClick={cancelDrawing}>Hủy vẽ</button></div>
      : <p className="surveillance-hint">Tối đa 3 vùng. Kéo chấm ở góc để chỉnh kích thước.</p>}
    {message && <p className="form-error" role="alert">{message}</p>}
  </div>;
}
