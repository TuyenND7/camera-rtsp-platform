import { Request, Response, NextFunction } from 'express';
import { JwtPayload } from '../auth';
import { requestToken, sessionUser, validCsrf } from '../sessions';
import { isWrite } from './security';

export interface AuthedRequest extends Request {
  user?: JwtPayload;
  sessionToken?: string;
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store');
  const credential = requestToken(req);
  if (!credential) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const user = await sessionUser(credential.token);
    if (!user) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
    if (!credential.bearer && isWrite(req.method) && !validCsrf(credential.token, req.get('X-CSRF-Token'))) {
      res.status(403).json({ error: 'Invalid CSRF token' }); return;
    }
    req.user = user; req.sessionToken = credential.token;
    next();
  } catch {
    res.status(503).json({ error: 'Session verification unavailable' });
  }
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Administrator access required' }); return; }
  next();
}
