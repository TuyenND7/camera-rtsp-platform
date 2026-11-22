import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, type Camera, type RecordingDay } from '../api';
import HlsPlayer, { type HlsPlayerHandle } from '../HlsPlayer';
import Icon from '../Icon';
import { PageHeader } from '../ui';
import { SyncClock, SYNC_RATES, chooseSyncStart, needsSyncCorrection, recordZone,
  syncClockAt, syncDateInput, syncDayAt, syncDayBounds, syncRanges, syncSegments, syncTarget, syncTimeOnDay, syncUrlState,
  validSyncDay, type SyncSegment, type SyncTarget } from '../syncPlaybackTime';
import { SyncClipQueue, syncRequest } from '../syncPlaybackLoader';
import '../sync-playback.css';

type DayEntry = { day: string; data?: RecordingDay; segments: SyncSegment[]; loading: boolean; error?: string };
type CardStatus = { blocking: boolean; message: string };
type Source = { key: string; token: number; url: string; start: number; coverage: number; offset?: 'offset_s' | 'archive_offset_s'; file?: string; base?: number };
type ClipRequest = { key: string; id: number; file: string };
const sameStatus = (a: CardStatus | undefined, b: CardStatus) => a?.blocking === b.blocking && a.message === b.message;
const noData: RecordingDay = { playlist: null, segments: [] };

function recordedUrl(value: string): boolean {
  // No camera/RTSP/live URL is ever passed to a synchronized recording player.
  try { const url = new URL(value, window.location.origin); return url.origin === window.location.origin &&
    /^\/(?:api\/recordings\/|rec\/|playback\/|__ui-preview__\/sample\.mp4$)/.test(url.pathname); } catch { return false; }
}

