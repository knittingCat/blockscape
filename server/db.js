import 'dotenv/config';
import pg from 'pg';

// TABLE_PREFIX lets the automated tests use their own throw-away tables in the same database.
export const PREFIX = process.env.TABLE_PREFIX || '';
const t = (name) => `${PREFIX}${name}`;
export const T = { users: t('users'), sessions: t('sessions'), dioramas: t('dioramas'), unlocks: t('unlocks'), reports: t('reports') };

function connectionString() {
  const raw = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set (see README: Running the server)');
  // pg treats sslmode itself; we set ssl explicitly below
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  return u.toString();
}

export const pool = new pg.Pool({
  connectionString: connectionString(),
  ssl: { rejectUnauthorized: true },
  max: 4,
  idleTimeoutMillis: 5000, // let connections close quickly so Neon can scale to zero
  connectionTimeoutMillis: 15000,
});
pool.on('error', (err) => console.error('[db]', err.message));

export const query = (text, params) => pool.query(text, params);

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${T.users} (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      gallery_code_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${T.sessions} (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${T.dioramas} (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      thumb TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      code_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ${T.dioramas}_owner ON ${T.dioramas}(owner_id);
    CREATE TABLE IF NOT EXISTS ${T.unlocks} (
      user_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, target_id)
    );
    CREATE TABLE IF NOT EXISTS ${T.reports} (
      id SERIAL PRIMARY KEY,
      diorama_id INTEGER NOT NULL REFERENCES ${T.dioramas}(id) ON DELETE CASCADE,
      reporter_id INTEGER NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (diorama_id, reporter_id)
    );
  `);
}

export async function dropAll() {
  if (!PREFIX) throw new Error('refusing to drop tables without TABLE_PREFIX');
  await query(`DROP TABLE IF EXISTS ${T.reports}, ${T.unlocks}, ${T.dioramas}, ${T.sessions}, ${T.users} CASCADE`);
}
