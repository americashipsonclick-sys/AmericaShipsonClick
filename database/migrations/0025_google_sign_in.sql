-- Continue with Google.
--
-- A Google-only account has no password, so `users.password_hash` becomes
-- nullable. The bcrypt shape CHECK still applies to any value that is stored
-- (NULL passes a CHECK), and password login treats a NULL hash as a failed
-- attempt, so these accounts cannot be entered with any password.
--
-- The link lives in its own table rather than a column on `users`. `users` is
-- granted SELECT and INSERT only, so that no route can rewrite a role or a
-- hash, and linking an existing account must not be the reason that changes.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Administrators sign in with a password, always. ensureAdminAccount sets the
-- role and the hash in one statement, so a promotion satisfies this too.
DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_admin_has_password
    CHECK (role <> 'admin' OR password_hash IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_google_identities (
  id         TEXT PRIMARY KEY,
  -- Google's stable account id. Addresses can change; this does not.
  google_sub TEXT UNIQUE NOT NULL,
  user_id    TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- The address Google reported when the link was made, for support and audit.
  -- `users.email` remains the account's address.
  email      TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Links are never rewritten by the app, which would reassign who can sign in.
GRANT SELECT, INSERT ON user_google_identities TO asoc_app;

ALTER TABLE user_google_identities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_google_identities_select ON user_google_identities;
CREATE POLICY user_google_identities_select ON user_google_identities FOR SELECT USING (
  app_is_admin()
  OR user_id = app_current_user_id()
  -- Finding the account for a verified Google login happens before an identity
  -- exists, like the credential check on `users`.
  OR app_current_role() IN ('auth', 'enrollment')
);

-- Two ways in, neither reaching an administrator:
--   - the account's own session, after the route has checked its password
--   - enrollment, only for a passwordless account, which is one it just created
-- So the pre-identity context cannot attach a Google login to a password
-- account, even if a route regresses.
DROP POLICY IF EXISTS user_google_identities_insert ON user_google_identities;
CREATE POLICY user_google_identities_insert ON user_google_identities FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = user_id
      AND u.role <> 'admin'
      AND (
        u.id = app_current_user_id()
        OR (app_current_role() = 'enrollment' AND u.password_hash IS NULL)
      )
  )
);

DROP TRIGGER IF EXISTS audit_user_google_identities ON user_google_identities;
CREATE TRIGGER audit_user_google_identities AFTER INSERT OR UPDATE OR DELETE ON user_google_identities
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
