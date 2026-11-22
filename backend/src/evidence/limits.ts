export interface EvidenceLimits { threads: number; preset: string; maxBytes: number; minFreeBytes: number }
const gib = 1024 ** 3;
let limits: EvidenceLimits = { threads: 2, preset: 'veryfast', maxBytes: 10 * gib, minFreeBytes: 512 * 1024 ** 2 };
const presets = new Set(['ultrafast','superfast','veryfast','faster','fast','medium']);
export function setEvidenceLimits(value: Partial<EvidenceLimits>): void {
  limits = { threads: Number.isInteger(value.threads) ? Math.max(1, Math.min(4, value.threads!)) : limits.threads,
    preset: value.preset && presets.has(value.preset) ? value.preset : limits.preset,
    maxBytes: Number.isFinite(value.maxBytes) ? Math.max(gib, Math.min(1024 * gib, value.maxBytes!)) : limits.maxBytes,
    minFreeBytes: Number.isFinite(value.minFreeBytes) ? Math.max(128 * 1024 ** 2, Math.min(100 * gib, value.minFreeBytes!)) : limits.minFreeBytes };
}
setEvidenceLimits({ threads: Number(process.env.EVIDENCE_ENCODER_THREADS || 2), preset: process.env.EVIDENCE_TRANSCODE_PRESET,
  maxBytes: Number(process.env.EVIDENCE_MAX_BYTES || 10 * gib), minFreeBytes: Number(process.env.EVIDENCE_MIN_FREE_BYTES || 512 * 1024 ** 2) });
export const evidenceLimits = (): EvidenceLimits => ({ ...limits });
