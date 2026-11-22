import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { EncoderBudget } from '../system/performance';
import type { FfmpegPaths } from './ffmpeg';

function audioArgs() { return ['-map','0:a:0?','-c:a','aac','-b:a','64k','-ar','16000','-ac','1']; }
function dateFolder(): string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:config.recordTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)?.value??'').join('');
}
function encoding(budget: EncoderBudget, archive: boolean): string[] {
  const bitrate=archive?config.browserPlaybackBitrate:config.transcodeBitrate;
  const preset=budget.preset??(archive?config.browserPlaybackPreset:config.transcodePreset);
  const args:string[]=[];
  const filters:string[]=[];
  if (budget.width) filters.push(`scale=w='min(${budget.width},iw)':h='min(${Math.round(budget.width*9/16)},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  if (budget.encoder==='vaapi') filters.push('format=nv12','hwupload');
  if (filters.length) args.push('-vf',filters.join(','));
  if (budget.fps) args.push('-fpsmax',String(budget.fps));
  if (budget.encoder==='nvenc') args.push('-c:v','h264_nvenc','-preset',budget.threads<=2?'p3':'p4','-tune','ll','-b:v',bitrate,'-pix_fmt','yuv420p');
  else if (budget.encoder==='vaapi') args.push('-c:v','h264_vaapi','-b:v',bitrate);
  else args.push('-c:v','libx264','-preset',preset,'-tune','zerolatency','-b:v',bitrate,'-pix_fmt','yuv420p');
  if (budget.threads) args.push('-threads',String(budget.threads));
  // A shared encoder must supply keyframes for the shorter Live segment too.
  args.push('-force_key_frames',`expr:gte(t,n_forced*${config.hlsSegmentSeconds})`,'-g','48');
  return args;
}
/** Fall back to separate outputs for exotic/native Windows paths requiring tee's two-level escaping. */
export function canShareEncoder(paths: FfmpegPaths, budget: EncoderBudget): boolean {
  const compatiblePreset=budget.preset!==null||config.transcodePreset===config.browserPlaybackPreset;
  return budget.share_encoder && compatiblePreset && config.transcodeBitrate===config.browserPlaybackBitrate &&
    Object.values(paths).every(value=>!/[\\:'|\[\]\r\n]/.test(value));
}
export function buildStreamArgs(rtspUrl: string, record: boolean, paths: FfmpegPaths, codec:'h264'|'h265', audio: boolean, budget: EncoderBudget): string[] {
  const args=['-hide_banner','-loglevel','warning','-nostats','-progress','pipe:1','-stats_period','5',
    '-rtsp_transport','tcp','-timeout','10000000'];
  if (budget.threads) args.push('-threads',String(budget.threads),'-filter_threads',String(budget.threads));
  if (budget.encoder==='vaapi'&&codec==='h265') args.push('-vaapi_device','/dev/dri/renderD128');
  args.push('-i',rtspUrl);
  const day=record?dateFolder():'';
  const recDay=path.join(paths.recDir,day),playDay=path.join(paths.playbackDir,day);
  if (record) fs.mkdirSync(recDay,{recursive:true});
  const archive=record&&codec==='h265'&&config.browserPlaybackArchive;
  if (archive) fs.mkdirSync(playDay,{recursive:true});
  const shared=archive&&canShareEncoder(paths,budget);
  args.push('-map','0:v:0',...audioArgs());
  if (codec==='h265') args.push(...encoding(budget,false));else args.push('-c:v','copy');
  if (shared) {
    // Both muxers consume the same encoded packets; original recording below is still copy.
    const live=`[f=hls:hls_time=${config.hlsSegmentSeconds}:hls_list_size=${config.hlsListSize}:hls_flags=delete_segments+append_list+omit_endlist+program_date_time:hls_segment_filename=${path.join(paths.liveDir,'seg_%06d.ts')}]${paths.liveIndex}`;
    const browser=`[f=hls:hls_time=${config.browserPlaybackSegmentSeconds}:hls_list_size=0:hls_flags=append_list+independent_segments:strftime=1:hls_segment_filename=${path.join(playDay,'play_%Y%m%d_%H%M%S.ts')}]${path.join(playDay,'index.m3u8')}`;
    args.push('-f','tee',`${live}|${browser}`);
  } else args.push('-f','hls','-hls_time',String(config.hlsSegmentSeconds),'-hls_list_size',String(config.hlsListSize),
    '-hls_flags','delete_segments+append_list+omit_endlist+program_date_time','-hls_segment_filename',path.join(paths.liveDir,'seg_%06d.ts'),paths.liveIndex);
  if (record) args.push('-map','0:v:0','-c:v','copy',...audioArgs(),'-f','hls','-hls_time',String(config.recordSegmentSeconds),'-hls_list_size','0',
    '-hls_flags','append_list','-strftime','1','-hls_segment_filename',path.join(recDay,'rec_%Y%m%d_%H%M%S.ts'),path.join(recDay,'index.m3u8'));
  if (archive&&!shared) args.push('-map','0:v:0',...audioArgs(),...encoding(budget,true),'-f','hls','-hls_time',String(config.browserPlaybackSegmentSeconds),
    '-hls_list_size','0','-hls_flags','append_list+independent_segments','-strftime','1','-hls_segment_filename',path.join(playDay,'play_%Y%m%d_%H%M%S.ts'),path.join(playDay,'index.m3u8'));
  if (audio) args.push('-map','0:a:0','-vn','-ac','1','-ar','8000','-c:a','pcm_s16le','-flush_packets','1','-f','s16le','pipe:3');
  return args;
}
/** Only a failure reported by a hardware component justifies disabling that encoder. */
export function isHardwareEncoderError(line: string, encoder?: string): boolean {
  if (encoder !== 'nvenc' && encoder !== 'vaapi') return false;
  const component = encoder === 'nvenc' ? /\[(?:h264_nvenc|hevc_nvenc|AVHWDeviceContext)[^\]]*\]/i
    : /\[(?:h264_vaapi|hevc_vaapi|AVHWDeviceContext|hwupload|Parsed_hwupload)[^\]]*\]/i;
  return component.test(line) && /\b(?:failed|failure|error|cannot|could not|unable|unsupported)\b|no (?:capable|available) devices|does not support/i.test(line);
}
