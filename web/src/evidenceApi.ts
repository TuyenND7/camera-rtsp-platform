import { featureRequest, type FaceIdentity } from './api';
export type ReviewType = 'event' | 'notice';
export type ReviewStatus = 'unreviewed' | 'reviewed' | 'important' | 'false_positive';
export interface EvidenceReview { target_type: ReviewType; target_id: string; status: ReviewStatus; note: string; updated_at: string; updated_by: string | null }
export interface EvidenceClip {
  id: string; kind: 'protected' | 'preview'; camera_id: number | null; camera_name: string; title: string;
  start_at: string; end_at: string; status: 'preparing' | 'queued' | 'processing' | 'ready' | 'error' | 'cancelled'; progress: number;
  duration_seconds: number | null; size_bytes: number; gaps: Array<{ start_at: string; end_at: string; seconds: number }>;
  error: string | null; event_id: string | null; notice_id: string | null; created_at: string; expires_at: string | null; download_url: string | null;
}
export interface EvidenceQuota { used_bytes: number; reserved_bytes: number; max_bytes: number; free_bytes: number; min_free_bytes: number }
export interface ActivityItem { target_type: ReviewType; target_id: string; detected_at: string; label: string; kind: string | null; track_id: string | null; track_number: number | null; identity?: FaceIdentity; thumbnail_url: string | null }
export interface ActivityGroup { id: string; camera_id: number; camera_name: string; from: string; to: string; objects: ActivityItem[]; items: ActivityItem[] }
const pendingPreviews=new Map<string,Promise<EvidenceClip>>();
export const evidenceApi = {
  clips(signal?: AbortSignal,before?:string) { return featureRequest<{ items: EvidenceClip[]; quota: EvidenceQuota; next_before:string|null }>(`/evidence/clips${before?`?before=${encodeURIComponent(before)}`:''}`,{ signal }); },
  clip(id: string,signal?: AbortSignal) { return featureRequest<EvidenceClip>(`/evidence/clips/${encodeURIComponent(id)}`,{ signal }); },
  create(body: { camera_id: number; start_at: string; end_at: string; title?: string; event_id?: string; notice_id?: string; idempotency_key: string }) {
    return featureRequest<EvidenceClip>('/evidence/clips',{ method:'POST',body:JSON.stringify(body) });
  },
  cancel(id: string) { return featureRequest<{ ok: boolean }>(`/evidence/clips/${encodeURIComponent(id)}/cancel`,{ method:'POST',body:'{}' }); },
  delete(id: string) { return featureRequest<{ ok: boolean }>(`/evidence/clips/${encodeURIComponent(id)}`,{ method:'DELETE',body:JSON.stringify({ confirm:true }) }); },
  preview(type: ReviewType,id: string) {
    const key=`${type}:${id}`,existing=pendingPreviews.get(key);if(existing)return existing;
    const request=featureRequest<EvidenceClip>('/evidence/preview',{ method:'POST',body:JSON.stringify({ target_type:type,target_id:id }) });
    pendingPreviews.set(key,request);void request.finally(()=>{if(pendingPreviews.get(key)===request)pendingPreviews.delete(key);}).catch(()=>undefined);return request;
  },
  reviews(type: ReviewType,ids: string[],signal?: AbortSignal) { return featureRequest<EvidenceReview[]>(`/evidence/reviews?${new URLSearchParams({ target_type:type,ids:ids.join(',') })}`,{ signal }); },
  saveReview(type: ReviewType,id: string,body: { status: ReviewStatus; note: string }) { return featureRequest<EvidenceReview>(`/evidence/reviews/${type}/${encodeURIComponent(id)}`,{ method:'PUT',body:JSON.stringify(body) }); },
  activities(filters: { camera_id?: number; window_seconds?: number; from?: string; to?: string },signal?: AbortSignal) {
    const params = new URLSearchParams();for(const [key,value] of Object.entries(filters))if(value!==undefined)params.set(key,String(value));
    return featureRequest<{ items: ActivityGroup[]; window_seconds: number; truncated: boolean }>(`/evidence/activities?${params}`,{ signal });
  },
};
export const clipStatusLabels: Record<EvidenceClip['status'],string> = { preparing:'Đang giữ bản nguồn',queued:'Đang chờ',processing:'Đang tạo MP4',ready:'Đã giữ clip',error:'Chưa tạo được',cancelled:'Đã hủy' };
export const reviewStatusLabels: Record<ReviewStatus,string> = { unreviewed:'Chưa xem',reviewed:'Đã xem',important:'Quan trọng',false_positive:'Báo nhầm' };
