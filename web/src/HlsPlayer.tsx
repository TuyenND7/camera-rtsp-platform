import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Hls from 'hls.js';
import { isUiPreview } from './preview';

interface Props {
  src: string; // .m3u8 url
  live?: boolean;
  controls?: boolean;
  muted?: boolean;
  startPosition?: number;
  /** Gọi khoảng 4 lần/giây khi video chạy, và ngay sau khi seek. */
  onTime?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onWaitingChange?: (waiting: boolean) => void;
  onPlaybackError?: (message: string) => void;
  onAudioAvailable?: (available: boolean) => void;
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
  snapshot(): Promise<Blob>;
}

/** Player HLS dùng hls.js, fallback native HLS (Safari). */
const HlsPlayer = forwardRef<HlsPlayerHandle, Props>(function HlsPlayer(
  { src, live = false, controls = true, muted = true, startPosition = -1, onTime, onPlayingChange, onWaitingChange, onPlaybackError, onAudioAvailable },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onTime, onPlayingChange, onWaitingChange, onPlaybackError, onAudioAvailable });
  callbacks.current = { onTime, onPlayingChange, onWaitingChange, onPlaybackError, onAudioAvailable };
  const playRequested = useRef(true);
  const playAttempt = useRef(0);
  const rate = useRef(1);
  // Tăng để tạo lại hls.js (nút Tải lại, lỗi mạng, live bị đứng hình).
  const [generation, setGeneration] = useState(0);

  function playVideo() {
    const video = videoRef.current;
    if (!video) return;
    playRequested.current = true;
    const attempt = ++playAttempt.current;
    callbacks.current.onPlaybackError?.('');
    if (video.ended) video.currentTime = 0;
    video.play().catch((error) => {
      if (attempt !== playAttempt.current || error?.name === 'AbortError') return;
      playRequested.current = false;
      callbacks.current.onPlayingChange?.(false);
      callbacks.current.onWaitingChange?.(false);
      callbacks.current.onPlaybackError?.(error?.name === 'NotAllowedError'
        ? 'Nhấn Phát để bắt đầu xem video.'
        : 'Chưa phát được bản ghi. Hãy thử chọn lại mốc thời gian.');
    });
  }

  function pauseVideo() {
    playRequested.current = false;
    playAttempt.current++;
    videoRef.current?.pause();
    callbacks.current.onPlayingChange?.(false);
    callbacks.current.onWaitingChange?.(false);
  }

  useImperativeHandle(ref, () => ({
    reload() { setGeneration((value) => value + 1); },
    seek(seconds: number) {
      const video = videoRef.current;
      if (!video || !Number.isFinite(seconds)) return;
      video.currentTime = Math.max(0, seconds);
      callbacks.current.onTime?.(video.currentTime);
    },
    play: playVideo,
    pause: pauseVideo,
    togglePlay() {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused || video.ended) playVideo();
      else pauseVideo();
    },
    setRate(value: number) {
      if (!Number.isFinite(value) || value <= 0) return;
      rate.current = value;
      if (videoRef.current) videoRef.current.playbackRate = value;
    },
    currentTime() { return videoRef.current?.currentTime ?? 0; },
    snapshot() {
      return new Promise((resolve, reject) => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) { reject(new Error('Chờ camera có hình rồi chụp lại.')); return; }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        try {
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Thiết bị chưa hỗ trợ chụp ảnh.');
          context.drawImage(video, 0, 0);
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Chưa tạo được ảnh. Hãy thử lại.')), 'image/png');
        } catch { reject(new Error('Không chụp được khung hình hiện tại.')); }
      });
    },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    callbacks.current.onWaitingChange?.(playRequested.current);

    if (isUiPreview) {
      const ready = () => {
        if (startPosition > 0) video.currentTime = Math.min(startPosition, Math.max(0, video.duration - 0.1));
        video.playbackRate = rate.current;
        if (playRequested.current) playVideo();
      };
      video.loop = live;
      video.addEventListener('loadedmetadata', ready);
      video.src = '/__ui-preview__/sample.mp4';
      return () => {
        playAttempt.current++;
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
        video.playbackRate = rate.current;
        if (playRequested.current) playVideo();
      });
      hls.on(Hls.Events.BUFFER_CODECS, (_event, tracks) => {
        if (tracks.audio || tracks.video) callbacks.current.onAudioAvailable?.(!!tracks.audio);
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
        video.playbackRate = rate.current;
        if (playRequested.current) playVideo();
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
      playAttempt.current++;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (watchdog) window.clearInterval(watchdog);
      if (hls) hls.destroy();
    };
  }, [src, live, startPosition, generation]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const time = () => callbacks.current.onTime?.(video.currentTime);
    const playing = () => {
      callbacks.current.onPlayingChange?.(!video.paused && !video.ended);
      if (video.paused) callbacks.current.onWaitingChange?.(false);
    };
    const waiting = () => callbacks.current.onWaitingChange?.(playRequested.current);
    const ready = () => callbacks.current.onWaitingChange?.(false);
    const ended = () => { callbacks.current.onPlayingChange?.(false); callbacks.current.onWaitingChange?.(false); };
    const audio = () => {
      const tracks = (video as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks;
      if (tracks) callbacks.current.onAudioAvailable?.(tracks.length > 0);
    };
    video.addEventListener('timeupdate', time);
    video.addEventListener('seeked', time);
    video.addEventListener('play', playing);
    video.addEventListener('pause', playing);
    video.addEventListener('waiting', waiting);
    video.addEventListener('seeking', waiting);
    video.addEventListener('playing', ready);
    video.addEventListener('canplay', ready);
    video.addEventListener('loadeddata', ready);
    video.addEventListener('seeked', ready);
    video.addEventListener('ended', ended);
    video.addEventListener('loadedmetadata', audio);
    return () => {
      video.removeEventListener('timeupdate', time);
      video.removeEventListener('seeked', time);
      video.removeEventListener('play', playing);
      video.removeEventListener('pause', playing);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('seeking', waiting);
      video.removeEventListener('playing', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('seeked', ready);
      video.removeEventListener('ended', ended);
      video.removeEventListener('loadedmetadata', audio);
    };
  }, []);

  return (
    <video
      ref={videoRef}
      controls={controls}
      muted={muted}
      playsInline
      style={{ width: '100%', height: '100%', background: '#000', borderRadius: controls ? 8 : 0 }}
    />
  );
});

export default HlsPlayer;
