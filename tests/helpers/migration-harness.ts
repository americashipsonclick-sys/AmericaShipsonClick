/**
 * Applies the real migration files to a throwaway embedded database.
 *
 * Tests run against the same SQL production runs — not a hand-maintained
 * fixture schema — so a migration that does not apply fails the suite instead
 * of failing a deploy.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable, SessionContext } from '../../database';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const MIGRATIONS_DIR = path.join(process.cwd(), 'database', 'migrations');

export function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

export interface Harness {
  pg: PGlite;
  dataDir: string;
  destroy(): Promise<void>;
}

/** Fresh database with every migration applied, in a temp directory. */
export async function createMigratedDatabase(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asoc-test-'));
  const pg = new PGlite(dataDir);

  // The real runner creates this ledger before the first migration; 0002 grants
  // SELECT on it, so it has to exist here too.
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    try {
      await pg.exec(sql);
    } catch (err: any) {
      await pg.close();
      throw new Error(`Migration ${file} failed to apply: ${err.message}`);
    }
  }

  return {
    pg,
    dataDir,
    async destroy() {
      await pg.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

/**
 * The `Database` contract over a harness, running as the app's runtime role so
 * Row-Level Security and the table grants apply, as they do in production.
 * With `asOwner` it stays the owner, like the connection migrations use.
 */
export function harnessDatabase(h: Harness, options: { asOwner?: boolean } = {}): Database {
  const transaction = <T>(fn: (tx: Queryable) => Promise<T>, ctx: SessionContext = { role: 'anon' }) =>
    h.pg.transaction(async tx => {
      await tx.query(
        `SELECT set_config('app.user_role', $1, true), set_config('app.user_id', $2, true),
                set_config('app.driver_id', $3, true), set_config('app.shipper_id', $4, true)`,
        [ctx.role, ctx.userId ?? '', ctx.driverId ?? '', ctx.shipperId ?? '']
      );
      if (!options.asOwner) await tx.exec('SET LOCAL ROLE asoc_app');
      return fn({
        query: async (sql: string, params?: unknown[]) => {
          const res = await tx.query<any>(sql, params as any[]);
          return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
        },
        exec: async (sql: string) => {
          await tx.exec(sql);
        }
      } as Queryable);
    }) as Promise<T>;

  const database: Database = {
    driver: 'pglite',
    description: 'test harness',
    query: (sql, params) => transaction(tx => tx.query(sql, params)),
    exec: sql => transaction(tx => tx.exec(sql)),
    transaction,
    as: ctx => ({
      query: (sql, params) => transaction(tx => tx.query(sql, params), ctx),
      exec: sql => transaction(tx => tx.exec(sql), ctx),
      transaction: fn => transaction(fn, ctx)
    }),
    close: async () => {}
  };
  return database;
}
