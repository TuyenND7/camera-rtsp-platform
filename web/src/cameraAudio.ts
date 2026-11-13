export type CameraAudio = { listen: number; talk: number };
export const cameraAudioChanged = 'camera-station:camera-audio';
const fallback = new Map<number, CameraAudio>();
const key = (id: number) => `camera-station.camera.${id}.audio`;
const valid = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

export function getCameraAudio(id: number): CameraAudio {
  if (fallback.has(id)) return { ...fallback.get(id)! };
  let stored: Partial<CameraAudio> = fallback.get(id) ?? {};
  try { const value = JSON.parse(localStorage.getItem(key(id)) ?? 'null'); if (value && typeof value === 'object') stored = value; } catch {}
  return { listen: valid(stored.listen, 100) ? stored.listen : 100, talk: valid(stored.talk, 4) ? stored.talk : 2 };
}
export function setCameraAudio(id: number, patch: Partial<CameraAudio>): CameraAudio {
  const value = { ...getCameraAudio(id), ...patch };
  if (!valid(value.listen, 100) || !valid(value.talk, 4)) throw new Error('Mức âm lượng không hợp lệ.');
  try { localStorage.setItem(key(id), JSON.stringify(value)); fallback.delete(id); } catch { fallback.set(id, value); }
  window.dispatchEvent(new CustomEvent(cameraAudioChanged, { detail: { cameraId: id } }));
  return value;
}
export const cameraTalkGains = (ids: number[]) => Object.fromEntries(ids.map(id => [id, getCameraAudio(id).talk]));
