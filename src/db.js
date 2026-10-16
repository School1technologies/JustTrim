import pg from 'pg';
// Return dates as plain 'YYYY-MM-DD' strings and numerics as numbers
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(1700, v => parseFloat(v));
pg.types.setTypeParser(20, v => parseInt(v, 10));
const arr = v => v.replace(/[{}]/g, '').split(',').filter(Boolean);
pg.types.setTypeParser(1182, arr);                       // date[]
pg.types.setTypeParser(2951, arr);                       // uuid[]
pg.types.setTypeParser(1007, v => arr(v).map(Number));   // int4[]

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});
export const q = (text, params) => pool.query(text, params);
export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
