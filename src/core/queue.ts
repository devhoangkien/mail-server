// src/core/queue.ts
import Redis from "ioredis";
import { config } from "./config";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err) => console.error("❌ Redis error:", err));
redis.on("connect", () => console.log("✅ Redis connected"));

// ─── Queue Keys ───────────────────────────────────────────────────────────────
const QUEUE_OUTBOUND = "queue:outbound";
const QUEUE_INBOUND  = "queue:inbound";
const PREFIX_SESSION = "session:";
const PREFIX_RATELIMIT = "ratelimit:";
const PREFIX_IMAP_CACHE = "imap:cache:";

// ─── Message Queue ────────────────────────────────────────────────────────────

export interface QueuedMessage {
  id: string;
  from: string;
  to: string[];
  data: string; // raw RFC 5322
  retries: number;
  enqueuedAt: string;
}

export const queue = {
  async enqueueOutbound(msg: Omit<QueuedMessage, "retries" | "enqueuedAt">): Promise<void> {
    const payload: QueuedMessage = { ...msg, retries: 0, enqueuedAt: new Date().toISOString() };
    await redis.rpush(QUEUE_OUTBOUND, JSON.stringify(payload));
  },

  async dequeueOutbound(): Promise<QueuedMessage | null> {
    const raw = await redis.lpop(QUEUE_OUTBOUND);
    return raw ? JSON.parse(raw) : null;
  },

  async enqueueInbound(msg: Omit<QueuedMessage, "retries" | "enqueuedAt">): Promise<void> {
    const payload: QueuedMessage = { ...msg, retries: 0, enqueuedAt: new Date().toISOString() };
    await redis.rpush(QUEUE_INBOUND, JSON.stringify(payload));
  },

  async dequeueInbound(): Promise<QueuedMessage | null> {
    const raw = await redis.lpop(QUEUE_INBOUND);
    return raw ? JSON.parse(raw) : null;
  },

  async requeueWithDelay(msg: QueuedMessage, delaySeconds: number): Promise<void> {
    msg.retries += 1;
    // Simple delay: store in a sorted set scored by process-after timestamp
    const processAt = Date.now() / 1000 + delaySeconds;
    await redis.zadd("queue:delayed", processAt, JSON.stringify(msg));
  },

  async promoteDelayed(): Promise<void> {
    const now = Date.now() / 1000;
    const items = await redis.zrangebyscore("queue:delayed", "-inf", now);
    for (const item of items) {
      const msg: QueuedMessage = JSON.parse(item);
      await redis.rpush(QUEUE_OUTBOUND, item);
      await redis.zrem("queue:delayed", item);
    }
  },
};

// ─── Sessions ─────────────────────────────────────────────────────────────────

export interface Session {
  userId: string;
  email: string;
  createdAt: string;
}

export const sessions = {
  async set(token: string, session: Session, ttlSeconds = 86400): Promise<void> {
    await redis.setex(PREFIX_SESSION + token, ttlSeconds, JSON.stringify(session));
  },

  async get(token: string): Promise<Session | null> {
    const raw = await redis.get(PREFIX_SESSION + token);
    return raw ? JSON.parse(raw) : null;
  },

  async del(token: string): Promise<void> {
    await redis.del(PREFIX_SESSION + token);
  },
};

// ─── Rate Limiting ────────────────────────────────────────────────────────────

export const rateLimiter = {
  async check(key: string, maxRequests: number, windowSeconds: number): Promise<{
    allowed: boolean;
    remaining: number;
    resetAt: number;
  }> {
    const redisKey = PREFIX_RATELIMIT + key;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(redisKey, "-inf", now - windowMs);
    pipeline.zadd(redisKey, now, `${now}`);
    pipeline.zcard(redisKey);
    pipeline.expire(redisKey, windowSeconds);
    const results = await pipeline.exec();

    const count = (results?.[2]?.[1] as number) ?? 0;
    const resetAt = Math.ceil((now + windowMs) / 1000);

    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
      resetAt,
    };
  },
};

// ─── IMAP Cache ───────────────────────────────────────────────────────────────

export const imapCache = {
  async setMailboxSummary(mailboxId: string, data: object): Promise<void> {
    await redis.setex(PREFIX_IMAP_CACHE + mailboxId, 60, JSON.stringify(data));
  },

  async getMailboxSummary(mailboxId: string): Promise<object | null> {
    const raw = await redis.get(PREFIX_IMAP_CACHE + mailboxId);
    return raw ? JSON.parse(raw) : null;
  },

  async invalidate(mailboxId: string): Promise<void> {
    await redis.del(PREFIX_IMAP_CACHE + mailboxId);
  },
};
