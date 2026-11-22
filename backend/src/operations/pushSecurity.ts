import dns from 'dns/promises';
import net from 'net';
import https from 'https';
import { ECDH } from 'crypto';
import * as webpush from 'web-push';
import { clockMinutes, localClock, validTimezone } from './profiles';

export interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPreferences { enabled: boolean; timezone: string; quiet_enabled: boolean; quiet_start: string; quiet_end: string; snooze_until: string | null }
export const pushPreferenceDefaults = (): PushPreferences => ({ enabled: true, timezone: 'Asia/Ho_Chi_Minh', quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00', snooze_until: null });
export class PushError extends Error { constructor(message: string, readonly status = 400, readonly code?: string) { super(message); } }
export function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length < 20 || endpoint.length > 2048) return false;
  try {
    const u = new URL(endpoint), h = u.hostname;
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443') && u.pathname !== '/' &&
      (h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com' || /^(?:[a-z0-9-]+\.)*push\.apple\.com$/.test(h) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(h));
  } catch { return false; }
}
export function validatePushSubscription(raw: unknown): BrowserSubscription {
  const v = raw as any;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !validPushEndpoint(v.endpoint) || !v.keys || typeof v.keys !== 'object') throw new PushError('Trình duyệt chưa cung cấp địa chỉ nhận thông báo hợp lệ.');
  const key = v.keys.p256dh, auth = v.keys.auth;
  if (typeof key !== 'string' || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{86,88}={0,2}$/.test(key) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)) throw new PushError('Khóa đăng ký thông báo không hợp lệ.');
  try {
    const point = Buffer.from(key, 'base64url');
    if (point.length !== 65 || point[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) throw new Error();
    ECDH.convertKey(point, 'prime256v1');
  } catch { throw new PushError('Khóa đăng ký thông báo không hợp lệ.'); }
  return { endpoint: v.endpoint, keys: { p256dh: key.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') } };
}
export function publicInternetAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Limit IPv6 to global unicast; exclude documentation, IPv4 tunnels/mapping.
  return net.isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0{1,4}:|0?db8:)/i.test(address) && !/^2002:/i.test(address);
}
export function validatePushPreferences(raw: unknown): Omit<PushPreferences, 'snooze_until'> {
  const v = raw as any, keys = ['enabled', 'timezone', 'quiet_enabled', 'quiet_start', 'quiet_end'];
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !(k in v)) ||
    typeof v.enabled !== 'boolean' || typeof v.quiet_enabled !== 'boolean' || !validTimezone(v.timezone) || clockMinutes(v.quiet_start) === null || clockMinutes(v.quiet_end) === null || v.quiet_start === v.quiet_end) throw new PushError('Giờ yên lặng hoặc múi giờ không hợp lệ.');
  return { enabled: v.enabled, timezone: v.timezone, quiet_enabled: v.quiet_enabled, quiet_start: v.quiet_start, quiet_end: v.quiet_end };
}
export function pushAllowed(preferences: PushPreferences, at = new Date(), profileAllowed = true): boolean {
  if (!profileAllowed || !preferences.enabled || (preferences.snooze_until && Date.parse(preferences.snooze_until) > at.getTime())) return false;
  if (!preferences.quiet_enabled) return true;
  const start = clockMinutes(preferences.quiet_start), end = clockMinutes(preferences.quiet_end);
  if (start === null || end === null || !validTimezone(preferences.timezone)) return false;
  const minute = localClock(at, preferences.timezone).minute;
  return !(start < end ? minute >= start && minute < end : minute >= start || minute < end);
}

/** DNS is checked and pinned to the HTTPS socket; never follow redirects. */
export async function deliverWebPush(subscription: BrowserSubscription, payload: object, vapid: { publicKey: string; privateKey: string; subject: string }): Promise<void> {
  if (!validPushEndpoint(subscription.endpoint)) throw new PushError('Địa chỉ push bị từ chối.', 400, 'invalid_endpoint');
  const url = new URL(subscription.endpoint);
  let timeout: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    dns.lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new PushError('Không phân giải được máy chủ push.', 503, 'dns_timeout')), 3000); }),
  ]).finally(() => clearTimeout(timeout));
  if (!addresses.length || addresses.some(a => !publicInternetAddress(a.address))) throw new PushError('Địa chỉ push bị từ chối.', 400, 'private_address');
  const address = addresses.find(a => a.family === 4) ?? addresses[0];
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'normal', contentEncoding: 'aes128gcm', vapidDetails: vapid });
  await new Promise<void>((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers: details.headers, agent: false, family: address.family,
      lookup: ((_host: string, options: any, callback: any) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any }, response => {
      // Provider bodies can contain endpoint tokens; discard rather than log/store.
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
      else reject(new PushError('Dịch vụ push chưa nhận thông báo.', response.statusCode ?? 503, `provider_${response.statusCode ?? 'error'}`));
    });
    const deadline = setTimeout(() => request.destroy(new Error('push_timeout')), 8000);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', () => reject(new PushError('Chưa kết nối được dịch vụ push.', 503, 'transport_error')));
    request.end(details.body);
  });
}
