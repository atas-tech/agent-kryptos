DROP INDEX IF EXISTS idx_users_verification_token_unique;

ALTER TABLE users
  DROP COLUMN IF EXISTS verification_token;
