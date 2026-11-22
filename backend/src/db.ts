import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Chạy schema.sql (idempotent) và seed tài khoản admin nếu chưa có.
 */
export async function initDb(): Promise<void> {
  // dist/schema.sql (Docker) hoặc ../src/schema.sql (chạy local sau tsc)
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', 'src', 'schema.sql'),
  ];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    throw new Error('schema.sql not found in: ' + candidates.join(', '));
  }
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
  for (const feature of ['system', 'operations', 'evidence']) {
    const candidates = [path.join(__dirname,feature,'schema.sql'),path.join(__dirname,'..','src',feature,'schema.sql')];
    const file = candidates.find(candidate => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing ${feature} database migration`);
    await pool.query(fs.readFileSync(file,'utf8'));
  }

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [config.adminUsername]
  );
  if (rows.length === 0) {
    const hash = await bcrypt.hash(config.adminPassword, 10);
    await pool.query(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
      [config.adminUsername, hash, 'admin']
    );
    console.log(`[db] Seeded admin user "${config.adminUsername}"`);
  }
}

/** Thử kết nối DB có retry (đợi postgres sẵn sàng). */
export async function waitForDb(retries = 20, delayMs = 2000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] waiting for postgres... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Cannot connect to database');
}
