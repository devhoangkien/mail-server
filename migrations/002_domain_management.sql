-- migrations/002_domain_management.sql

-- Per-domain DKIM keys
ALTER TABLE domains ADD COLUMN IF NOT EXISTS dkim_private_key TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS dkim_public_key  TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS dkim_dns_value   TEXT;

-- Catch-all: nếu không có user nào match → forward về catch_all_address
ALTER TABLE domains ADD COLUMN IF NOT EXISTS catch_all_address TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS catch_all_enabled BOOLEAN DEFAULT false;

-- Admin flag cho user
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- Wildcard aliases: *@domain.com → target
CREATE TABLE IF NOT EXISTS wildcard_aliases (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain      VARCHAR(255) NOT NULL,
  to_email    VARCHAR(320) NOT NULL,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain)
);

CREATE INDEX idx_wildcard_domain ON wildcard_aliases(domain);

-- Audit log cho domain actions
CREATE TABLE IF NOT EXISTS domain_audit_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain     VARCHAR(255) NOT NULL,
  action     VARCHAR(64)  NOT NULL,
  performed_by UUID REFERENCES users(id),
  detail     JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);