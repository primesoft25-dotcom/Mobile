import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  try {
    await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  } catch (error) {
    if (error.code !== '42P07') throw error
    await pool.query(`CREATE TABLE IF NOT EXISTS invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID UNIQUE NOT NULL REFERENCES orders(id), invoice_number TEXT UNIQUE NOT NULL, tax_rate_bps INTEGER NOT NULL DEFAULT 1300, subtotal_cents BIGINT NOT NULL, tax_cents BIGINT NOT NULL, total_cents BIGINT NOT NULL, issued_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS invoices_order_idx ON invoices(order_id);`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT; ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false; ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ; ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT; CREATE TABLE IF NOT EXISTS password_reset_tokens (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS email_verification_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts SMALLINT NOT NULL DEFAULT 0, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS password_reset_active_idx ON password_reset_tokens(user_id, expires_at) WHERE used_at IS NULL; CREATE INDEX IF NOT EXISTS email_verification_active_idx ON email_verification_codes(user_id, expires_at) WHERE verified_at IS NULL;`)
    console.log('Aurora schema already existed; invoice migration applied')
  }
  console.log('Aurora schema applied successfully')
} finally {
  await pool.end()
}
