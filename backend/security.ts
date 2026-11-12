/**
 * Security helpers shared by the API layer.
 */
import crypto from 'crypto';
import { isIP } from 'net';
import type { Request } from 'express';
import type { SessionContext } from '../database';
import type { AuthenticatedRequest } from './auth';

/**
 * Secret used to tokenize bank details. Falls back to JWT_SECRET so existing
 * deployments keep working, but rotating it invalidates previously issued
 * tokens, so it is worth setting explicitly.
 */
function paymentTokenSecret(): string {
  const secret = process.env.PAYMENT_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('PAYMENT_TOKEN_SECRET (or JWT_SECRET) must be set to tokenize payment details.');
  }
  return secret;
}

/**
 * Turns routing/account numbers into an opaque, irreversible processor token.
 *
 * HMAC-SHA256, not an encoding: the digest cannot be turned back into the bank
 * details, and without the secret the token cannot be recomputed from guessed
 * account numbers either. The raw numbers are never persisted or logged —
 * `driver_payment_accounts.processor_account_id` additionally carries a CHECK
 * constraint rejecting anything that looks like a bare account number.
 */
export function tokenizeBankAccount(routingNumber?: string, accountNumber?: string): string {
  const material = `${routingNumber ?? ''}|${accountNumber ?? ''}`;
  const digest = crypto.createHmac('sha256', paymentTokenSecret()).update(material).digest('hex');
  return `acct_stripe_connect_${digest.slice(0, 32)}`;
}

/**
 * Unpredictable identifier, e.g. `LD-8f3c1a...`.
 *
 * The previous `Date.now()`-based ids were guessable (and could collide under
 * concurrency): knowing one booking id told you roughly what the next one would
 * be, which is exactly what an object-reference attack needs.
 */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(9).toString('base64url')}`;
}

/** Last four digits, safe to display; empty when nothing usable was supplied. */
export function accountLast4(accountNumber?: string): string | null {
  const digits = (accountNumber ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Identity handed to the database for Row-Level Security. Derived from the
 * verified JWT only — never from a header, query parameter, or request body.
 */
export function sessionContextFor(req: AuthenticatedRequest): SessionContext {
  const user = req.user;
  if (!user) return { role: 'anon' };
  return {
    role: user.role,
    userId: user.id,
    driverId: user.driverId,
    shipperId: user.shipperId
  };
}

/**
 * How many proxies sit between the internet and this process.
 *
 * TRUST_PROXY="true" means one; a number means that many. Express reads the
 * client address that many entries from the RIGHT of X-Forwarded-For — the
 * entries our own proxies appended. Anything further left arrived from the
 * client and is whatever the client typed.
 */
export function trustedProxyHops(): number {
  const raw = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (raw === 'true') return 1;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops > 0 && hops <= 10 ? hops : 0;
}

/**
 * Client address for rate limits and login throttling.
 *
 * The previous version took the FIRST X-Forwarded-For entry, which is the one
 * part of that header the caller controls: sending a different made-up value
 * with each request gave every request a fresh rate-limit bucket.
 *
 * Behind an edge that stamps the address into its own header and overwrites
 * whatever the client sent (Cloudflare's CF-Connecting-IP), name that header
 * in CLIENT_IP_HEADER. It is read only when a proxy is trusted at all, and
 * only if it holds a single well-formed address. Otherwise this is `req.ip`,
 * which Express derives from the trusted hop count above.
 */
export function clientIp(req: Request): string {
  const header = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (header && trustedProxyHops() > 0) {
    const raw = req.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && isIP(value)) return value;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
