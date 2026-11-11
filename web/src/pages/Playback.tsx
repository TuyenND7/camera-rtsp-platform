import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, Camera, RecordingDay } from '../api';
import HlsPlayer, { HlsPlayerHandle } from '../HlsPlayer';
import Icon from '../Icon';
import PlaybackTimeline from '../PlaybackTimeline';
import { dayStartMs, formatClock, formatShortClock, segmentAt, toTimedSegments } from '../playbackTime';
import { PageHeader } from '../ui';

type OffsetKey = 'offset_s' | 'archive_offset_s';

/**
 * Nguồn phát:
 * - day: một playlist VOD cả ngày; tua = đổi currentTime, không tải lại player.
 * - segment: camera HEVC chưa có archive H.264 đầy đủ — chuẩn bị từng segment.
 */
type Source =
  | { mode: 'day'; url: string; key: OffsetKey; start: number; coverage: number }
  | { mode: 'segment'; url: string; file: string; base: number; start: number };

const SPEEDS = [1, 2, 4, 8];
const DEFAULT_THUMB = { width: 160, height: 90, interval_s: 10 };

export default function Playback() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const cameraId = Number(id);
  const requestedDay = searchParams.get('day') ?? '';
  const requestedFile = searchParams.get('segment') ?? '';
  const [cam, setCam] = useState<Camera | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState('');
  const [dayData, setDayData] = useState<RecordingDay | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [pendingSegment, setPendingSegment] = useState<{ file: string; offsetSec: number } | null>(null);
  const [positionMs, setPositionMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [err, setErr] = useState('');
  const playerRef = useRef<HlsPlayerHandle>(null);
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const advancing = useRef(false);

  const segments = useMemo(() => toTimedSegments(dayData?.segments ?? []), [dayData]);
  const thumb = dayData?.thumb ?? DEFAULT_THUMB;
  const archiveUrl = dayData?.day_playback?.archive ?? null;
  const originalUrl = dayData?.day_playback?.original ?? null;
  // Archive chỉ tồn tại cho camera HEVC; không có archive thì chỉ phát thẳng khi nguồn là H.264.
  const dayMode: { url: string; key: OffsetKey } | null = archiveUrl
    ? { url: archiveUrl, key: 'archive_offset_s' }
    : cam && cam.codec !== 'h265' && originalUrl ? { url: originalUrl, key: 'offset_s' } : null;

  // ---- Tải camera + danh sách ngày ----
  useEffect(() => {
    if (!Number.isFinite(cameraId)) return;
    api.getCamera(cameraId).then(setCam).catch((error) => setErr(error.message));
    api.listCameras().then(setCameras).catch(() => setCameras([]));
    api.recordingDays(cameraId).then((availableDays) => {
      setDays(availableDays);
      setDay(availableDays.includes(requestedDay) ? requestedDay : availableDays[0] ?? '');
    }).catch((error) => setErr(error.message));
  }, [cameraId, requestedDay]);

  // ---- Tải segment của ngày; ngày mới nhất làm mới mỗi phút để timeline có đoạn vừa ghi ----
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    setErr('');
    setDayData(null);
    setSource(null);
    setPendingSegment(null);
    setPositionMs(null);
    const load = () => api.recordingDay(cameraId, day)
      .then((data) => { if (!cancelled) setDayData(data); })
      .catch((error) => { if (!cancelled) setErr(error.message); });
    void load();
    const timer = day === days[0] ? window.setInterval(load, 60_000) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [cameraId, day, days]);

  // ---- Đổi mốc thời gian <-> vị trí video ----
  const playable = useCallback((key: OffsetKey) => segments.filter((segment) => segment[key] !== null), [segments]);

  const wallToTime = useCallback((ms: number, key: OffsetKey): number | null => {
    const list = playable(key);
    const hit = segmentAt(list, ms);
    if (!hit) return null;
    const offset = hit.segment[key] as number;
    if (!hit.inside) return ms > hit.segment.endMs ? offset + hit.segment.duration_s - 1 : offset;
    return offset + (ms - hit.segment.startMs) / 1000;
  }, [playable]);

  const timeToWall = useCallback((t: number, key: OffsetKey): number | null => {
    const list = playable(key);
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid][key] as number) <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return list[0]?.startMs ?? null;
    const segment = list[found];
    return Math.min(segment.endMs, segment.startMs + (t - (segment[key] as number)) * 1000);
  }, [playable]);

  const coverageOf = useCallback((key: OffsetKey) => {
    const list = playable(key);
    const last = list[list.length - 1];
    return last ? (last[key] as number) + last.duration_s : 0;
  }, [playable]);

  // ---- Seek ----
  const seek = useCallback((ms: number) => {
    setPositionMs(ms);
    if (dayMode) {
      const t = wallToTime(ms, dayMode.key);
      if (t === null) return;
      if (source?.mode === 'day' && source.key === dayMode.key && t < source.coverage - 1) {
        playerRef.current?.seek(t);
        playerRef.current?.play();
        return;
      }
      // Mốc nằm sau phần playlist đã tải (đoạn mới ghi): tải lại playlist VOD mới.
      const separator = dayMode.url.includes('?') ? '&' : '?';
      setSource({ mode: 'day', url: `${dayMode.url}${separator}r=${Date.now()}`, key: dayMode.key, start: t, coverage: coverageOf(dayMode.key) });
      return;
    }
    const hit = segmentAt(segments, ms);
    if (!hit) return;
    const offsetSec = hit.inside ? (ms - hit.segment.startMs) / 1000 : 0;
    if (source?.mode === 'segment' && source.file === hit.segment.file) {
      playerRef.current?.seek(source.base + offsetSec);
      return;
    }
    setSource(null);
    setPendingSegment({ file: hit.segment.file, offsetSec });
  }, [coverageOf, dayMode, segments, source, wallToTime]);

  // ---- Mốc bắt đầu khi mở ngày ----
  useEffect(() => {
    if (!cam || !dayData || source || pendingSegment || segments.length === 0 || positionMs !== null) return;
    const requested = segments.find((segment) => segment.file === requestedFile);
    const latest = [...segments].reverse().find((segment) => segment.offset_s !== null) ?? segments[segments.length - 1];
    seek((requested ?? latest).startMs);
  }, [cam, dayData, pendingSegment, positionMs, requestedFile, seek, segments, source]);

  // ---- Chế độ segment: chuẩn bị HLS H.264 cho segment HEVC đã chọn ----
  useEffect(() => {
    if (!pendingSegment || !day) return;
    let cancelled = false;
    let timer: number | undefined;
    const prepare = async () => {
      try {
        const state = await api.prepareBrowserPlayback(cameraId, day, pendingSegment.file);
        if (cancelled) return;
        if (state.status === 'processing') {
          timer = window.setTimeout(prepare, 2000);
          return;
        }
        if (state.status === 'error' || !state.playlist) {
          setErr(state.error ?? 'Không thể chuyển recording H.265 cho browser');
          setPendingSegment(null);
          return;
        }
        const base = state.start_position ?? 0;
        advancing.current = false;
        setSource({ mode: 'segment', url: state.playlist, file: pendingSegment.file, base, start: base + pendingSegment.offsetSec });
        setPendingSegment(null);
      } catch (error: any) {
        if (!cancelled) {
          setErr(error.message);
          setPendingSegment(null);
        }
      }
    };
    void prepare();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [cameraId, day, pendingSegment]);

  // ---- Vị trí video -> mốc trên timeline ----
  const onTime = useCallback((t: number) => {
    if (!source) return;
    if (source.mode === 'day') {
      const wall = timeToWall(t, source.key);
      if (wall !== null) setPositionMs(wall);
      return;
    }
    const index = segments.findIndex((segment) => segment.file === source.file);
    const segment = segments[index];
    if (!segment) return;
    const within = t - source.base;
    setPositionMs(segment.startMs + within * 1000);
    // Playlist một segment: hết đoạn thì tự chuyển sang đoạn kế tiếp.
    const next = segments[index + 1];
    if (source.base === 0 && next && within >= segment.duration_s - 0.3 && !advancing.current) {
      advancing.current = true;
      seek(next.startMs);
    }
  }, [seek, segments, source, timeToWall]);

  useEffect(() => { playerRef.current?.setRate(speed); }, [speed, source]);

  function jump(seconds: number) {
    if (positionMs !== null) seek(positionMs + seconds * 1000);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playerWrapRef.current?.requestFullscreen().catch(() => undefined);
  }

  const latestSegment = segments[segments.length - 1];
  const preparing = pendingSegment !== null;
  const totalBytes = segments.reduce((total, segment) => total + segment.size, 0);

  return (
    <section className="page-card playback-page">
      <PageHeader title="Playback" actions={<Link to="/playback" className="button"><Icon name="folder" size={16} />Chọn camera</Link>} />
      <div className={`playback-shell ${cameras.length <= 1 ? 'single-camera' : ''}`}>
        {cameras.length > 1 && <aside className="playback-camera-rail" aria-label="Chọn camera playback">
          <div className="playback-rail-heading"><Icon name="video" size={19} /><span>Thiết bị</span><small>{cameras.length}</small></div>
          <div className="playback-camera-list">
            {cameras.map((camera) => (
              <Link key={camera.id} to={`/playback/${camera.id}`} className={camera.id === cameraId ? 'active' : ''}>
                <i className={`status-dot ${camera.status}`} />
                <span>{camera.name}</span>
                <Icon name="play" size={13} />
              </Link>
            ))}
            {cameras.length === 0 && <span className="rail-empty">Chưa có camera.</span>}
          </div>
          <Link to="/playback" className="rail-back">← Danh sách recording</Link>
        </aside>}

        <div className="playback-workspace">
          <div className="playback-heading cctv-playback-heading">
            <div>
              <h2>{cam?.name ?? `Camera ${id}`}</h2>
            </div>
            <div className="playback-day-picker"><Icon name="clock" size={18} /><select value={day} onChange={(event) => setDay(event.target.value)} disabled={days.length === 0} aria-label="Chọn ngày">
              {days.length === 0 && <option>Chưa có recording</option>}
              {days.map((value) => <option key={value} value={value}>{formatDay(value)}</option>)}
            </select></div>
          </div>

          {days.length > 1 && <div className="playback-day-strip" aria-label="Ngày có recording">
            {days.map((value) => <button key={value} type="button" onClick={() => setDay(value)} className={value === day ? 'active' : ''}>{formatDayShort(value)}</button>)}
          </div>}

          {err && <p className="form-error">{err}</p>}
          {days.length === 0 && !err && <div className="playback-empty"><Icon name="clock" size={30} /><h3>Chưa có video đã ghi</h3><p>Hãy kiểm tra camera đang bật, trạng thái online và tùy chọn ghi hình.</p><Link to="/cameras">Mở cấu hình camera</Link></div>}

          {days.length > 0 && <>
            <div className="playback-player cctv-playback-player pb-player" ref={playerWrapRef}>
              {source ? (
                <HlsPlayer
                  key={source.url}
                  ref={playerRef}
                  src={source.url}
                  startPosition={source.start}
                  controls={false}
                  onTime={onTime}
                  onPlayingChange={setPlaying}
                  onWaitingChange={setWaiting}
                />
              ) : (
                <div className="playback-empty"><Icon name="video" size={30} /><p>{preparing ? 'Đang chuyển đoạn H.265 đã chọn sang H.264 để browser phát được…' : dayData ? 'Chọn một mốc trên timeline.' : 'Đang tải recording…'}</p></div>
              )}
              {source && waiting && <div className="pb-spinner" aria-label="Đang tải video" />}
              {positionMs !== null && <div className="pb-clock">{formatDay(day)} · {formatClock(positionMs)}</div>}
            </div>
            {preparing && <p className="playback-preparing"><Icon name="clock" size={16} />Đang xử lý file local, không kết nối lại camera. Đoạn này sẽ được cache để mở lại nhanh hơn.</p>}

            <section className="recording-timeline cctv-timeline" aria-label="Timeline playback">
              <div className="pb-controls">
                <div className="pb-controls-main">
                  <button type="button" onClick={() => jump(-10)} disabled={positionMs === null} title="Lùi 10 giây (←)" aria-label="Lùi 10 giây"><Icon name="rewind" size={18} /><small>10</small></button>
                  <button type="button" className="pb-play" onClick={() => playerRef.current?.togglePlay()} disabled={!source} title={playing ? 'Tạm dừng (Space)' : 'Phát (Space)'} aria-label={playing ? 'Tạm dừng' : 'Phát'}><Icon name={playing ? 'pause' : 'play'} size={20} stroke={2.4} /></button>
                  <button type="button" onClick={() => jump(10)} disabled={positionMs === null} title="Tới 10 giây (→)" aria-label="Tới 10 giây"><small>10</small><Icon name="skipForward" size={18} /></button>
                </div>
                <div className="pb-controls-side">
                  <label className="pb-speed">Tốc độ
                    <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                      {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
                    </select>
                  </label>
                  <button type="button" onClick={() => latestSegment && seek(Math.max(latestSegment.startMs, latestSegment.endMs - 30_000))} disabled={!latestSegment} title="Tới đoạn mới nhất">Mới nhất</button>
                  <button type="button" onClick={toggleFullscreen} title="Toàn màn hình" aria-label="Toàn màn hình"><Icon name="layout" size={17} /></button>
                </div>
              </div>

              <PlaybackTimeline
                segments={segments}
                dayStart={day ? dayStartMs(day) : 0}
                positionMs={positionMs}
                thumb={thumb}
                onSeek={seek}
                onTogglePlay={() => playerRef.current?.togglePlay()}
              />
              <p className="timeline-help"><span><i />Có ghi hình</span>{formatBytes(totalBytes)}</p>
            </section>

            <details className="segment-details">
              <summary>Thông tin bản ghi · {segments.length} đoạn <Icon name="chevronDown" size={17} /></summary>
              <div>{segments.map((segment) => <button key={segment.file} onClick={() => seek(segment.startMs)}><span>{formatShortClock(segment.startMs)}</span><b>{segment.file}</b><small>{formatBytes(segment.size)}</small></button>)}</div>
            </details>
          </>}
        </div>
      </div>
    </section>
  );
}

function formatDay(value: string): string {
  if (!value) return '';
  return `${value.slice(6, 8)}/${value.slice(4, 6)}/${value.slice(0, 4)}`;
}

function formatDayShort(value: string): string {
  return `${value.slice(6, 8)}/${value.slice(4, 6)}`;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
