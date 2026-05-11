# BunMail 📬

Production mail server built entirely with **Bun** — blazing fast, zero Node.js dependencies.

## Features

- **SMTP** — Inbound (port 25) + Submission with auth (port 587)
- **IMAP4rev1** — Full RFC 3501 implementation (port 143)
- **REST API** — JSON API for webmail clients (port 3000)
- **WebSocket** — Real-time new mail notifications
- **DKIM** — Signs outbound mail, verifies inbound
- **SPF** — Checks sender IP against DNS records
- **Message Queue** — Redis-backed with retry + exponential backoff
- **Maildir++** — Industry-standard mail storage format
- **Rate Limiting** — Per-IP, per-account with Redis sliding window
- **PostgreSQL** — Full ACID storage for users, mailboxes, messages

## Quick Start

### 1. Prerequisites

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install PostgreSQL and Redis (or use Docker)
```

### 2. Clone and install

```bash
git clone <repo>
cd bunmail
bun install
```

### 3. Start dependencies

```bash
# With Docker (easiest):
docker-compose up -d postgres redis

# Or start PostgreSQL and Redis manually
```

### 4. Generate keys

```bash
bun scripts/gen-keys.ts
```

### 5. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set DOMAIN, HOSTNAME, JWT_SECRET
```

### 6. Run migrations and seed

```bash
bun run migrate
bun run seed     # Creates alice@mail.local and bob@mail.local (password: password123)
```

### 7. Start the server

```bash
# Development (hot reload)
bun run dev

# Production
bun run start
```

## DNS Records (Production)

Add these to your domain's DNS:

```
# MX Record
@          MX  10  mail.yourdomain.com

# SPF
@          TXT     "v=spf1 mx a:mail.yourdomain.com -all"

# DKIM (get value from certs/dkim-dns.txt after gen-keys)
mail._domainkey  TXT  "v=DKIM1; k=rsa; p=<public-key>"

# DMARC
_dmarc     TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
```

## API Reference

### Auth

```bash
# Login
POST /api/auth/login
{ "email": "alice@mail.local", "password": "password123" }
→ { "token": "...", "user": { ... } }

# Register
POST /api/auth/register
{ "email": "user@mail.local", "password": "...", "displayName": "..." }
```

### Mailboxes

```bash
GET  /api/mailboxes              # List all mailboxes
POST /api/mailboxes              # Create mailbox { "name": "Archive" }
```

### Messages

```bash
GET  /api/mailboxes/:id/messages    # List messages (page, limit query params)
GET  /api/messages/:id              # Get full message with HTML/text body
PATCH /api/messages/:id             # Update flags { "flags": ["\\Seen"] }
POST /api/messages/send             # Send message
     { "to": [...], "subject": "...", "text": "...", "html": "..." }
```

### Profile

```bash
GET /api/me    # Current user info + quota
```

## Architecture

```
src/
├── index.ts              # Entry point — starts all servers
├── core/
│   ├── config.ts         # Zod-validated environment config
│   ├── db.ts             # PostgreSQL queries (postgres.js)
│   ├── queue.ts          # Redis queue + rate limiter + sessions
│   └── storage.ts        # Maildir++ file storage
├── smtp/
│   ├── server.ts         # SMTP server (Bun.listen TCP)
│   ├── delivery.ts       # Outbound delivery worker + retry
│   └── dkim.ts           # DKIM signer + SPF checker
├── imap/
│   └── server.ts         # IMAP4rev1 server (RFC 3501)
└── api/
    └── routes.ts         # REST API + WebSocket (Bun.serve)
```

## Production Checklist

- [ ] Set strong `JWT_SECRET` (32+ random chars)
- [ ] Use real TLS certs (Let's Encrypt via certbot)
- [ ] Configure firewall — open ports 25, 587, 143, 993
- [ ] Set up DNS records (MX, SPF, DKIM, DMARC)
- [ ] Run as non-root user (use `authbind` for port 25)
- [ ] Set up log rotation
- [ ] Configure backups for PostgreSQL and maildir
- [ ] Consider adding ClamAV for virus scanning
- [ ] Add SpamAssassin integration for spam filtering

## License

MIT
