import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as webpush from 'web-push';
import { pool } from '../db';
import { config } from '../config';
import { BrowserSubscription, deliverWebPush, PushError, PushPreferences, pushPreferenceDefaults, pushAllowed, validatePushSubscription } from './pushSecurity';
import { profileNotificationsAllowed } from './profiles';

type Vapid = { publicKey: string; privateKey: string; subject: string };
let vapidPromise: Promise<Vapid> | undefined;
export function pushVapid(): Promise<Vapid> {
  return vapidPromise ??= (async () => {
    const dir = path.join(config.storageRoot, '.push'), file = path.join(dir, 'vapid.json');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const folder = await fs.lstat(dir);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new PushError('Thư mục khóa push không hợp lệ.', 503);
    await fs.chmod(dir, 0o700);
    try {
      const keys = webpush.generateVAPIDKeys();
      await fs.writeFile(file, JSON.stringify(keys), { flag: 'wx', mode: 0o600 });
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new PushError('Không đọc được khóa push.', 503);
    await fs.chmod(file, 0o600);
    const keys = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!/^[A-Za-z0-9_-]{87}$/.test(keys.publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey)) throw new PushError('Khóa push cần được kiểm tra trên máy chủ.', 503);
    return { ...keys, subject: process.env.WEB_PUSH_SUBJECT || 'mailto:admin@camera-station.invalid' };
  })().catch(err => { vapidPromise = undefined; throw err; });
}
const safeName = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : 'Camera';
export function pushNoticePayload(notice: any) {
  const titles: Record<string, string> = { intrusion: 'Có người vào vùng theo dõi', loitering: 'Phát hiện lảng vảng', pacing: 'Phát hiện đi qua lại', unfamiliar: 'Khuôn mặt chưa đăng ký',
    camera_offline: 'Camera mất kết nối', video_stalled: 'Video đang gián đoạn', recording_stopped: 'Ghi hình đang gián đoạn', storage_error: 'Cần kiểm tra lưu trữ', resource_overload: 'Máy chủ đang quá tải' };
  const objectEvent = ['intrusion', 'loitering', 'pacing', 'unfamiliar'].includes(notice.kind);
  const id = /^[1-9]\d*$/.test(String(notice.id)) ? String(notice.id) : '0';
  const camera = Number.isInteger(notice.camera_id) && notice.camera_id > 0 ? notice.camera_id : 0;
  return { version: 1, title: titles[notice.kind] ?? 'Camera Station có thông báo mới', body: safeName(notice.camera_name),
    tag: `camera-notice-${id}`, url: objectEvent && camera ? `/live?camera=${camera}&notice=${id}` : '/settings#health', silent: false,
    subscription_id: notice.subscription_id };
}
export function shouldRetryPush(status: number, attempts: number): boolean { return attempts < 3 && (status === 429 || status >= 500); }
const preferences = (row?: any): PushPreferences => row ? { enabled: row.enabled, timezone: row.timezone, quiet_enabled: row.quiet_enabled,
  quiet_start: row.quiet_start, quiet_end: row.quiet_end, snooze_until: row.snooze_until ? new Date(row.snooze_until).toISOString() : null } : pushPreferenceDefaults();