export default function SyncPlayback() {
  const location = useLocation();
  const [cameras, setCameras] = useState<Camera[]>([]), [selected, setSelected] = useState<number[]>([]);
  const [zone, setZone] = useState('Asia/Ho_Chi_Minh'), [day, setDay] = useState(() => syncDayAt(Date.now(), 'Asia/Ho_Chi_Minh'));
  const [days, setDays] = useState<string[]>([]), [entries, setEntries] = useState<Map<number, DayEntry>>(new Map());
  const [booting, setBooting] = useState(true), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const [statuses, setStatuses] = useState<Map<number, CardStatus>>(new Map()), [reload, setReload] = useState(0);
  const [forcedClips, setForcedClips] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1), [hidden, setHidden] = useState(document.hidden);
  const [layout, setLayout] = useState<'grid' | 'list'>(() => window.matchMedia('(max-width: 600px)').matches ? 'list' : 'grid');
  const clock = useRef(new SyncClock(Date.now(), performance.now())), [wall, setWall] = useState(clock.current.wallMs);
  const initialized = useRef(false), requestedAt = useRef<number | null>(null), selectionRef = useRef(selected), dayRef = useRef(day);
  const cache = useRef(new Map<string, { data: RecordingDay; at: number }>()), sourceToken = useRef(0);
  const dayLists = useRef(new Map<number, string[]>());
  const lastReload = useRef(0);
  const [, setPreparedRevision] = useState(0), pool = useRef<SyncClipQueue>();
  if (!pool.current) pool.current = new SyncClipQueue((id, date, file, signal) => syncRequest(signal, s => api.prepareBrowserPlayback(id, date, file, s)), () => setPreparedRevision(value => value + 1));
  selectionRef.current = selected; dayRef.current = day;
  const selectionKey = selected.join(',');

  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setBooting(true); setError(''); initialized.current = false;
    clock.current.play(false, performance.now()); setPlaying(false);
    clock.current.block(true, performance.now());
    void Promise.all([api.listCameras(controller.signal), api.getSettings(controller.signal).catch(() => null)]).then(([items, settings]) => {
      if (!active) return;
      const timezone = recordZone(settings?.record_timezone), query = syncUrlState(location.search, timezone);
      const ids = query.cameras.filter(id => items.some(camera => camera.id === id));
      const chosen = ids.length ? ids : items.slice(0, 2).map(camera => camera.id);
      setCameras(items); setZone(timezone); setSelected(chosen); setDay(query.day); setStatuses(new Map());
      requestedAt.current = query.at;
      const initial = query.at ?? syncDayBounds(query.day, timezone)[0];
      clock.current.seek(initial, performance.now()); setWall(initial);
      // Loading the common calendar is bounded to the selected four cameras.
      return Promise.all(chosen.map(async id => {
        const list = await syncRequest(controller.signal, signal => api.recordingDays(id, signal)).catch(() => []);
        if (active) dayLists.current.set(id, list); return list;
      }))
        .then(lists => {
          if (!active) return;
          const available = [...new Set(lists.flat().filter(validSyncDay))].sort().reverse(); setDays(available);
          if (!query.explicitDay && available[0]) {
            setDay(available[0]); clock.current.seek(syncDayBounds(available[0], timezone)[0], performance.now()); setWall(clock.current.wallMs);
          }
        });
    }).catch(err => { if (active) setError(err instanceof Error ? err.message : 'Chưa tải được camera.'); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; controller.abort(); };
  }, [location.search]);

  useEffect(() => {
    if (booting || !selected.length) return;
    const controller = new AbortController(); let active = true;
    const previous = new Map<number, DayEntry>(), force = lastReload.current !== reload;
    lastReload.current = reload;
    for (const id of selected) {
      const stored = cache.current.get(`${id}/${day}`);
      previous.set(id, { day, data: stored?.data, segments: syncSegments(stored?.data.segments ?? []), loading: !stored });
    }
    setEntries(previous);
    void Promise.all(selected.map(async id => {
      const key = `${id}/${day}`, stored = cache.current.get(key);
      try {
        if (!dayLists.current.has(id)) {
          const available = await syncRequest(controller.signal, signal => api.recordingDays(id, signal)).catch(() => []);
          if (!active) return;
          dayLists.current.set(id, available);
        }
        const value = stored && !force && Date.now() - stored.at < 60_000 ? stored.data
          : await syncRequest(controller.signal, signal => api.recordingDay(id, day, signal));
        if (!active) return;
        cache.current.set(key, { data: value, at: Date.now() });
        while (cache.current.size > 16) cache.current.delete(cache.current.keys().next().value!);
        setEntries(current => new Map(current).set(id, { day, data: value, segments: syncSegments(value.segments), loading: false }));
      } catch (err) {
        if (active) setEntries(current => new Map(current).set(id, { day, data: stored?.data, segments: syncSegments(stored?.data.segments ?? []),
          loading: false, error: err instanceof Error ? err.message : 'Chưa tải được bản ghi.' }));
      }
    })).then(() => {
      if (!active) return;
      setDays([...new Set(selected.flatMap(id => dayLists.current.get(id) ?? []).filter(validSyncDay))].sort().reverse());
      if (initialized.current) return;
      initialized.current = true;
      const sources = selected.map(id => cache.current.get(`${id}/${day}`)?.data ?? noData);
      const at = chooseSyncStart(sources, day, zone, requestedAt.current);
      requestedAt.current = null; clock.current.seek(at, performance.now()); setWall(at);
    });
    return () => { active = false; controller.abort(); };
  }, [booting, selectionKey, day, reload, zone]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden && day === syncDayAt(Date.now(), zone)) setReload(value => value + 1); }, 60_000);
    return () => window.clearInterval(timer);
  }, [day, zone]);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    // StrictMode also performs a setup/cleanup/setup cycle without a new render.
    if (pool.current?.closed) {
      pool.current = new SyncClipQueue((id, date, file, signal) => syncRequest(signal, s => api.prepareBrowserPlayback(id, date, file, s)), () => setPreparedRevision(value => value + 1));
      setPreparedRevision(value => value + 1);
    }
    const activePool = pool.current; return () => activePool?.dispose();
  }, []);

  const blocked = booting || hidden || selected.some(id => entries.get(id)?.day !== day || entries.get(id)?.loading || statuses.get(id)?.blocking !== false);
  useLayoutEffect(() => { clock.current.block(blocked, performance.now()); }, [blocked]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const previous = clock.current.wallMs, at = clock.current.tick(performance.now());
      const date = syncDayAt(at, zone);
      if (!validSyncDay(date)) { clock.current.play(false, performance.now()); clock.current.seek(previous, performance.now()); setPlaying(false); setWall(previous); return; }
      setWall(at);
      if (date !== dayRef.current && !booting) { clock.current.block(true, performance.now()); setDay(date); setStatuses(new Map()); }
    }, 50);
    return () => window.clearInterval(timer);
  }, [zone, booting]);

  const clipRequests: ClipRequest[] = [], prefetched: ClipRequest[] = [];
  for (const id of selected) {
    const camera = cameras.find(item => item.id === id), entry = entries.get(id);
    if (!camera || !entry?.data || entry.day !== day) continue;
    const sourceCamera = forcedClips.has(`${id}/${day}`) ? { ...camera, codec: 'h265' as const } : camera;
    const target = syncTarget(sourceCamera, day, entry.data, entry.segments, wall);
    if (target.kind === 'prepare') clipRequests.push({ id, file: target.segment.file, key: target.key });
    if (playing && target.kind !== 'gap' && target.kind !== 'unfinished') {
      const next = entry.segments.find(segment => segment.startMs >= target.segment.endMs - 1 && segment.file !== target.segment.file);
      if (next && next.startMs - wall <= Math.min(30000, 8000 * speed)) {
        const nextTarget = syncTarget(sourceCamera, day, entry.data, entry.segments, next.startMs);
        if (nextTarget.kind === 'prepare') prefetched.push({ id, file: next.file, key: nextTarget.key });
      }
    }
  }
  clipRequests.push(...prefetched);
  const prepareKey = clipRequests.map(item => item.key).join('|');
  useEffect(() => {
    pool.current!.retain(new Set(clipRequests.map(item => item.key)));
    for (const item of clipRequests) pool.current!.request(item.key, item.id, day, item.file);
  }, [prepareKey, day, reload]);

  const report = useCallback((id: number, date: string, value: CardStatus) => {
    if (dayRef.current !== date || !selectionRef.current.includes(id)) return;
    setStatuses(current => sameStatus(current.get(id), value) ? current : new Map(current).set(id, value));
  }, []);
  const decodeFallback = useCallback((id: number, date: string) => {
    if (dayRef.current !== date || !selectionRef.current.includes(id)) return;
    const key = `${id}/${date}`;
    setForcedClips(current => current.has(key) ? current : new Set([...current].slice(-15).concat(key)));
  }, []);
  function seek(at: number) {
    if (!Number.isFinite(at) || !validSyncDay(syncDayAt(at, zone))) return;
    clock.current.block(true, performance.now()); clock.current.seek(at, performance.now()); setWall(at); setStatuses(new Map());
    const date = syncDayAt(at, zone); if (date !== day) setDay(date);
  }
  function togglePlay() { const value = !clock.current.playing; clock.current.play(value, performance.now()); setPlaying(value); }
  function changeRate(value: number) { clock.current.speed(value, performance.now()); setSpeed(clock.current.rate); }
  function changeDay(value: string) {
    const date = value.replace(/-/g, ''); if (!validSyncDay(date)) return;
    seek(syncTimeOnDay(date, syncClockAt(wall, zone), zone) ?? syncDayBounds(date, zone)[0]);
  }
  function changeSelection(ids: number[]) {
    setSelected([...new Set(ids)].filter(id => cameras.some(camera => camera.id === id)).slice(0, 4));
    setStatuses(new Map()); clock.current.block(true, performance.now());
  }
  function count(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 4) return;
    const ids = [...selected]; for (const camera of cameras) if (ids.length < value && !ids.includes(camera.id)) ids.push(camera.id);
    changeSelection(ids.slice(0, value));
  }
  function retry(id?: number) {
    for (const item of clipRequests) if (!id || item.id === id) pool.current!.retry(item.key);
    setReload(value => value + 1); setStatuses(new Map());
  }
  async function copyLink() {
    try { const url = new URL('/playback/sync', window.location.origin); url.searchParams.set('cameras', selectionKey);
      url.searchParams.set('day', day); url.searchParams.set('at', new Date(wall).toISOString()); await navigator.clipboard.writeText(url.href); setCopied(true); }
    catch { setError('Chưa sao chép được đường dẫn.'); }
  }

  return <section className="sync-playback-page">
    <PageHeader title="Xem lại đồng bộ" actions={<Link className="button" to="/playback" aria-label="Danh sách bản ghi"><Icon name="folder" size={17} />Bản ghi</Link>} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <section className="panel sync-config">
      <div className="sync-date-fields"><label>Ngày chung<input type="date" value={syncDateInput(day)} onChange={event => changeDay(event.target.value)} aria-label="Ngày xem lại chung" /></label><CommonTime wall={wall} zone={zone} day={day} onSeek={seek} /><label>Múi giờ<strong>{zone}</strong></label></div>
      <details className="sync-camera-config"><summary><Icon name="video" size={18} />{selected.length} camera<Icon name="chevronDown" size={16} /></summary><div className="sync-camera-fields"><label>Số camera<select value={selected.length || 1} onChange={event => count(Number(event.target.value))} disabled={booting || !cameras.length}>{[1, 2, 3, 4].map(number => <option key={number} disabled={number > cameras.length} value={number}>{number}</option>)}</select></label>{selected.map((id, index) => <label key={index}>Camera {index + 1}<select value={id} aria-label={`Camera đồng bộ ${index + 1}`} onChange={event => changeSelection(selected.map((value, slot) => slot === index ? Number(event.target.value) : value))}>{cameras.map(camera => <option key={camera.id} value={camera.id} disabled={camera.id !== id && selected.includes(camera.id)}>{camera.name}</option>)}</select></label>)}</div></details>
    </section>
    <div className="sync-common-controls"><div className="sync-transport"><button type="button" aria-label="Lùi đồng bộ 10 giây" onClick={() => seek(wall - 10000)} disabled={booting}><Icon name="rewind" size={19} /><span>10s</span></button><button type="button" className="primary sync-play" aria-label={playing ? 'Tạm dừng đồng bộ' : 'Phát đồng bộ'} aria-pressed={playing} onClick={togglePlay} disabled={booting || !selected.length}><Icon name={playing ? 'pause' : 'play'} size={21} />{playing ? 'Tạm dừng' : 'Phát'}</button><button type="button" aria-label="Tới đồng bộ 10 giây" onClick={() => seek(wall + 10000)} disabled={booting}><span>10s</span><Icon name="skipForward" size={19} /></button></div><label className="sync-inline-select">Tốc độ<select value={speed} onChange={event => changeRate(Number(event.target.value))}>{SYNC_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label><label className="sync-inline-select">Bố cục<select value={layout} onChange={event => setLayout(event.target.value === 'list' ? 'list' : 'grid')}><option value="grid">2 × 2</option><option value="list">Danh sách</option></select></label><button type="button" className="icon-button" onClick={() => retry()} aria-label="Tải lại dữ liệu đồng bộ"><Icon name="refresh" size={19} /></button><button type="button" className="icon-button" onClick={() => void copyLink()} aria-label={copied ? 'Đã sao chép liên kết đồng bộ' : 'Sao chép liên kết đồng bộ'}><Icon name={copied ? 'check' : 'network'} size={19} /></button></div>
    <div className="sync-clock-status"><time dateTime={new Date(wall).toISOString()}>{syncClockAt(wall, zone)}</time><span role="status">{booting ? 'Đang tải bản ghi…' : playing && blocked ? 'Đang chờ camera · thời gian chung tạm dừng' : playing ? 'Đang phát đồng bộ' : 'Đã tạm dừng'}</span></div>
    <div className={`sync-camera-wall sync-wall-${layout}`}>
      {selected.map(id => { const camera = cameras.find(item => item.id === id), entry = entries.get(id); return camera && <SyncCameraCard key={`${id}/${day}`} camera={camera} day={day} wall={wall} getWall={() => clock.current.at(performance.now())} zone={zone} entry={entry?.day === day ? entry : undefined} pool={pool.current!} running={playing && !blocked} speed={speed} forceClip={forcedClips.has(`${id}/${day}`)} decodeFallback={decodeFallback} report={report} token={() => ++sourceToken.current} onRetry={() => retry(id)} />; })}
      {!booting && !selected.length && <p className="muted">Chưa có camera. Thêm thiết bị để xem bản ghi.</p>}
    </div>
    <SyncTimeline day={day} zone={zone} wall={wall} selected={selected.map(id => cameras.find(camera => camera.id === id)!).filter(Boolean)} entries={entries} seek={seek} />
    {!!days.length && <p className="sync-calendar-hint">Có bản ghi: {syncDateInput(days[days.length - 1])} – {syncDateInput(days[0])}</p>}
  </section>;
}

