import fs from 'fs';
import path from 'path';
import { constants, createHash, createPublicKey, publicEncrypt, randomUUID } from 'crypto';
import { config } from '../config';

export interface TendaAccountStatus {
  available: boolean;
  state: 'unavailable' | 'login_required' | 'connected' | 'signing_in' | 'refreshing' | 'retrying';
  account_label: string;
  expires_at: number | null;
  auto_refresh: boolean;
  sdk_ready: boolean;
  error?: string;
}
export class AccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const messages: Record<string, string> = {
  account_rejected: 'Tenda chưa chấp nhận phiên đăng nhập. Kiểm tra tài khoản, mật khẩu và vùng đăng ký trên TDSEE.',
  account_owner_mismatch: 'Hãy dùng tài khoản TDSEE đang sở hữu các camera đã liên kết.',
  account_busy: 'Dừng mic hoặc còi và chờ lệnh điều khiển hoàn tất trước khi đăng nhập.',
  account_cancelled: 'Đã hủy đăng nhập Tenda.',
  account_rate_limited: 'Đã thử quá nhanh. Chờ một phút rồi thử lại.',
  account_network: 'Chưa kết nối được Tenda. Kiểm tra Internet của máy chủ.',
  account_configuration_changed: 'Cấu hình máy chủ vừa thay đổi. Hãy thử lại.',
};
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const states = new Set(['unavailable', 'login_required', 'connected', 'signing_in', 'refreshing', 'retrying']);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function read(file: string): any {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid account record');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function directory(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid account directory');
}
export function validateAccountInput(body: any): { account: string; password: string } {
  if (!body || typeof body.account !== 'string' || typeof body.password !== 'string') throw new AccountError(400, 'Nhập tài khoản và mật khẩu TDSEE.');
  const account = body.account.trim(), password = body.password;
  if (account.length > 254 || !/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|[0-9]{6,20})$/.test(account)) throw new AccountError(400, 'Dùng email hoặc số điện thoại đã đăng ký TDSEE.');
  if (Buffer.byteLength(password) < 1 || Buffer.byteLength(password) > 128 || password.includes('\0')) throw new AccountError(400, 'Mật khẩu cần từ 1 đến 128 byte.');
  return { account, password };
}
export class TendaAccount {
  private busy = false;
  private records = new Map<string, any>();
  constructor(private base = path.join(config.storageRoot, '.tenda-talk')) {}
  private record(name: string) {
    try {
      const value = read(path.join(this.base, name)); this.records.set(name, value); return value;
    } catch (error) {
      const value = this.records.get(name);
      if (['ENOENT', 'EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') && value && Number.isSafeInteger(value.updated_at) && Math.abs(Date.now() - value.updated_at) < 3000) return value;
      this.records.delete(name); throw error;
    }
  }
  private snapshot() {
    directory(this.base);
    const gateway = this.record('status.json');
    const value = this.record('account-status.json');
    if (!guid.test(value.instance) || value.version !== 1 || value.instance !== gateway.instance || !Number.isSafeInteger(value.updated_at) || Math.abs(Date.now() - value.updated_at) >= 3000 || !Number.isSafeInteger(gateway.updated_at) || Math.abs(Date.now() - gateway.updated_at) >= 3000 || !states.has(value.state)) throw new Error('Account adapter unavailable');
    return value;
  }
  status(): TendaAccountStatus {
    try {
      const value = this.snapshot();
      // Only masked labels are accepted. Never forward arbitrary native fields.
      const label = typeof value.account_label === 'string' && value.account_label.length <= 254 && value.account_label.includes('***') ? value.account_label : '';
      return { available: value.state !== 'unavailable', state: value.state, account_label: label, expires_at: Number.isSafeInteger(value.expires_at) && value.expires_at > 0 ? value.expires_at : null, auto_refresh: value.auto_refresh === true, sdk_ready: value.sdk_ready === true, ...(messages[value.error] ? { error: messages[value.error] } : {}) };
    } catch { return { available: false, state: 'unavailable', account_label: '', expires_at: null, auto_refresh: false, sdk_ready: false }; }
  }
  async login(input: { account: string; password: string }, signal: AbortSignal, authorized: () => Promise<boolean>): Promise<void> {
    if (this.busy) throw new AccountError(409, 'Máy chủ đang xử lý đăng nhập Tenda.');
    this.busy = true;
    let job: string | undefined, heartbeat: NodeJS.Timeout | undefined;
    let pulseValid = true;
    let authorizedAt = 0;
    const stop = () => { pulseValid = false; if (job) try { fs.writeFileSync(path.join(job, 'stop'), '', { mode: 0o600 }); } catch {} };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (signal.aborted || !await authorized()) throw new AccountError(403, 'Phiên quản trị đã kết thúc. Đăng nhập lại.');
      authorizedAt = Date.now();
      const gateway = this.snapshot(), jwk = gateway.public_key;
      if (!jwk || jwk.kty !== 'RSA' || !/^[A-Za-z0-9_-]{342}$/.test(jwk.n) || jwk.e !== 'AQAB' || jwk.kid !== createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('hex')) throw new AccountError(503, 'Máy chủ chưa sẵn sàng nhận đăng nhập Tenda.');
      const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      const password = Buffer.from(input.password, 'utf8');
      let ciphertext: string;
      try { ciphertext = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, password).toString('base64'); }
      finally { password.fill(0); input.password = ''; }
      const accountRoot = path.join(this.base, 'account'); directory(accountRoot);
      job = path.join(accountRoot, randomUUID()); fs.mkdirSync(job, { mode: 0o700 });
      const pulse = () => {
        if (!pulseValid || !job) return;
        if (signal.aborted || Date.now() - authorizedAt >= 1500) { stop(); return; }
        try {
          fs.writeFileSync(path.join(job, 'heartbeat.tmp'), JSON.stringify({ instance: gateway.instance, updated_at: Date.now() }), { mode: 0o600 });
          fs.renameSync(path.join(job, 'heartbeat.tmp'), path.join(job, 'heartbeat.json'));
        } catch { stop(); }
      };
      pulse(); heartbeat = setInterval(pulse, 250);
      fs.writeFileSync(path.join(job, 'command.tmp'), JSON.stringify({ version: 1, kind: 'login', instance: gateway.instance, created_at: Date.now(), account: input.account, kid: jwk.kid, password_ciphertext: ciphertext }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(path.join(job, 'command.tmp'), path.join(job, 'command.json'));
      let checkedAt = 0;
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        if (signal.aborted || !pulseValid) throw new AccountError(409, messages.account_cancelled);
        if (Date.now() - checkedAt >= 1000) {
          if (!await authorized()) throw new AccountError(403, 'Phiên quản trị đã kết thúc. Đăng nhập lại.');
          authorizedAt = Date.now();
          checkedAt = Date.now();
          if (this.snapshot().instance !== gateway.instance) throw new AccountError(503, 'Dịch vụ Tenda vừa khởi động lại. Hãy thử lại.');
        }
        let result;
        try { result = read(path.join(job, 'result.json')); } catch {}
        if (result) {
          if (result.ok !== true) throw new AccountError(result.error === 'account_busy' ? 409 : result.error === 'account_rate_limited' ? 429 : result.error === 'account_network' ? 503 : 422, messages[result.error] ?? 'Chưa đăng nhập được Tenda. Hãy thử lại sau.');
          return;
        }
        await delay(80);
      }
      throw new AccountError(504, 'Tenda chưa phản hồi. Hãy thử lại sau.');
    } catch (error) {
      stop();
      throw error instanceof AccountError ? error : new AccountError(503, 'Dịch vụ đăng nhập Tenda trên máy chủ chưa sẵn sàng.');
    } finally {
      input.password = '';
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener('abort', stop);
      if (job) { const cleanup = setTimeout(() => { try { fs.rmSync(job!, { recursive: true, force: true }); } catch {} }, 15000); cleanup.unref(); }
      this.busy = false;
    }
  }
}
export const tendaAccount = new TendaAccount();
