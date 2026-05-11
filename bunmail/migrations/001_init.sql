-- migrations/001_init.sql
-- BunMail database schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Domains
CREATE TABLE IF NOT EXISTS domains (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) UNIQUE NOT NULL,
  active      BOOLEAN DEFAULT true,
  dkim_selector VARCHAR(63) DEFAULT 'mail',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(320) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  VARCHAR(255),
  quota_bytes   BIGINT DEFAULT 1073741824,  -- 1GB default
  used_bytes    BIGINT DEFAULT 0,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Mailboxes
CREATE TABLE IF NOT EXISTS mailboxes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid_next     INTEGER DEFAULT 1,
  flags        TEXT[] DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX idx_mailboxes_user ON mailboxes(user_id);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mailbox_id    UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid           INTEGER NOT NULL,
  message_id    TEXT,
  from_addr     TEXT NOT NULL,
  to_addrs      TEXT[] DEFAULT '{}',
  cc_addrs      TEXT[] DEFAULT '{}',
  subject       TEXT DEFAULT '',
  body_path     TEXT NOT NULL,
  size_bytes    BIGINT DEFAULT 0,
  flags         TEXT[] DEFAULT '{}',
  internal_date TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mailbox_id, uid)
);

CREATE INDEX idx_messages_mailbox ON messages(mailbox_id);
CREATE INDEX idx_messages_uid ON messages(mailbox_id, uid);
CREATE INDEX idx_messages_flags ON messages USING gin(flags);
CREATE INDEX idx_messages_date ON messages(mailbox_id, internal_date DESC);

-- Email aliases
CREATE TABLE IF NOT EXISTS aliases (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_email  VARCHAR(320) UNIQUE NOT NULL,
  to_email    VARCHAR(320) NOT NULL,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_aliases_from ON aliases(from_email);

-- Full text search index on messages
CREATE INDEX idx_messages_subject_fts ON messages USING gin(to_tsvector('english', subject));