export async function pushSnapshot(userId: number, sessionHash: string) {
  const [keys, prefs, devices] = await Promise.all([pushVapid(), pool.query('SELECT * FROM push_preferences WHERE user_id=$1', [userId]),
    pool.query(`SELECT p.id,p.name,p.endpoint,p.created_at,p.last_success_at,p.last_error,(p.session_hash=$2) AS current_session,s.expires_at
      FROM push_subscriptions p JOIN auth_sessions s ON s.token_hash=p.session_hash WHERE p.user_id=$1 AND s.expires_at>now() ORDER BY p.created_at DESC`, [userId, sessionHash])]);
  return { vapid_public_key: keys.publicKey, preferences: preferences(prefs.rows[0]), devices: devices.rows.map(({endpoint,...safe})=>({...safe,endpoint_fingerprint:createHash('sha256').update(endpoint).digest('hex')})),
    profile_notifications_enabled: profileNotificationsAllowed() };
}
export async function registerPush(userId: number, sessionHash: string, raw: unknown, name: string) {
  const subscription = validatePushSubscription(raw), client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(731923,5)');
    const live = await client.query('SELECT token_hash FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()', [sessionHash, userId]);
    if (!live.rows[0]) throw new PushError('Phiên đăng nhập đã hết hạn.', 401);
    const existing = await client.query('SELECT id,user_id FROM push_subscriptions WHERE endpoint=$1', [subscription.endpoint]);
    if (existing.rows[0] && existing.rows[0].user_id !== userId) throw new PushError('Thiết bị đang gắn với tài khoản khác. Tắt đăng ký trên trình duyệt rồi đăng ký lại.', 409);
    const count = await client.query('SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id=$1', [userId]);
    if (!existing.rows[0] && count.rows[0].count >= 12) throw new PushError('Đã đăng ký 12 thiết bị. Xóa bớt một thiết bị để thêm.', 409);
    await client.query(`INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,keys,name,cursor_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,(SELECT COALESCE(max(id),0) FROM surveillance_notifications))
      ON CONFLICT(endpoint) DO UPDATE SET session_hash=EXCLUDED.session_hash,keys=EXCLUDED.keys,name=EXCLUDED.name,
      cursor_id=GREATEST(push_subscriptions.cursor_id,EXCLUDED.cursor_id),created_at=EXCLUDED.created_at,updated_at=now(),last_error=NULL`,
      [randomUUID(),userId,sessionHash,subscription.endpoint,JSON.stringify(subscription.keys),name]);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  return pushSnapshot(userId, sessionHash);
}

