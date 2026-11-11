import { Request, Response, NextFunction } from 'express';

export function isWrite(method: string) { return !['GET', 'HEAD', 'OPTIONS'].includes(method); }

/** All browser writes require a same-origin custom header; authenticated writes
 * additionally require a session-bound CSRF token in requireAuth. No public CORS. */
export function browserRequestGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('Origin');
  if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return;
  }
  if (isWrite(req.method) && !req.get('Authorization') && req.get('X-Requested-With') !== 'CameraStation') {
    res.status(403).json({ error: 'Missing request protection header' }); return;
  }
  next();
}

// No permanent account lockout: a burst is rejected until the rolling window ends.
export function loginLimiter(maxAttempts = 10, windowMs = 60_000, now = Date.now) {
  const attempts = new Map<string, { count: number; until: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const time = now();
    for (const [ip, value] of attempts) if (value.until <= time) attempts.delete(ip);
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const value = attempts.get(key) ?? { count: 0, until: time + windowMs };
    if (value.count >= maxAttempts || (attempts.size >= 10_000 && !attempts.has(key))) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((value.until - time) / 1000))));
      res.status(429).json({ error: 'Thử đăng nhập quá nhiều lần. Vui lòng chờ một phút.' }); return;
    }
    value.count++; attempts.set(key, value); next();
  };
}
