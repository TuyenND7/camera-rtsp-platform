import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Hls from 'hls.js';
import { isUiPreview } from './preview';

interface Props {
  src: string; // .m3u8 url
  live?: boolean;
  controls?: boolean;
  startPosition?: number;
  /** Gọi khoảng 4 lần/giây khi video chạy, và ngay sau khi seek. */
  onTime?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onWaitingChange?: (waiting: boolean) => void;
}

/** Điều khiển video từ component cha (timeline Playback). */
export interface HlsPlayerHandle {
  /** Tạo lại player (tải lại playlist từ đầu). */
  reload(): void;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  setRate(rate: number): void;
  currentTime(): number;
}

/** Player HLS dùng hls.js, fallback native HLS (Safari). */
const HlsPlayer = forwardRef<HlsPlayerHandle, Props>(function HlsPlayer(
  { src, live = false, controls = true, startPosition = -1, onTime, onPlayingChange, onWaitingChange },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onTime, onPlayingChange, onWaitingChange });
  callbacks.current = { onTime, onPlayingChange, onWaitingChange };
  // Tăng để tạo lại hls.js (nút Tải lại, lỗi mạng, live bị đứng hình).
  const [generation, setGeneration] = useState(0);

  useImperativeHandle(ref, () => ({
    reload() { setGeneration((value) => value + 1); },
    seek(seconds: number) {
      const video = videoRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      video.currentTime = Math.max(0, seconds);
      callbacks.current.onTime?.(video.currentTime);
    },
    play() { videoRef.current?.play().catch(() => undefined); },
    pause() { videoRef.current?.pause(); },
    togglePlay() {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) video.play().catch(() => undefined);
      else video.pause();
    },
    setRate(rate: number) { if (videoRef.current) videoRef.current.playbackRate = rate; },
    currentTime() { return videoRef.current?.currentTime ?? 0; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isUiPreview) {
      const ready = () => {
        if (startPosition > 0) video.currentTime = Math.min(startPosition, Math.max(0, video.duration - 0.1));
        video.play().catch(() => undefined);
      };
      video.loop = live;
      video.addEventListener('loadedmetadata', ready);
      video.src = '/__ui-preview__/sample.mp4';
      return () => {
        video.removeEventListener('loadedmetadata', ready);
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    }

    let hls: Hls | null = null;
    let retryTimer: number | undefined;

    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: live,
        enableWorker: true,
        startPosition,
        ...(live
          ? {
              // Mặc định hls.js đứng sau 3 segment (~7s). Bám sát live edge hơn và
              // tự phát nhanh 1.3x để đuổi kịp khi bị tụt lại (mạng chậm, tab ẩn).
              liveSyncDuration: 3,
              liveMaxLatencyDuration: 10,
              maxLiveSyncPlaybackRate: 1.3,
              backBufferLength: 10,
            }
          : {
              // Playback: chỉ đệm vừa đủ quanh vị trí đang xem để seek xa không phải
              // chờ tải xong đoạn đệm cũ.
              maxBufferLength: 20,
              maxMaxBufferLength: 40,
              backBufferLength: 30,
            }),
        xhrSetup(xhr, url) {
          // HttpOnly same-origin cookies also work for native HLS and <img>.
          xhr.withCredentials = new URL(url, window.location.href).origin === window.location.origin;
        },
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => undefined);
      });
      let mediaRecovered = false;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.response?.code === 401) { window.location.replace('/login'); return; }
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          hls?.recoverMediaError();
          return;
        }
        // Thường gặp khi camera đang kết nối lại (playlist 404/không cập nhật):
        // tạo lại player sau vài giây thay vì để màn hình đen mãi.
        if (!retryTimer) retryTimer = window.setTimeout(() => setGeneration((value) => value + 1), live ? 3000 : 6000);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', () => {
        if (startPosition > 0) video.currentTime = startPosition;
        video.play().catch(() => undefined);
      }, { once: true });
    }

    // Live đứng hình > 12s (camera mất kết nối rồi online lại) -> tự tải lại.
    let lastTime = -1;
    let stalledChecks = 0;
    const watchdog = live ? window.setInterval(() => {
      if (video.paused || document.hidden) return;
      stalledChecks = video.currentTime === lastTime ? stalledChecks + 1 : 0;
      lastTime = video.currentTime;
      if (stalledChecks >= 3) setGeneration((value) => value + 1);
    }, 4000) : undefined;

    return () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      if (watchdog) window.clearInterval(watchdog);
      if (hls) hls.destroy();
    };
  }, [src, live, startPosition, generation]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const time = () => callbacks.current.onTime?.(video.currentTime);
    const playing = () => callbacks.current.onPlayingChange?.(!video.paused);
    const waiting = () => callbacks.current.onWaitingChange?.(true);
    const ready = () => callbacks.current.onWaitingChange?.(false);
    video.addEventListener('timeupdate', time);
    video.addEventListener('seeked', time);
    video.addEventListener('play', playing);
    video.addEventListener('pause', playing);
    video.addEventListener('waiting', waiting);
    video.addEventListener('seeking', waiting);
    video.addEventListener('playing', ready);
    video.addEventListener('canplay', ready);
    return () => {
      video.removeEventListener('timeupdate', time);
      video.removeEventListener('seeked', time);
      video.removeEventListener('play', playing);
      video.removeEventListener('pause', playing);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('seeking', waiting);
      video.removeEventListener('playing', ready);
      video.removeEventListener('canplay', ready);
    };
  }, []);

  return (
    <video
      ref={videoRef}
      controls={controls}
      muted
      playsInline
      style={{ width: '100%', height: '100%', background: '#000', borderRadius: controls ? 8 : 0 }}
    />
  );
});

export default HlsPlayer;
