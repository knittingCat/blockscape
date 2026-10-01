import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(secret, salt, 32);
  return `s1:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifySecret(secret, stored) {
  if (!stored || !stored.startsWith('s1:')) return false;
  const [, saltHex, keyHex] = stored.split(':');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(secret, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('hex');

export const RESERVED = new Set(['admin', 'administrator', 'root', 'moderator', 'mod', 'system', 'blockscape', 'neon', 'support', 'staff']);

export function checkUsername(name) {
  if (typeof name !== 'string') return 'Pick a username.';
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return 'Usernames are 3–20 letters, numbers or underscores.';
  if (RESERVED.has(name)) return 'That username is not available.';
  return null;
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwords need at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

// Tiny in-memory rate limiter (per server process; fine for a small class site).
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.status(429).json({ error: 'Too many tries. Please wait a few minutes and try again.' });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}
