import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { config } from './config';

export interface JwtPayload {
  sub: number;
  username: string;
  role: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: 'HS256',
    jwtid: randomUUID(),
    issuer: 'camera-station',
    audience: 'camera-station',
    expiresIn: config.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const claims = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'], issuer: 'camera-station', audience: 'camera-station',
  });
  if (typeof claims === 'string' || !Number.isInteger(claims.sub) || typeof claims.username !== 'string' || typeof claims.role !== 'string' || !claims.jti || !claims.exp) {
    throw new Error('Invalid session claims');
  }
  return claims as unknown as JwtPayload;
}
