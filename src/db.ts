import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}
