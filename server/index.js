import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, T } from './db.js';
import { hashSecret, verifySecret, sha256, newToken, checkUsername, checkPassword, rateLimiter } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'bs_session';
const SESSION_DAYS = 30;
const MAX_DIORAMAS_PER_USER = 50;

const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, isAdmin: u.is_admin, hasGalleryCode: !!u.gallery_code_hash };
}

// Content-Security-Policy that allows exactly the one inline <script type="importmap">
function buildCsp() {
  let hash = '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (m) hash = ` 'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`;
  } catch {}
  return [
    "default-src 'self'",
    `script-src 'self'${hash}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const csp = buildCsp();
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '400kb' }));

  // --- who is asking? ---
  app.use('/api', wrap(async (req, res, next) => {
    // Browsers can't send this header cross-site without CORS approval, which we never give.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'blockscape') {
      return bad(res, 403, 'Forbidden');
    }
    res.setHeader('Cache-Control', 'no-store');
    req.user = null;
    const token = readCookie(req, COOKIE);
    if (token) {
      const { rows } = await query(
        `SELECT u.* FROM ${T.sessions} s JOIN ${T.users} u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [sha256(token)],
      );
      req.user = rows[0] || null;
    }
    next();
  }));
  const needUser = (req, res, next) => (req.user ? next() : bad(res, 401, 'Please sign in first.'));

  async function startSession(req, res, userId) {
    const token = newToken();
    await query(`INSERT INTO ${T.sessions} (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`, [sha256(token), userId]);
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  }

  // --- accounts ---
  app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

  app.post('/api/signup', rateLimiter({ windowMs: 3600e3, max: 10 }), wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = req.body.password;
    const problem = checkUsername(username) || checkPassword(password);
    if (problem) return bad(res, 400, problem);
    let row;
    try {
      const { rows } = await query(`INSERT INTO ${T.users} (username, password_hash) VALUES ($1, $2) RETURNING *`, [username, await hashSecret(password)]);
      row = rows[0];
    } catch (e) {
      if (e.code === '23505') return bad(res, 409, 'That username is taken. Try another.');
      throw e;
    }
    await startSession(req, res, row.id);
    res.json({ user: publicUser(row) });
  }));

  const DUMMY = hashSecret('not-a-real-password');
  app.post('/api/login', rateLimiter({ windowMs: 600e3, max: 15 }), wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const { rows } = await query(`SELECT * FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [username]);
    const user = rows[0];
    const ok = await verifySecret(String(req.body.password || ''), user ? user.password_hash : await DUMMY);
    if (!user || !ok) return bad(res, 401, 'That username and password do not match.');
    await startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await query(`DELETE FROM ${T.sessions} WHERE token_hash = $1`, [sha256(token)]);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  }));

  app.put('/api/me/gallery-code', needUser, wrap(async (req, res) => {
    const code = req.body.code;
    if (code === null || code === '') {
      await query(`UPDATE ${T.users} SET gallery_code_hash = NULL WHERE id = $1`, [req.user.id]);
      await query(`DELETE FROM ${T.unlocks} WHERE kind = 'gallery' AND target_id = $1`, [req.user.id]);
      return res.json({ ok: true, hasGalleryCode: false });
    }
    if (typeof code !== 'string' || code.length < 3 || code.length > 40) return bad(res, 400, 'A code is 3–40 characters.');
    await query(`UPDATE ${T.users} SET gallery_code_hash = $1 WHERE id = $2`, [await hashSecret(code), req.user.id]);
    await query(`DELETE FROM ${T.unlocks} WHERE kind = 'gallery' AND target_id = $1`, [req.user.id]); // everyone must re-enter the new code
    res.json({ ok: true, hasGalleryCode: true });
  }));

  // --- dioramas ---
  const DATA_RE = /^[zr][A-Za-z0-9_-]+$/;
  app.post('/api/dioramas', needUser, wrap(async (req, res) => {
    const { id, data, thumb, visibility } = req.body;
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 80) return bad(res, 400, 'Give your diorama a title (up to 80 characters).');
    if (typeof data !== 'string' || data.length > 250000 || !DATA_RE.test(data)) return bad(res, 400, 'That diorama could not be saved.');
    if (thumb != null && (typeof thumb !== 'string' || thumb.length > 90000 || !thumb.startsWith('data:image/jpeg;base64,'))) return bad(res, 400, 'Bad picture.');
    if (!['private', 'gallery'].includes(visibility)) return bad(res, 400, 'Choose private or gallery.');
    const code = req.body.code;
    if (code != null && code !== '' && (typeof code !== 'string' || code.length < 3 || code.length > 40)) return bad(res, 400, 'A code is 3–40 characters.');

    if (id != null) {
      const { rows } = await query(`SELECT owner_id FROM ${T.dioramas} WHERE id = $1`, [id]);
      if (!rows[0] || rows[0].owner_id !== req.user.id) return bad(res, 404, 'Diorama not found.');
      const sets = ['title = $1', 'data = $2', 'thumb = $3', 'visibility = $4', 'updated_at = NOW()'];
      const params = [title, data, thumb || null, visibility];
      if (code === '' || code === null) sets.push('code_hash = NULL');
      else if (code !== undefined) {
        params.push(await hashSecret(code));
        sets.push(`code_hash = $${params.length}`);
      }
      params.push(id);
      await query(`UPDATE ${T.dioramas} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      if (code !== undefined) await query(`DELETE FROM ${T.unlocks} WHERE kind = 'diorama' AND target_id = $1`, [id]);
      return res.json({ id });
    }
    const { rows: cnt } = await query(`SELECT COUNT(*)::int AS n FROM ${T.dioramas} WHERE owner_id = $1`, [req.user.id]);
    if (cnt[0].n >= MAX_DIORAMAS_PER_USER) return bad(res, 400, `You can keep up to ${MAX_DIORAMAS_PER_USER} dioramas. Delete one first.`);
    const codeHash = code ? await hashSecret(code) : null;
    const { rows } = await query(
      `INSERT INTO ${T.dioramas} (owner_id, title, data, thumb, visibility, code_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.id, title, data, thumb || null, visibility, codeHash],
    );
    res.json({ id: rows[0].id });
  }));

  app.get('/api/dioramas/mine', needUser, wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT id, title, thumb, visibility, (code_hash IS NOT NULL) AS has_code, updated_at FROM ${T.dioramas} WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [req.user.id],
    );
    res.json({ dioramas: rows.map((r) => ({ id: r.id, title: r.title, thumb: r.thumb, visibility: r.visibility, hasCode: r.has_code, updatedAt: r.updated_at })) });
  }));

  const unlocked = async (userId, kind, target) =>
    (await query(`SELECT 1 FROM ${T.unlocks} WHERE user_id = $1 AND kind = $2 AND target_id = $3`, [userId, kind, target])).rowCount > 0;

  app.get('/api/dioramas/:id', needUser, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 404, 'Diorama not found.');
    const { rows } = await query(
      `SELECT d.*, u.username, u.gallery_code_hash AS gallery_hash, u.id AS uid FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.id = $1`,
      [id],
    );
    const d = rows[0];
    if (!d) return bad(res, 404, 'Diorama not found.');
    const mine = d.owner_id === req.user.id;
    if (!mine && !req.user.is_admin) {
      if (d.visibility !== 'gallery') return bad(res, 404, 'Diorama not found.');
      if (d.gallery_hash && !(await unlocked(req.user.id, 'gallery', d.owner_id))) return bad(res, 403, 'This gallery needs a code.', { locked: 'gallery', ownerId: d.owner_id, owner: d.username });
      if (d.code_hash && !(await unlocked(req.user.id, 'diorama', d.id))) return bad(res, 403, 'This diorama needs a code.', { locked: 'diorama', id: d.id, owner: d.username });
    }
    res.json({ id: d.id, title: d.title, data: d.data, owner: d.username, visibility: d.visibility, mine });
  }));

  app.delete('/api/dioramas/:id', needUser, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await query(`SELECT owner_id FROM ${T.dioramas} WHERE id = $1`, [id]);
    if (!rows[0]) return bad(res, 404, 'Diorama not found.');
    if (rows[0].owner_id !== req.user.id && !req.user.is_admin) return bad(res, 403, 'That is not your diorama.');
    await query(`DELETE FROM ${T.dioramas} WHERE id = $1`, [id]);
    res.json({ ok: true });
  }));

  // --- codes ---
  app.post('/api/unlock', needUser, rateLimiter({ windowMs: 600e3, max: 20 }), wrap(async (req, res) => {
    const { kind, id, code } = req.body;
    if (!['gallery', 'diorama'].includes(kind) || !Number.isInteger(id) || typeof code !== 'string') return bad(res, 400, 'Bad request.');
    const { rows } = kind === 'gallery'
      ? await query(`SELECT gallery_code_hash AS h FROM ${T.users} WHERE id = $1`, [id])
      : await query(`SELECT code_hash AS h FROM ${T.dioramas} WHERE id = $1 AND visibility = 'gallery'`, [id]);
    if (!rows[0]) return bad(res, 404, 'Not found.');
    if (rows[0].h && !(await verifySecret(code, rows[0].h))) return bad(res, 403, 'That code is not right.');
    await query(`INSERT INTO ${T.unlocks} (user_id, kind, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.user.id, kind, id]);
    res.json({ ok: true });
  }));

  // --- gallery ---
  const card = (r, lockedForViewer) => ({
    id: r.id,
    title: r.title,
    owner: r.username,
    thumb: lockedForViewer ? null : r.thumb,
    locked: lockedForViewer,
    updatedAt: r.updated_at,
  });

  app.get('/api/gallery', needUser, wrap(async (req, res) => {
    const members = await query(
      `SELECT u.id, u.username, COUNT(d.id)::int AS n, (u.gallery_code_hash IS NOT NULL) AS has_code
       FROM ${T.users} u JOIN ${T.dioramas} d ON d.owner_id = u.id AND d.visibility = 'gallery'
       GROUP BY u.id ORDER BY MAX(d.updated_at) DESC LIMIT 100`,
    );
    const unlockedRows = await query(`SELECT kind, target_id FROM ${T.unlocks} WHERE user_id = $1`, [req.user.id]);
    const open = new Set(unlockedRows.rows.map((r) => `${r.kind}:${r.target_id}`));
    const recent = await query(
      `SELECT d.id, d.title, d.thumb, d.updated_at, d.owner_id, u.username, (d.code_hash IS NOT NULL) AS dcode, (u.gallery_code_hash IS NOT NULL) AS gcode
       FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id WHERE d.visibility = 'gallery' ORDER BY d.updated_at DESC LIMIT 24`,
    );
    res.json({
      members: members.rows.map((m) => ({ username: m.username, count: m.n, locked: m.has_code && m.id !== req.user.id && !open.has(`gallery:${m.id}`) })),
      recent: recent.rows.map((r) => card(r, r.owner_id !== req.user.id && ((r.gcode && !open.has(`gallery:${r.owner_id}`)) || (r.dcode && !open.has(`diorama:${r.id}`))))),
    });
  }));

  app.get('/api/gallery/:username', needUser, wrap(async (req, res) => {
    const { rows: u } = await query(`SELECT id, username, (gallery_code_hash IS NOT NULL) AS has_code FROM ${T.users} WHERE LOWER(username) = LOWER($1)`, [String(req.params.username)]);
    if (!u[0]) return bad(res, 404, 'No one has that username.');
    const own = u[0].id === req.user.id || req.user.is_admin;
    if (u[0].has_code && !own && !(await unlocked(req.user.id, 'gallery', u[0].id))) return res.json({ owner: u[0].username, ownerId: u[0].id, locked: 'gallery' });
    const { rows } = await query(
      `SELECT d.id, d.title, d.thumb, d.updated_at, (d.code_hash IS NOT NULL) AS dcode, u.username FROM ${T.dioramas} d JOIN ${T.users} u ON u.id = d.owner_id
       WHERE d.owner_id = $1 AND d.visibility = 'gallery' ORDER BY d.updated_at DESC`,
      [u[0].id],
    );
    const unlockedRows = await query(`SELECT target_id FROM ${T.unlocks} WHERE user_id = $1 AND kind = 'diorama'`, [req.user.id]);
    const open = new Set(unlockedRows.rows.map((r) => r.target_id));
    res.json({ owner: u[0].username, ownerId: u[0].id, locked: null, dioramas: rows.map((r) => card(r, r.dcode && !own && !open.has(r.id))) });
  }));

  app.post('/api/report', needUser, rateLimiter({ windowMs: 600e3, max: 20 }), wrap(async (req, res) => {
    const id = Number(req.body.dioramaId);
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!Number.isInteger(id) || !reason) return bad(res, 400, 'Tell us briefly what is wrong.');
    const { rows } = await query(`SELECT owner_id FROM ${T.dioramas} WHERE id = $1 AND visibility = 'gallery'`, [id]);
    if (!rows[0]) return bad(res, 404, 'Diorama not found.');
    if (rows[0].owner_id === req.user.id) return bad(res, 400, 'That is your own diorama.');
    await query(`INSERT INTO ${T.reports} (diorama_id, reporter_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, req.user.id, reason]);
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => bad(res, 404, 'Not found'));

  // --- the website itself (explicit allow-list, so server code and .env are never served) ---
  const send = (file) => (req, res) => res.sendFile(path.join(ROOT, file));
  app.get('/', send('index.html'));
  app.get('/index.html', send('index.html'));
  app.get('/style.css', send('style.css'));
  // no-cache = the browser re-checks (cheap ETag request) so a deploy shows up on the next refresh, not 5 minutes later
  app.use('/src', express.static(path.join(ROOT, 'src'), { dotfiles: 'deny', etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  app.use('/vendor', express.static(path.join(ROOT, 'vendor'), { dotfiles: 'deny', maxAge: '7d' }));

  app.use((err, req, res, next) => {
    console.error('[error]', req.method, req.path, err.message);
    if (res.headersSent) return next(err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong on our side. Please try again.' });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Blockscape running at http://localhost:${port}`));
}