function CommonTime({ wall, zone, day, onSeek }: { wall: number; zone: string; day: string; onSeek: (at: number) => void }) {
  const [draft, setDraft] = useState(syncClockAt(wall, zone)), editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(syncClockAt(wall, zone)); }, [wall, zone]);
  return <label>Giờ chung<input type="time" step={1} value={draft} aria-label="Giờ xem lại chung" onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; setDraft(syncClockAt(wall, zone)); }} onChange={event => { setDraft(event.target.value); const at = syncTimeOnDay(day, event.target.value, zone); if (at !== null) onSeek(at); }} /></label>;
}

function SyncCameraCard({ camera, day, wall, getWall, zone, entry, pool, running, speed, forceClip, decodeFallback, report, token, onRetry }: {
  camera: Camera; day: string; wall: number; getWall: () => number; zone: string; entry?: DayEntry; pool: SyncClipQueue; running: boolean; speed: number;
  forceClip: boolean; decodeFallback: (id: number, day: string) => void;
  report: (id: number, day: string, status: CardStatus) => void; token: () => number; onRetry: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null), [ready, setReady] = useState(false), [playerError, setPlayerError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const lastRetry = useRef(0);
  const sourceCamera = forceClip ? { ...camera, codec: 'h265' as const } : camera;
  const target: SyncTarget = entry?.data ? syncTarget(sourceCamera, day, entry.data, entry.segments, wall) : { kind: 'gap' };
  const prepared = target.kind === 'prepare' ? pool.get(target.key) : undefined;
  let desired: Omit<Source, 'token'> | null = null, message = '', blocking = false, position: number | null = null;
  if (!entry || entry.loading) { message = 'Đang tải danh sách bản ghi…'; blocking = true; }
  else if (entry.error && !entry.data) { message = entry.error; blocking = true; }
  else if (target.kind === 'gap') message = 'Không có bản ghi tại mốc này';
  else if (target.kind === 'unfinished') message = 'Đoạn đang ghi, chưa hoàn tất';
  else if (target.kind === 'day') {
    desired = { key: target.key, url: target.url, coverage: target.coverage, offset: target.offset, start: target.seconds };
    position = target.seconds;
  } else if (prepared?.state === 'ready' && prepared.url) {
    const automaticArchive = /^\/playback\/\d+\/\d{8}\//.test(prepared.url);
    const mapped = target.segment.archive_offset_s;
    if (automaticArchive && (mapped === null || !Number.isFinite(mapped))) {
      message = 'Chưa đủ mốc đối chiếu của bản lưu. Nhấn Thử lại để tải dữ liệu mới.';
    } else {
      const base = automaticArchive ? mapped! : prepared.base ?? 0;
      position = base + (wall - target.segment.startMs) / 1000;
      desired = { key: target.key, url: prepared.url, file: target.segment.file, base, coverage: base + target.segment.duration_s, start: position };
    }
  } else { message = prepared?.state === 'error' ? 'Không phát được bản ghi tại mốc này.' : 'Đang chuẩn bị bản ghi H.264…'; blocking = prepared?.state !== 'error'; }
  if (desired && !recordedUrl(desired.url)) { desired = null; position = null; message = 'Địa chỉ bản ghi không hợp lệ.'; blocking = true; }
  const desiredKey = desired?.key ?? '', desiredUrl = desired?.url ?? '';
  const needsNewCoverage = !!desired && !!source && source.key === desired.key && position !== null &&
    position >= source.coverage && desired.coverage > source.coverage;
  useEffect(() => {
    if (!desired) return;
    const force = lastRetry.current !== retryVersion; lastRetry.current = retryVersion;
    if (!force && source?.key === desired.key && source.url === desired.url && !needsNewCoverage) return;
    setReady(false); setPlayerError(''); setSource({ ...desired, token: token() });
  }, [desiredKey, desiredUrl, needsNewCoverage, retryVersion]);
  const matches = !!source && source.key === desiredKey && position !== null;
  const status = { blocking: !playerError && (blocking || (!!desired && (!matches || !ready))),
    message: playerError || message || (!matches || !ready ? 'Đang tải khung hình…' : 'Sẵn sàng') };
  // Also report after a parent seek clears its readiness map at the same timestamp.
  useEffect(() => report(camera.id, day, status));
  const canShow = matches && !message && !playerError;
  const currentPosition = () => {
    if (!source || !entry?.data || !matches) return null;
    const at = getWall(), current = syncTarget(sourceCamera, day, entry.data, entry.segments, at);
    if (current.kind === 'day' && current.key === source.key && current.seconds <= source.coverage) return current.seconds;
    if (current.kind === 'prepare' && current.segment.file === source.file) return (source.base ?? 0) + (at - current.segment.startMs) / 1000;
    return null;
  };
  return <article className="sync-camera-card"><header><strong>{camera.name}</strong><span>{canShow && ready ? syncClockAt(wall, zone) : 'Bản ghi'}</span></header><div className={`sync-camera-picture${canShow ? '' : ' has-no-picture'}`}>
    {source && <SyncVideo key={source.token} source={source} position={matches ? position : null} currentPosition={currentPosition} running={running && canShow} speed={speed} onReady={setReady} onError={setPlayerError}
      onDecodeFallback={!forceClip && source.offset === 'offset_s' ? () => { setPlayerError(''); setReady(false); decodeFallback(camera.id, day); } : undefined}
      compatibilityDeadline={camera.codec === 'auto' ? 8000 : undefined} />}
    {(!canShow || !ready) && <div className="sync-camera-state"><Icon name={status.blocking ? 'clock' : 'video'} size={24} /><p>{status.message}</p>{(playerError || prepared?.state === 'error' || entry?.error || message.includes('đối chiếu')) && <button type="button" onClick={() => { setPlayerError(''); setReady(false); setRetryVersion(value => value + 1); onRetry(); }}><Icon name="refresh" size={17} />Thử lại</button>}</div>}
  </div></article>;
}

/** The common clock is never written by an old video event or compressed offset. */
function SyncVideo({ source, position, currentPosition, running, speed, onReady, onError, onDecodeFallback, compatibilityDeadline }: { source: Source; position: number | null; currentPosition: () => number | null; running: boolean; speed: number; onReady: (value: boolean) => void; onError: (value: string) => void; onDecodeFallback?: () => void; compatibilityDeadline?: number }) {
  const host = useRef<HTMLDivElement>(null), player = useRef<HlsPlayerHandle>(null), lastCorrection = useRef(-Infinity);
  const values = useRef({ currentPosition, running, speed, onReady, onError, onDecodeFallback, compatibilityDeadline }); values.current = { currentPosition, running, speed, onReady, onError, onDecodeFallback, compatibilityDeadline };
  const playIssued = useRef(false), seenFrame = useRef(false), createdAt = useRef(performance.now());
  const synchronize = useCallback(() => {
    const video = host.current?.querySelector('video'), handle = player.current, value = values.current;
    if (!video || !handle) return;
    handle.setRate(value.speed);
    const desiredPosition = value.currentPosition();
    if (desiredPosition === null) { handle.pause(); playIssued.current = false; return; }
    const now = performance.now();
    if (!document.hidden && !seenFrame.current && video.readyState < 2 && value.compatibilityDeadline &&
      now - createdAt.current >= value.compatibilityDeadline && value.onDecodeFallback) { value.onDecodeFallback(); return; }
    if (video.readyState >= 1 && needsSyncCorrection(video.currentTime, desiredPosition, now, lastCorrection.current)) {
      try { lastCorrection.current = now; handle.seek(desiredPosition); } catch { /* Metadata is still loading. */ }
    }
    const ready = video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - desiredPosition) <= .55;
    if (ready) seenFrame.current = true;
    value.onReady(ready);
    if (video.ended) return; // Never let HlsPlayer's replay-to-zero move a recording backwards.
    if (value.running && ready) {
      if (video.paused && !playIssued.current) { playIssued.current = true; handle.play(); }
    } else { handle.pause(); playIssued.current = false; }
  }, []);
  useLayoutEffect(() => { player.current?.pause(); }, []);
  useEffect(() => {
    const video = host.current?.querySelector('video'); if (!video) return;
    const ready = () => { playIssued.current = false; synchronize(); };
    const waiting = () => values.current.onReady(false);
    const ended = () => { playIssued.current = false; values.current.onReady(false); };
    const decodeError = () => {
      if (values.current.currentPosition() === null) return;
      if (values.current.onDecodeFallback && [3, 4].includes(video.error?.code ?? 0)) values.current.onDecodeFallback();
      else values.current.onError('Không đọc được video của bản ghi. Nhấn Thử lại.');
    };
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'seeked'];
    for (const name of events) video.addEventListener(name, ready);
    video.addEventListener('waiting', waiting); video.addEventListener('seeking', waiting); video.addEventListener('ended', ended); video.addEventListener('error', decodeError);
    // A second seek inside the correction cooldown still needs a later check,
    // even if the common clock is now frozen while waiting for that frame.
    const synchronization = window.setInterval(() => { if (!document.hidden) synchronize(); }, 250);
    const deadline = window.setTimeout(() => { if (values.current.currentPosition() !== null && video.readyState < 2) values.current.onError('Chưa tải được video. Kiểm tra kết nối rồi nhấn Thử lại.'); }, 45000);
    return () => { for (const name of events) video.removeEventListener(name, ready); video.removeEventListener('waiting', waiting); video.removeEventListener('seeking', waiting); video.removeEventListener('ended', ended); video.removeEventListener('error', decodeError); window.clearInterval(synchronization); window.clearTimeout(deadline); };
  }, [synchronize]);
  useLayoutEffect(synchronize, [position, running, speed, synchronize]);
  return <div ref={host} className="sync-video"><HlsPlayer ref={player} src={source.url} controls={false} muted startPosition={source.start}
    onPlaybackError={value => { if (value && currentPosition() !== null) { playIssued.current = false; if (onDecodeFallback && !value.startsWith('Nhấn Phát')) onDecodeFallback(); else onError(value); } }} /></div>;
}