export type PushTransport = (subscription: BrowserSubscription, payload: object, vapid: Vapid) => Promise<void>;
/** Durable outbox; cursor is diagnostic only because sequence allocation is not commit order. */
export class PushDeliveryService {
  private running = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private warnedAt = 0;
  constructor(private transport: PushTransport = deliverWebPush, private allowed = profileNotificationsAllowed) {}

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.enqueue();
      // Reclaim interrupted sends; at most 3 attempts and 10 minutes of backlog.
      await pool.query(`UPDATE push_deliveries SET state='pending' WHERE state='sending' AND claimed_at<now()-interval '30 seconds' AND attempts<3`);
      await pool.query(`UPDATE push_deliveries SET state='failed',last_error='expired' WHERE state IN ('pending','sending') AND (attempts>=3 OR created_at<now()-interval '10 minutes')`);
      for (let i = 0; i < 8 && !this.stopped; i++) {
        const { rows } = await pool.query(`UPDATE push_deliveries SET state='sending',attempts=attempts+1,claimed_at=now()
          WHERE id=(SELECT id FROM push_deliveries WHERE state='pending' AND next_attempt_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,attempts`);
        if (!rows[0]) break;
        await this.deliver(rows[0].id, rows[0].attempts);
      }
      await pool.query(`DELETE FROM push_subscriptions p USING auth_sessions s WHERE p.session_hash=s.token_hash AND s.expires_at<=now()`);
      await pool.query(`DELETE FROM push_deliveries WHERE state IN ('sent','skipped','failed') AND created_at<now()-interval '7 days'`);
    } catch { if(Date.now()-this.warnedAt>60000){this.warnedAt=Date.now();console.warn('[push] delivery queue unavailable');} }
    finally { this.running = false; }
  }
  private async enqueue(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT p.id,p.cursor_id,p.created_at FROM push_subscriptions p JOIN auth_sessions s ON s.token_hash=p.session_hash
        WHERE s.expires_at>now() AND EXISTS (SELECT 1 FROM surveillance_notifications n
          WHERE n.created_at>=p.created_at AND n.created_at>now()-interval '10 minutes'
          AND NOT EXISTS(SELECT 1 FROM push_deliveries d WHERE d.subscription_id=p.id AND d.notification_id=n.id))
        ORDER BY p.id FOR UPDATE OF p SKIP LOCKED LIMIT 64`);
      for (const sub of rows) {
        // A lower sequence ID may become visible after a higher ID has committed.
        const notices = await client.query(`SELECT n.id FROM surveillance_notifications n
          WHERE n.created_at>now()-interval '10 minutes' AND n.created_at>=(SELECT created_at FROM push_subscriptions WHERE id=$1)
          AND NOT EXISTS(SELECT 1 FROM push_deliveries d WHERE d.subscription_id=$1 AND d.notification_id=n.id)
          ORDER BY n.id ASC LIMIT 100`, [sub.id]);
        if (!notices.rows.length) continue;
        const ids = notices.rows.map((n: any) => n.id);
        if (ids.length) await client.query(`INSERT INTO push_deliveries(subscription_id,notification_id) SELECT $1,id FROM surveillance_notifications WHERE id=ANY($2::bigint[]) ON CONFLICT DO NOTHING`, [sub.id, ids]);
        await client.query('UPDATE push_subscriptions SET cursor_id=GREATEST(cursor_id,$1) WHERE id=$2', [notices.rows[notices.rows.length-1].id, sub.id]);
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  async deliver(id: string, attempts: number): Promise<void> {
    // Recheck live ownership immediately before each external send, including retries.
    const { rows } = await pool.query(`SELECT d.id,d.subscription_id,p.endpoint,p.keys,p.user_id,n.*,c.name AS camera_name,
      pref.enabled,pref.timezone,pref.quiet_enabled,pref.quiet_start,pref.quiet_end,pref.snooze_until
      FROM push_deliveries d JOIN push_subscriptions p ON p.id=d.subscription_id JOIN auth_sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
      JOIN surveillance_notifications n ON n.id=d.notification_id JOIN cameras c ON c.id=n.camera_id
      LEFT JOIN push_preferences pref ON pref.user_id=p.user_id
      WHERE d.id=$1 AND d.state='sending' AND s.expires_at>now() AND n.created_at>=p.created_at AND n.created_at>now()-interval '10 minutes'`, [id]);
    const row = rows[0];
    if (!row || !pushAllowed(row.enabled === null || row.enabled === undefined ? pushPreferenceDefaults() : preferences(row), new Date(), this.allowed())) {
      await pool.query("UPDATE push_deliveries SET state='skipped',last_error='notifications_paused' WHERE id=$1", [id]); return;
    }
    try {
      const subscription = validatePushSubscription({ endpoint: row.endpoint, keys: row.keys });
      const keys=await pushVapid();
      if(this.stopped)return;
      await this.transport(subscription, pushNoticePayload(row), keys);
      await pool.query("UPDATE push_deliveries SET state='sent',last_error=NULL WHERE id=$1", [id]);
      await pool.query('UPDATE push_subscriptions SET last_success_at=now(),last_error=NULL WHERE id=$1', [row.subscription_id]);
    } catch (err) {
      const status = err instanceof PushError ? err.status : 503, code = err instanceof PushError ? err.code ?? 'push_error' : 'push_error';
      if (status === 404 || status === 410) { await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [row.subscription_id]); return; }
      const retry = shouldRetryPush(status, attempts);
      await pool.query("UPDATE push_deliveries SET state=$2,last_error=$3,next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1", [id,retry?'pending':'failed',code,attempts===1?15:60]);
      await pool.query('UPDATE push_subscriptions SET last_error=$2 WHERE id=$1', [row.subscription_id, code]);
    }
  }
  start(): this { void this.tick(); this.timer=setInterval(()=>void this.tick(),3000); this.timer.unref(); return this; }
  stop(): void { this.stopped=true; if (this.timer) clearInterval(this.timer); }
}
export const startPushDelivery = () => new PushDeliveryService().start();

export async function sendPushTest(userId: number, sessionHash: string, id: string, transport: PushTransport = deliverWebPush) {
  const { rows } = await pool.query(`SELECT p.endpoint,p.keys,p.id,pref.enabled,pref.timezone,pref.quiet_enabled,pref.quiet_start,pref.quiet_end,pref.snooze_until
    FROM push_subscriptions p JOIN auth_sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
    LEFT JOIN push_preferences pref ON pref.user_id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND p.session_hash=$3 AND s.expires_at>now()`, [id,userId,sessionHash]);
  const row=rows[0];
  if (!row) throw new PushError('Thiết bị không thuộc phiên đăng nhập này.',404);
  if (!pushAllowed(row.enabled===null||row.enabled===undefined?pushPreferenceDefaults():preferences(row),new Date(),profileNotificationsAllowed())) throw new PushError('Thông báo đang tắt, tạm hoãn hoặc trong giờ yên lặng.',409);
  try {
    await transport(validatePushSubscription(row), { version:1,title:'Camera Station',body:'Thông báo thử từ máy chủ.',url:'/settings#push',tag:'camera-push-test',silent:true,subscription_id:row.id }, await pushVapid());
  } catch (err) {
    if (err instanceof PushError && [404,410].includes(err.status)) await pool.query('DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2',[id,userId]);
    throw new PushError('Dịch vụ push chưa nhận thông báo thử. Kiểm tra đăng ký và thử lại.',503);
  }
}
