import { useCallback, useEffect, useRef, useState } from 'react';
import { api, DiscoveredDevice, DiscoveryState } from './api';
import Icon from './Icon';

export default function DeviceDiscovery({ onSelect, onClose }: { onSelect: (device: DiscoveredDevice) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scanId = useRef<string | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const [subnet, setSubnet] = useState('');
  const [scan, setScan] = useState<DiscoveryState | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState('');

  const start = useCallback(async (network: string) => {
    const current = ++generation.current;
    setStarting(true); setError(''); setScan(null);
    try {
      const state = await api.discoverDevices(network);
      if (!alive.current || current !== generation.current) { if (state.status === 'running') void api.cancelDiscovery(state.id).catch(() => undefined); return; }
      scanId.current = state.id; setScan(state);
    } catch (err: any) { if (alive.current && current === generation.current) setError(err.message); }
    finally { if (alive.current && current === generation.current) setStarting(false); }
  }, []);

  useEffect(() => {
    let stopped = false;
    alive.current = true;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void api.discoveryOptions().then((options) => {
      if (stopped || !alive.current) return;
      const host = window.location.hostname;
      const browserSubnet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `${host.split('.').slice(0, 3).join('.')}.0/24` : '';
      const network = options.default_subnet || browserSubnet;
      setSubnet(network);
      if (network) void start(network);
      else { setStarting(false); setError('Nhập dải mạng của camera để bắt đầu dò.'); }
    }).catch((err) => { if (!stopped && alive.current) { setError(err.message); setStarting(false); } });
    return () => {
      stopped = true; alive.current = false; generation.current++;
      document.body.style.overflow = previous;
      if (scanId.current) void api.cancelDiscovery(scanId.current).catch(() => undefined);
    };
  }, [start]);

  useEffect(() => {
    if (!scan || scan.status !== 'running') return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        const next = await api.discoveryStatus(scan.id);
        if (!stopped && alive.current) { setScan(next); if (next.status === 'running') timer = window.setTimeout(poll, 750); }
      } catch (err: any) { if (!stopped && alive.current) { setError(err.message); setScan((current) => current ? { ...current, status: 'error' } : current); } }
    };
    timer = window.setTimeout(poll, 750);
    return () => { stopped = true; clearTimeout(timer); };
  }, [scan?.id, scan?.status]);

  const busy = starting || scan?.status === 'running';
  const progress = scan?.progress_percent ?? 0;

  return <dialog ref={dialog} className="device-dialog discovery-dialog" aria-labelledby="discovery-title" onCancel={onClose}>
    <header className="dialog-heading"><div><h2 id="discovery-title">Dò thiết bị</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng dò thiết bị"><Icon name="close" size={20} /></button></header>
    <form className="discovery-network" onSubmit={(event) => { event.preventDefault(); void start(subnet); }}><label htmlFor="discovery-network">Dải mạng</label><input id="discovery-network" value={subnet} onChange={(event) => setSubnet(event.target.value)} placeholder="192.168.0.0/24" disabled={busy} /><button type="submit" disabled={busy || !subnet.trim()}><Icon name="refresh" size={16} />{busy ? 'Đang dò…' : 'Dò lại'}</button></form>
    <div className="discovery-body">
      {(error || scan?.error) && <div className="notice error" role="alert">{error || scan?.error}</div>}
      <div className="discovery-progress"><span>{busy ? `Đang dò ${progress}% · ${scan?.devices.length ?? 0} thiết bị` : scan?.status === 'cancelled' ? 'Đã dừng dò' : `Tìm thấy ${scan?.devices.length ?? 0} thiết bị`}</span>{scan?.status === 'running' && <button type="button" className="text-button" onClick={() => { void api.cancelDiscovery(scan.id).then(setScan).catch((err) => setError(err.message)); }}>Dừng</button>}<progress max="100" value={progress} aria-label="Tiến độ dò mạng" /></div>
      {!!scan?.devices.length && <div className="table-scroll"><table className="discovery-table"><thead><tr><th>Thiết bị</th><th>Địa chỉ</th><th>Hỗ trợ</th><th /></tr></thead><tbody>{scan.devices.map((device) => <tr key={device.ip}><td><strong>{device.name}</strong>{!!device.added_cameras.length && <small className="discovered-added"><Icon name="check" size={12} />Đã thêm {device.added_cameras.length > 1 ? `${device.added_cameras.length} kênh` : ''}</small>}</td><td><code>{device.ip}</code></td><td><div className="discovered-protocols">{device.protocols.map((protocol) => <span className="subtle-badge" key={protocol}>{protocol.toUpperCase()}</span>)}</div></td><td><button type="button" disabled={busy && !device.onvif_url} onClick={() => onSelect(device)} title={busy && !device.onvif_url ? 'Đang kiểm tra địa chỉ ONVIF' : 'Chọn thiết bị'}>Chọn<Icon name="chevronRight" size={14} /></button></td></tr>)}</tbody></table></div>}
      {!scan?.devices.length && <div className="discovery-empty"><Icon name="network" size={29} /><p>{busy ? 'Thiết bị tìm thấy sẽ xuất hiện tại đây.' : 'Chưa tìm thấy camera hoặc NVR.'}</p>{!busy && <small>Kiểm tra camera cùng mạng với máy chủ và đã bật ONVIF hoặc RTSP.</small>}</div>}
    </div>
    <footer className="dialog-footer"><span>Chọn thiết bị để đăng nhập và lấy luồng video.</span><button type="button" onClick={onClose}>Đóng</button></footer>
  </dialog>;
}
