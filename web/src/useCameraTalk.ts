import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera } from './api';
import { CameraTalk, idleCameraTalk } from './cameraTalk';

export default function useCameraTalk(cameras: Camera[], visible: Set<number>, blocked: boolean) {
  const session = useRef<CameraTalk | null>(null), target = useRef<Camera | null>(null);
  const [state, setState] = useState(idleCameraTalk);
  const stop = useCallback(() => session.current?.stop(), []);
  useEffect(() => {
    const current = new CameraTalk(setState); session.current = current;
    const leave = () => current.stop();
    const visibility = () => { if (document.hidden) leave(); };
    window.addEventListener('blur', leave); window.addEventListener('pagehide', leave);
    window.addEventListener('camera-station:stop-talk', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      current.dispose(); session.current = null;
      window.removeEventListener('blur', leave); window.removeEventListener('pagehide', leave);
      window.removeEventListener('camera-station:stop-talk', leave);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    const id = session.current?.state.cameraId;
    if (session.current?.state.phase === 'idle' || id == null) return;
    const camera = cameras.find(item => item.id === id);
    if (blocked || !visible.has(id) || !camera?.enabled || camera.status !== 'online' || camera.rtsp_url !== target.current?.rtsp_url) stop();
  }, [cameras, visible, blocked, stop]);

  function toggle(camera: Camera) {
    const current = session.current;
    if (!current) return;
    if (current.state.phase !== 'idle') { if (current.state.cameraId === camera.id) current.stop(); return; }
    if (blocked || !camera.enabled || camera.status !== 'online') return;
    target.current = camera; void current.start(camera.id);
  }
  return { ...state, blocked, toggle, stop };
}
