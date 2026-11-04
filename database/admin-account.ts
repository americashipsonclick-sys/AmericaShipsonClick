/**
 * Administrator credential provisioning.
 *
 * Public signup cannot mint an administrator any more — the route refuses the
 * role and migration 0012 refuses the row — so the account has to come from
 * somewhere an operator controls. That somewhere is this module: set
 * ADMIN_PASSWORD in the environment and the account named by ADMIN_EMAIL is
 * created with it, or has its password brought in line with it, every time the
 * server starts.
 *
 * This runs on the owner connection, alongside migrations, for the same reason
 * seeding does: the runtime role is not allowed to write an admin row, which
 * is precisely the property being relied on.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { Database } from './client';

const DEFAULT_ADMIN_EMAIL = 'admin@americashipsonclick.com';

/** The demo credential. Refused as an ADMIN_PASSWORD: it is published in this repo. */
const KNOWN_DEMO_PASSWORD = 'password123';

const MIN_PASSWORD_LENGTH = 8;

export type AdminAccountOutcome =
  | { status: 'skipped' }
  | { status: 'created'; email: string }
  | { status: 'rotated'; email: string; sessionsRevoked: number }
  | { status: 'unchanged'; email: string };

/**
 * Applies ADMIN_PASSWORD to the administrator account.
 *
 * A no-op when ADMIN_PASSWORD is unset, so demo installs keep working exactly
 * as before. Throws on a password that should not be trusted with the ledger —
 * a server that boots with a guessable admin credential is worse than one that
 * refuses to boot, because nothing about it looks wrong from the outside.
 */
export async function ensureAdminAccount(db: Database): Promise<AdminAccountOutcome> {
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (password === '') return { status: 'skipped' };

  const email = (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters ` +
      `(got ${password.length}). This credential opens the settlement ledger ` +
      'and every carrier identity in it.'
    );
  }

  if (password === KNOWN_DEMO_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD is set to the demo password, which is published in this ' +
      'repository. Choose a different value.'
    );
  }

  return db.transaction(async tx => {
    const existing = await tx.query<{ id: string; role: string; password_hash: string | null }>(
      'SELECT id, role, password_hash FROM users WHERE lower(email) = $1',
      [email]
    );
    const row = existing.rows[0];

    if (!row) {
      const id = `usr-${crypto.randomBytes(9).toString('base64url')}`;
      await tx.query(
        'INSERT INTO users (id, role, email, password_hash) VALUES ($1, $2, $3, $4)',
        [id, 'admin', email, await bcrypt.hash(password, 10)]
      );
      return { status: 'created', email } as const;
    }

    // bcrypt salts every hash, so re-hashing would produce a different digest
    // on every boot and rewrite the row each time. Compare against the stored
    // hash instead, and leave it alone when the credential already matches —
    // otherwise a restart would end the administrator's session.
    if (row.role === 'admin' && row.password_hash && await bcrypt.compare(password, row.password_hash)) {
      return { status: 'unchanged', email } as const;
    }

    await tx.query(
      "UPDATE users SET role = 'admin', password_hash = $2, updated_at = now() WHERE id = $1",
      [row.id, await bcrypt.hash(password, 10)]
    );

    // A rotated password that leaves old sessions alive has not been rotated.
    // Mirrors what app_change_password does on the signed-in path.
    const revoked = await tx.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_change'
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [row.id]
    );

    return { status: 'rotated', email, sessionsRevoked: revoked.rows.length } as const;
  }, { role: 'admin', userId: 'provisioning' });
}
