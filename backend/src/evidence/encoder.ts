import { spawn, execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { EvidenceLimits } from './limits';
import { ClipPlan, EvidenceError } from './types';
import { privatePlaylist } from './plan';

export function encoderArgs(plan: ClipPlan, directory: string, preview: boolean, limits: EvidenceLimits): string[] {
  return ['-hide_banner','-v','error','-nostats','-progress','pipe:1','-stats_period','1',
    '-protocol_whitelist','file,crypto,data','-allowed_extensions','ts',
    '-threads',String(limits.threads),'-i',path.join(directory,'input.m3u8'),
    // Output seek decodes the first segment's keyframe before trimming. Input
    // seeking HLS can discard that keyframe and produce an empty/short clip.
    '-ss',plan.seek.toFixed(6),'-t',plan.duration.toFixed(6),'-map','0:v:0',
    ...(preview ? ['-an'] : ['-map','0:a:0?','-c:a','aac','-b:a','64k']),
    '-c:v','libx264','-threads',String(limits.threads),'-filter_threads','1','-preset',limits.preset,
    ...(preview ? ['-vf',"scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=12"] : []),
    '-crf',preview?'24':'20','-maxrate',preview?'2M':'6M','-bufsize',preview?'4M':'12M','-pix_fmt','yuv420p','-fps_mode','vfr',
    '-movflags','+faststart','-y',path.join(directory,'output.part.mp4')];
}
export async function inspectMp4(file: string): Promise<{ duration: number; hasAudio: boolean; width:number; height:number; fps:number }> {
  return new Promise((resolve, reject) => execFile('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate','-of','json',file],
    { timeout: 10000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      try {
        if (error) throw error;
        const value = JSON.parse(stdout), streams = value.streams as Array<{ codec_type: string; codec_name: string; width?:number; height?:number; avg_frame_rate?:string }>;
        if (!Array.isArray(streams) || streams.find(stream => stream.codec_type === 'video')?.codec_name !== 'h264' || streams.some(stream => stream.codec_type === 'audio' && stream.codec_name !== 'aac')) throw new Error('codec');
        const duration = Number(value.format.duration);
        if (!Number.isFinite(duration) || duration < .2) throw new Error('duration');
        const video=streams.find(stream=>stream.codec_type==='video')!,rate=(video.avg_frame_rate??'0/1').split('/').map(Number);
        resolve({ duration, hasAudio: streams.some(stream => stream.codec_type === 'audio'),width:video.width??0,height:video.height??0,fps:rate[0]/(rate[1]||1) });
      } catch { reject(new EvidenceError('Clip chưa tạo được MP4 hợp lệ. Thử chọn khoảng ngắn hơn.', 422)); }
    }));
}
/** All media inputs are immutable local copies. There is no RTSP/network fallback. */
export async function renderClip(plan: ClipPlan, directory: string, preview: boolean, limits: EvidenceLimits,
  signal: AbortSignal, onProgress: (percent: number) => void): Promise<{ size: number; duration: number }> {
  if (signal.aborted) throw new EvidenceError('Đã hủy tạo clip.', 409);
  if (!plan.parts.length || plan.parts.length > 512 || !plan.parts.every(part => /^source-\d{3}\.ts$/.test(part.local) && part.duration > 0 && part.duration <= 3600) || plan.duration < .5 || plan.duration > 1800) throw new EvidenceError('Kế hoạch clip không hợp lệ.', 409);
  const partial = path.join(directory,'output.part.mp4'), output = path.join(directory,'clip.mp4');
  await fs.writeFile(path.join(directory,'input.m3u8'), privatePlaylist(plan), { mode: 0o600 });
  let quotaFailure = false;
  const maxOutput = Math.ceil(plan.duration * 1024 * 1024 + 32 * 1024 * 1024);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', encoderArgs(plan,directory,preview,limits), { stdio: ['ignore','pipe','pipe'] });
      let done = false, pending = '', killing: NodeJS.Timeout | undefined, probing = false;
      const kill = () => { if (done) return; proc.kill('SIGTERM'); killing ??= setTimeout(() => proc.kill('SIGKILL'), 2000); };
      const abort = () => kill(); signal.addEventListener('abort',abort,{ once: true });
      const timeout = setTimeout(() => { timedOut = true; kill(); }, Math.min(1800_000, Math.max(60_000,plan.duration * 8000)));
      let timedOut = false;
      const storageGuard = setInterval(() => {
        if (probing || done) return;
        probing = true;
        void Promise.all([fs.stat(partial).catch(() => null), fs.statfs(directory)]).then(([file,disk]) => {
          if ((file && file.size > maxOutput) || Number(disk.bavail) * Number(disk.bsize) < limits.minFreeBytes) { quotaFailure = true; kill(); }
        }).catch(() => { quotaFailure = true; kill(); }).finally(() => { probing = false; });
      },2000);
      proc.stdout?.on('data',(chunk: Buffer) => {
        pending = (pending + chunk.toString()).slice(-8192);
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0,end); pending = pending.slice(end+1);
          const match = /^out_time_us=(\d+)/.exec(line);
          if (match) onProgress(Math.max(20,Math.min(95,20 + Number(match[1]) / 1e6 / plan.duration * 75)));
        }
      });
      // Drain stderr without echoing private paths or arbitrary source metadata.
      proc.stderr?.resume();
      proc.once('error',() => undefined);
      proc.once('close',(code) => {
        done = true; clearTimeout(timeout); clearInterval(storageGuard); if (killing) clearTimeout(killing); signal.removeEventListener('abort',abort);
        if (signal.aborted) reject(new EvidenceError('Đã hủy tạo clip.',409));
        else if (quotaFailure) reject(new EvidenceError('Không đủ dung lượng để tạo clip. Clip đã giữ trước đó vẫn còn.',507));
        else if (timedOut) reject(new EvidenceError('Tạo clip quá thời gian cho phép. Hãy chọn khoảng ngắn hơn.',504));
        else if (code !== 0) reject(new EvidenceError('Không chuyển được bản ghi này. Chọn khoảng ngắn hơn ở một phiên ghi liên tục.',422));
        else resolve();
      });
      if (signal.aborted) kill();
    });
    if (signal.aborted) throw new EvidenceError('Đã hủy tạo clip.',409);
    const metadata = await inspectMp4(partial), info = await fs.stat(partial);
    if (info.size > maxOutput || metadata.duration < plan.duration - 1 || metadata.duration > plan.duration + 1.5) throw new EvidenceError('Clip không khớp đủ khoảng ghi hình đã chọn; chưa lưu clip bảo vệ.',422);
    await fs.chmod(partial,0o600); await fs.rename(partial,output);
    return { size: info.size, duration: metadata.duration };
  } catch (error) { await fs.rm(partial,{ force: true }).catch(() => undefined); throw error; }
}
