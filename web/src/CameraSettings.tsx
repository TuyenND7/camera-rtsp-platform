import { useState } from 'react';
import type { Camera } from './api';
import Icon from './Icon';
import CameraVideoSettings from './CameraVideoSettings';
import CameraDeviceSettings from './CameraDeviceSettings';
import CameraAiSettings from './CameraAiSettings';

export default function CameraSettings({ camera, onBusy, initialView = 'video' }: { camera: Camera; onBusy: (busy: boolean) => void; initialView?: 'video' | 'device' }) {
  const [view, setView] = useState<'video' | 'device' | 'ai'>(initialView), [visited, setVisited] = useState(initialView === 'device'), [busy, setBusy] = useState(false);
  const [aiVisited, setAiVisited] = useState(false);
  const [videoVisited, setVideoVisited] = useState(initialView === 'video');
  function updateBusy(value: boolean) { setBusy(value); onBusy(value); }
  return <div className="camera-settings-workspace">
    <div className="camera-settings-switch" role="group" aria-label="Nhóm cài đặt thiết bị"><button type="button" aria-pressed={view === 'video'} disabled={busy} onClick={() => { setVideoVisited(true); setView('video'); }}><Icon name="video" size={19} />Luồng video</button><button type="button" aria-pressed={view === 'device'} disabled={busy} onClick={() => { setVisited(true); setView('device'); }}><Icon name="settings" size={19} />Cài đặt camera</button><button type="button" aria-pressed={view === 'ai'} disabled={busy} onClick={() => { setAiVisited(true); setView('ai'); }}><Icon name="user" size={19} />Nhận dạng</button></div>
    <div hidden={view !== 'video'}>{videoVisited && <CameraVideoSettings camera={camera} onBusy={updateBusy} />}</div>
    {aiVisited && <div hidden={view !== 'ai'}><CameraAiSettings camera={camera} onBusy={updateBusy} /></div>}
    {visited && <div hidden={view !== 'device'}><CameraDeviceSettings camera={camera} onBusy={updateBusy} /></div>}
  </div>;
}
