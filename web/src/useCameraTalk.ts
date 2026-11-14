import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera } from './api';
import { CameraTalk, idleCameraTalk } from './cameraTalk';
import { getCameraAudio } from './cameraAudio';
import { useDevice } from './device';

export default function useCameraTalk(cameras: Camera[], visible: Set<number>, blocked: boolean) {
  const session = useRef<CameraTalk | null>(null), targets = useRef<Camera[]>([]);
  const { playbackVolume } = useDevice();
  const [state, setState] = useState(idleCameraTalk);
  const stop = useCallback(() => session.current?.stop(), []);
  useEffect(() => {
    const current = new CameraTalk(setState, id => getCameraAudio(id).listen / 100); session.current = current;
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
  useEffect(() => { session.current?.setListenVolume(playbackVolume); }, [playbackVolume]);
  useEffect(() => {
    const current = session.current;
    if (!current || current.state.phase === 'idle') return;
    if (blocked || targets.current.some(original => {
      const camera = cameras.find(item => item.id === original.id);
      return (!current.state.broadcast && !visible.has(original.id)) || !camera?.enabled || camera.status !== 'online' || camera.rtsp_url !== original.rtsp_url;
    })) void stop();
  }, [cameras, visible, blocked, stop]);

  function toggle(camera: Camera) {
    const current = session.current;
    if (!current) return;
    if (current.state.phase !== 'idle') { if (current.state.cameraIds.includes(camera.id)) void current.stop(); return; }
    if (blocked || !camera.enabled || camera.status !== 'online') return;
    targets.current = [camera]; void current.start(camera.id);
  }
  function toggleAll(ids: number[], prepare?: () => Promise<void>) {
    const current = session.current;
    if (!current || blocked) return;
    if (current.state.phase !== 'idle' && current.state.broadcast) { void current.stop(); return; }
    const chosen = cameras.filter(camera => ids.includes(camera.id) && camera.enabled && camera.status === 'online');
    if (!chosen.length || chosen.length !== ids.length) return;
    if (current.state.phase !== 'idle') void current.stop();
    targets.current = chosen; void current.start(ids, prepare);
  }
  const setListenGain = useCallback((id: number, gain: number) => session.current?.setListenGain(id, gain), []);
  return { ...state, blocked, toggle, toggleAll, stop, setListenGain };
}
