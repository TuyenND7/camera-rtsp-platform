import { useEffect, useId, useRef, useState } from 'react';
import type { Camera } from './api';
import CameraSettings from './CameraSettings';
import Icon from './Icon';
import { lockBodyScroll } from './bodyScroll';

export default function CameraSettingsDialog({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal(); const unlockScroll = lockBodyScroll();
    return () => {
      element?.close(); unlockScroll();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
        if (document.activeElement !== previous) previous.closest<HTMLElement>('[role="group"]')?.focus({ preventScroll: true });
      }
    };
  }, []);
  return <dialog ref={dialog} className="device-dialog live-camera-settings-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
  }} onKeyUp={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
    <header className="dialog-heading"><div><h2 id={`${id}-title`}>Cài đặt camera</h2><p>{camera.name}</p></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={`Đóng cài đặt ${camera.name}`}><Icon name="close" size={21} /></button></header>
    <div className="device-editor-content"><CameraSettings camera={camera} onBusy={setBusy} initialView="device" /></div>
  </dialog>;
}
