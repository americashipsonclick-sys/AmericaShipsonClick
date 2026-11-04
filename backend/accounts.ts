/**
 * Account creation shared by password signup and Continue with Google, so both
 * produce the same rows and neither can drift into a lighter kind of account.
 */
import type { Queryable } from '../database';
import { newId, tokenizeBankAccount } from './security';

export interface NewAccount {
  email: string;
  role: 'driver' | 'shipper';
  name: string;
  /** Null for a Google-only account. */
  passwordHash: string | null;
  phone?: string;
  homeCity?: string;
  homeState?: string;
  companyName?: string;
}

export interface CreatedAccount {
  userId: string;
  driverId?: string;
  shipperId?: string;
}

/** Writes the user row and its role profile. Run inside a transaction. */
export async function createAccountRows(tx: Queryable, account: NewAccount): Promise<CreatedAccount> {
  const userId = newId('usr');

  await tx.query(
    'INSERT INTO users (id, role, email, phone, password_hash) VALUES ($1, $2, $3, $4, $5)',
    [userId, account.role, account.email, account.phone || null, account.passwordHash]
  );

  let driverId: string | undefined;
  let shipperId: string | undefined;

  if (account.role === 'driver') {
    driverId = newId('drv');
    await tx.query(`
      INSERT INTO driver_profiles (id, user_id, full_name, home_base_city, home_base_state, verification_status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
    `, [driverId, userId, account.name, account.homeCity || 'Dallas', account.homeState || 'TX']);

    await tx.query(`
      INSERT INTO driver_equipment (id, driver_id, equipment_type, trailer_length_ft)
      VALUES ($1, $2, 'dry_van', 53)
    `, ['eq-' + driverId, driverId]);

    await tx.query(`
      INSERT INTO driver_payment_accounts (id, driver_id, payment_processor, processor_account_id, same_day_funding_opt_in)
      VALUES ($1, $2, 'stripe_connect', $3, TRUE)
    `, ['pay-' + driverId, driverId, tokenizeBankAccount(driverId, newId('pending'))]);
  } else {
    shipperId = newId('shp');
    await tx.query(`
      INSERT INTO shipper_profiles (id, user_id, company_name, billing_email)
      VALUES ($1, $2, $3, $4)
    `, [shipperId, userId, account.companyName || account.name, account.email]);
  }

  return { userId, driverId, shipperId };
}
