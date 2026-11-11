import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { JwtPayload, signToken, verifyToken } from './auth';
import { pool } from './db';

export const SESSION_COOKIE = 'camera_session';
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function csrfToken(token: string) { return createHmac('sha256', config.jwtSecret).update(`csrf:${token}`).digest('hex'); }
export function validCsrf(token: string, supplied: string | undefined) {
  const expected = csrfToken(token);
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function requestToken(req: Request): { token: string; bearer: boolean } | null {
  const header = req.get('Authorization');
  if (header !== undefined) return /^Bearer [A-Za-z0-9_.-]+$/.test(header) && header.length < 4096 ? { token: header.slice(7), bearer: true } : null;
  const cookies = (req.get('Cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  // Reject ambiguous cookies rather than allowing a second cookie to override a session.
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_.-]+$/.test(token) && token.length < 4096 ? { token, bearer: false } : null;
}

export async function createSession(user: JwtPayload) {
  const token = signToken(user);
  const expiry = new Date((jwt.decode(token) as jwt.JwtPayload).exp! * 1000);
  await pool.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
  await pool.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), user.sub, expiry]);
  return { token, expiresAt: expiry, csrf: csrfToken(token) };
}

export async function sessionUser(token: string): Promise<JwtPayload | null> {
  let claims: JwtPayload;
  try { claims = verifyToken(token); } catch { return null; }
  const { rows } = await pool.query(
    'SELECT u.id, u.username, u.role FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.user_id = $2 AND s.expires_at > now()',
    [tokenHash(token), claims.sub],
  );
  return rows[0] ? { sub: rows[0].id, username: rows[0].username, role: rows[0].role } : null;
}

export async function revokeSession(token: string) { await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]); }
function cookieOptions(req: Request) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSecure || req.secure, path: '/' };
}
export function setSessionCookie(req: Request, res: Response, token: string, expires: Date) { res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), expires }); }
export function clearSessionCookie(req: Request, res: Response) { res.clearCookie(SESSION_COOKIE, cookieOptions(req)); }
