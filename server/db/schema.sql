CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('retail', 'reseller', 'admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_status AS ENUM ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE commission_status AS ENUM ('pending', 'cleared', 'paid', 'void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE device_status AS ENUM ('available', 'reserved', 'sold', 'quarantined'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role user_role NOT NULL DEFAULT 'retail',
  tax_id TEXT, credit_limit_cents BIGINT NOT NULL DEFAULT 0, commission_tier SMALLINT NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ, totp_secret_encrypted TEXT, totp_enabled BOOLEAN NOT NULL DEFAULT false,
  email_verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE email_verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts SMALLINT NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sku TEXT UNIQUE NOT NULL, brand TEXT NOT NULL,
  model TEXT NOT NULL, storage_gb INTEGER NOT NULL, ram_gb INTEGER, color TEXT,
  retail_price_cents INTEGER NOT NULL CHECK (retail_price_cents >= 0), wholesale_price_cents INTEGER NOT NULL CHECK (wholesale_price_cents >= 0),
  image_url TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE inventory_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES products(id),
  imei TEXT UNIQUE NOT NULL, serial_number TEXT UNIQUE NOT NULL, status device_status NOT NULL DEFAULT 'available',
  warehouse_code TEXT NOT NULL, invoice_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_number TEXT UNIQUE NOT NULL,
  buyer_id UUID NOT NULL REFERENCES users(id), reseller_id UUID REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'pending', currency CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal_cents BIGINT NOT NULL, payment_provider TEXT, payment_reference TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ
);
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID UNIQUE NOT NULL REFERENCES orders(id),
  invoice_number TEXT UNIQUE NOT NULL, tax_rate_bps INTEGER NOT NULL DEFAULT 1300,
  subtotal_cents BIGINT NOT NULL, tax_cents BIGINT NOT NULL, total_cents BIGINT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE order_items (
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE, product_id UUID REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_cents INTEGER NOT NULL, PRIMARY KEY (order_id, product_id)
);
CREATE TABLE commission_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tier SMALLINT UNIQUE NOT NULL,
  rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000), active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL REFERENCES orders(id),
  beneficiary_id UUID NOT NULL REFERENCES users(id), rule_id UUID REFERENCES commission_rules(id),
  gross_sale_cents BIGINT NOT NULL, rate_bps INTEGER NOT NULL, amount_cents BIGINT NOT NULL,
  status commission_status NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), cleared_at TIMESTAMPTZ
);
CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), beneficiary_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL, provider_reference TEXT UNIQUE, amount_cents BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ
);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY, actor_id UUID REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inventory_available_idx ON inventory_units(product_id, warehouse_code) WHERE status = 'available';
CREATE INDEX commissions_beneficiary_status_idx ON commissions(beneficiary_id, status);
CREATE INDEX orders_buyer_created_idx ON orders(buyer_id, created_at DESC);
CREATE INDEX invoices_order_idx ON invoices(order_id);
CREATE INDEX password_reset_active_idx ON password_reset_tokens(user_id, expires_at) WHERE used_at IS NULL;
CREATE INDEX email_verification_active_idx ON email_verification_codes(user_id, expires_at) WHERE verified_at IS NULL;
INSERT INTO commission_rules(tier, rate_bps) VALUES (1, 350), (2, 150) ON CONFLICT (tier) DO NOTHING;
