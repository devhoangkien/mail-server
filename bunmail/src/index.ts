// src/index.ts — BunMail entry point

import { config } from "./core/config";
import { sql } from "./core/db";
import { redis } from "./core/queue";
import { startSmtpServer } from "./smtp/server";
import { startDeliveryWorker } from "./smtp/delivery";
import { startImapServer } from "./imap/server";
import { startApiServer } from "./api/routes";
import { mkdir } from "fs/promises";

console.log(`
╔══════════════════════════════════════╗
║         BunMail Server v1.0          ║
║   Built with Bun — blazing fast ⚡   ║
╚══════════════════════════════════════╝
`);

async function ensureDirectories() {
  for (const dir of [config.MAIL_DIR, "./certs", "./logs"]) {
    await mkdir(dir, { recursive: true });
  }
}

async function checkConnections() {
  // PostgreSQL
  try {
    await sql`SELECT 1`;
    console.log("✅ PostgreSQL connected");
  } catch (err) {
    console.error("❌ PostgreSQL connection failed:", (err as Error).message);
    console.error("   Make sure PostgreSQL is running and DATABASE_URL is set correctly");
    process.exit(1);
  }

  // Redis
  try {
    await redis.ping();
    console.log("✅ Redis connected");
  } catch (err) {
    console.error("❌ Redis connection failed:", (err as Error).message);
    process.exit(1);
  }
}

async function main() {
  await ensureDirectories();
  await checkConnections();

  // Start all servers
  startSmtpServer();
  startImapServer();
  startApiServer();
  await startDeliveryWorker();

  console.log(`
┌─────────────────────────────────────────┐
│            BunMail is ready!            │
│                                         │
│  SMTP (inbound):  port ${String(config.SMTP_PORT).padEnd(5)}           │
│  SMTP (submit):   port ${String(config.SMTP_SUBMISSION_PORT).padEnd(5)}           │
│  IMAP:            port ${String(config.IMAP_PORT).padEnd(5)}           │
│  API + Webmail:   port ${String(config.API_PORT).padEnd(5)}           │
│                                         │
│  Domain: ${config.DOMAIN.padEnd(31)}│
└─────────────────────────────────────────┘
  `);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await sql.end();
  await redis.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await sql.end();
  await redis.quit();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
