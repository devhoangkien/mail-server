// src/core/config.ts
import { z } from "zod";

const ConfigSchema = z.object({
  // Server
  HOSTNAME: z.string().default("localhost"),
  DOMAIN: z.string().default("mail.local"),

  // SMTP
  SMTP_PORT: z.coerce.number().default(25),
  SMTP_SUBMISSION_PORT: z.coerce.number().default(587),
  SMTP_TLS_PORT: z.coerce.number().default(465),

  // IMAP
  IMAP_PORT: z.coerce.number().default(143),
  IMAP_TLS_PORT: z.coerce.number().default(993),

  // Web API
  API_PORT: z.coerce.number().default(3000),

  // PostgreSQL
  DATABASE_URL: z.string().default("postgresql://bunmail:bunmail@localhost:5432/bunmail"),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // TLS
  TLS_CERT_PATH: z.string().default("./certs/cert.pem"),
  TLS_KEY_PATH: z.string().default("./certs/key.pem"),

  // DKIM
  DKIM_PRIVATE_KEY_PATH: z.string().default("./certs/dkim-private.pem"),
  DKIM_SELECTOR: z.string().default("mail"),

  // Mail Storage
  MAIL_DIR: z.string().default("./maildir"),

  // JWT
  JWT_SECRET: z.string().min(32).default("change-me-to-a-very-long-secret-key-32chars"),

  // Limits
  MAX_MESSAGE_SIZE: z.coerce.number().default(25 * 1024 * 1024), // 25MB
  MAX_CONNECTIONS_PER_IP: z.coerce.number().default(10),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    HOSTNAME: process.env.HOSTNAME,
    DOMAIN: process.env.DOMAIN,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SUBMISSION_PORT: process.env.SMTP_SUBMISSION_PORT,
    SMTP_TLS_PORT: process.env.SMTP_TLS_PORT,
    IMAP_PORT: process.env.IMAP_PORT,
    IMAP_TLS_PORT: process.env.IMAP_TLS_PORT,
    API_PORT: process.env.API_PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    TLS_CERT_PATH: process.env.TLS_CERT_PATH,
    TLS_KEY_PATH: process.env.TLS_KEY_PATH,
    DKIM_PRIVATE_KEY_PATH: process.env.DKIM_PRIVATE_KEY_PATH,
    DKIM_SELECTOR: process.env.DKIM_SELECTOR,
    MAIL_DIR: process.env.MAIL_DIR,
    JWT_SECRET: process.env.JWT_SECRET,
    MAX_MESSAGE_SIZE: process.env.MAX_MESSAGE_SIZE,
    MAX_CONNECTIONS_PER_IP: process.env.MAX_CONNECTIONS_PER_IP,
    RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error("❌ Invalid config:", result.error.flatten());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