function SyncTimeline({ day, zone, wall, selected, entries, seek }: { day: string; zone: string; wall: number; selected: Camera[]; entries: Map<number, DayEntry>; seek: (at: number) => void }) {
  const [zoom, setZoom] = useState(6 * 3600000), [windowStart, setWindowStart] = useState(wall - 3 * 3600000);
  const [start, end] = syncDayBounds(day, zone), span = zoom === 24 * 3600000 ? end - start : Math.min(zoom, end - start);
  const left = Math.max(start, Math.min(windowStart, end - span)), right = left + span;
  const ranges = useMemo(() => new Map([...entries].map(([id, entry]) => [id, entry.day === day ? syncRanges(entry.segments) : []])), [entries, day]);
  useEffect(() => {
    if (wall < left || wall > right) setWindowStart(wall - span / 2);
  }, [day, wall, zoom, left, right, span]);
  return <section className="panel sync-timeline"><div className="sync-timeline-heading"><strong>Dòng thời gian chung</strong><label>Khoảng xem<select aria-label="Khoảng thời gian trên timeline đồng bộ" value={zoom} onChange={event => { setZoom(Number(event.target.value)); setWindowStart(wall - Number(event.target.value) / 2); }}><option value={24 * 3600000}>Cả ngày</option><option value={6 * 3600000}>6 giờ</option><option value={3600000}>1 giờ</option><option value={15 * 60000}>15 phút</option></select></label></div>
    <div className="sync-time-axis"><span>{syncClockAt(left, zone)}</span><span>{syncClockAt(right - 1, zone)}</span></div>
    <input className="sync-seek" type="range" min={0} max={Math.max(1, (span - 1) / 1000)} step={.1} value={Math.max(0, Math.min(span / 1000, (wall - left) / 1000))} aria-label="Tua tất cả camera tới cùng thời điểm" aria-valuetext={syncClockAt(wall, zone)} onChange={event => seek(left + Number(event.target.value) * 1000)} />
    <div className="sync-recording-lanes">{selected.map(camera => <div className="sync-recording-lane" key={camera.id}><strong>{camera.name}</strong><div className="sync-recording-track" role="slider" tabIndex={0} aria-label={`Dòng thời gian ${camera.name}`} aria-valuemin={left} aria-valuemax={right - 1} aria-valuenow={Math.round(wall)} aria-valuetext={syncClockAt(wall, zone)} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); seek(left + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (span - 1)); }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(wall + (event.key === 'ArrowLeft' ? -10000 : 10000)); } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seek(event.key === 'Home' ? left : right - 1); } }}>
      {(ranges.get(camera.id) ?? []).filter(range => range[1] > left && range[0] < right).map(range => <span key={range[0]} style={{ left: `${Math.max(0, (range[0] - left) / span * 100)}%`, width: `${(Math.min(right, range[1]) - Math.max(left, range[0])) / span * 100}%` }} />)}<i style={{ left: `${Math.max(0, Math.min(100, (wall - left) / span * 100))}%` }} />
    </div></div>)}</div><p>Khoảng trống giữ nguyên giờ. Cả nhóm chờ khi một camera đang tải; âm thanh mặc định tắt.</p>
  </section>;
}
