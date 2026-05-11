// src/api/routes.ts
import { config } from "../core/config";
import { db } from "../core/db";
import { mailStorage } from "../core/storage";
import { sessions, rateLimiter } from "../core/queue";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { simpleParser } from "mailparser";
import { v4 as uuidv4 } from "uuid";

const JWT_SECRET = new TextEncoder().encode(config.JWT_SECRET);

// ─── JWT Auth ─────────────────────────────────────────────────────────────────

async function signToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ sub: userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(JWT_SECRET);
}

async function verifyToken(token: string): Promise<{ sub: string; email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { sub: string; email: string };
  } catch {
    return null;
  }
}

async function authenticate(req: Request): Promise<{ userId: string; email: string } | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const payload = await verifyToken(token);
  if (!payload) return null;
  return { userId: payload.sub, email: payload.email };
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

async function handleRequest(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      },
    });
  }

  // Health check
  if (path === "/health") {
    return json({ status: "ok", domain: config.DOMAIN, timestamp: new Date().toISOString() });
  }

  // WebSocket upgrade
  if (path === "/ws") {
    const upgraded = server.upgrade(req);
    return upgraded ? undefined as any : error("WebSocket upgrade failed", 400);
  }

  // ── Auth Routes ──────────────────────────────────────────────────────────────

  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) return error("Email and password required");

    const rl = await rateLimiter.check(`login:${email}`, 5, 60);
    if (!rl.allowed) return error("Too many attempts", 429);

    const user = await db.getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return error("Invalid credentials", 401);
    }

    const token = await signToken(user.id, user.email);
    return json({
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
  }

  if (path === "/api/auth/register" && req.method === "POST") {
    const body = await req.json();
    const { email, password, displayName } = body;

    if (!email || !password) return error("Email and password required");
    if (password.length < 8) return error("Password must be at least 8 characters");

    const domain = email.split("@")[1];
    const validDomain = await db.getDomain(domain);
    if (!validDomain) return error(`Domain ${domain} is not hosted here`, 422);

    const existing = await db.getUserByEmail(email);
    if (existing) return error("Email already registered", 409);

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({ email, passwordHash, displayName: displayName ?? email });

    // Create default mailboxes
    for (const name of ["INBOX", "Sent", "Drafts", "Trash", "Spam"]) {
      await db.createMailbox(user.id, name);
    }

    const token = await signToken(user.id, user.email);
    return json({ token, user: { id: user.id, email: user.email, displayName: user.displayName } }, 201);
  }

  // All routes below require auth
  const auth = await authenticate(req);
  if (!auth && path.startsWith("/api/")) {
    return error("Unauthorized", 401);
  }

  // ── Mailbox Routes ────────────────────────────────────────────────────────────

  if (path === "/api/mailboxes" && req.method === "GET") {
    const mailboxes = await db.getMailboxes(auth!.userId);
    const result = await Promise.all(
      mailboxes.map(async (mb) => {
        const { total, unseen } = await db.getMessageCount(mb.id);
        return { ...mb, total, unseen };
      })
    );
    return json(result);
  }

  if (path === "/api/mailboxes" && req.method === "POST") {
    const { name } = await req.json();
    if (!name) return error("Name required");

    const existing = await db.getMailbox(auth!.userId, name);
    if (existing) return error("Mailbox already exists", 409);

    const mailbox = await db.createMailbox(auth!.userId, name);
    return json(mailbox, 201);
  }

  // ── Message Routes ────────────────────────────────────────────────────────────

  const messagesMatch = path.match(/^\/api\/mailboxes\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === "GET") {
    const mailboxId = messagesMatch[1];
    const mailbox = await db.getMailboxById(mailboxId);
    if (!mailbox || mailbox.userId !== auth!.userId) {
      return error("Mailbox not found", 404);
    }

    const page = parseInt(url.searchParams.get("page") ?? "1");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);
    const offset = (page - 1) * limit;

    const messages = await db.getMessages(mailboxId, { limit, offset });
    const { total } = await db.getMessageCount(mailboxId);

    return json({
      messages: messages.map((m) => ({
        id: m.id,
        uid: m.uid,
        messageId: m.messageId,
        from: m.fromAddr,
        to: m.toAddrs,
        subject: m.subject,
        flags: m.flags,
        sizeBytes: m.sizeBytes,
        internalDate: m.internalDate,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  }

  const messageMatch = path.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch && req.method === "GET") {
    const [, messageId] = messageMatch;
    // Find message by id across user's mailboxes
    const mailboxes = await db.getMailboxes(auth!.userId);
    let targetMsg = null;

    for (const mb of mailboxes) {
      const messages = await db.getMessages(mb.id);
      const found = messages.find((m) => m.id === messageId);
      if (found) { targetMsg = found; break; }
    }

    if (!targetMsg) return error("Message not found", 404);

    const raw = await mailStorage.readMessage(targetMsg.bodyPath);
    const parsed = await simpleParser(raw);

    // Mark as seen
    if (!targetMsg.flags.includes("\\Seen")) {
      await db.updateMessageFlags(targetMsg.id, [...targetMsg.flags, "\\Seen"]);
    }

    return json({
      id: targetMsg.id,
      uid: targetMsg.uid,
      from: parsed.from?.text,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      flags: targetMsg.flags,
      attachments: parsed.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    });
  }

  // Flag update
  if (messageMatch && req.method === "PATCH") {
    const { flags } = await req.json();
    const [, messageId] = messageMatch;

    const mailboxes = await db.getMailboxes(auth!.userId);
    let found = false;
    for (const mb of mailboxes) {
      const messages = await db.getMessages(mb.id);
      const msg = messages.find((m) => m.id === messageId);
      if (msg) {
        await db.updateMessageFlags(messageId, flags);
        found = true;
        break;
      }
    }

    if (!found) return error("Message not found", 404);
    return json({ ok: true });
  }

  // Send message
  if (path === "/api/messages/send" && req.method === "POST") {
    const { to, cc, bcc, subject, text, html } = await req.json();

    if (!to || !subject) return error("to and subject are required");

    const user = await db.getUserById(auth!.userId);
    if (!user) return error("User not found", 404);

    const msgId = `<${uuidv4()}@${config.DOMAIN}>`;
    const date = new Date().toUTCString();

    const toList = Array.isArray(to) ? to : [to];
    const ccList = Array.isArray(cc) ? cc : cc ? [cc] : [];

    let rawMessage = [
      `Message-ID: ${msgId}`,
      `Date: ${date}`,
      `From: ${user.displayName} <${user.email}>`,
      `To: ${toList.join(", ")}`,
      ccList.length ? `Cc: ${ccList.join(", ")}` : null,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
      "",
      html ?? text ?? "",
    ]
      .filter((l) => l !== null)
      .join("\r\n");

    // Save to Sent mailbox
    const sentBox = await db.getMailbox(user.id, "Sent");
    if (sentBox) {
      const uid = await db.incrementUidNext(sentBox.id);
      const bodyPath = await mailStorage.saveMessage(user.id, "Sent", rawMessage);
      await db.saveMessage({
        mailboxId: sentBox.id,
        uid,
        messageId: msgId,
        fromAddr: user.email,
        toAddrs: toList,
        ccAddrs: ccList,
        subject,
        bodyPath,
        sizeBytes: rawMessage.length,
        flags: ["\\Seen"],
      });
    }

    // Queue for delivery
    const { queue } = await import("../core/queue");
    const allRecipients = [...toList, ...ccList, ...(bcc ? [bcc] : [])];
    await queue.enqueueOutbound({
      id: uuidv4(),
      from: user.email,
      to: allRecipients,
      data: rawMessage,
    });

    return json({ ok: true, messageId: msgId }, 201);
  }

  // ── User Routes ───────────────────────────────────────────────────────────────

  if (path === "/api/me" && req.method === "GET") {
    const user = await db.getUserById(auth!.userId);
    if (!user) return error("User not found", 404);
    return json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      quotaPercent: Math.round((user.usedBytes / user.quotaBytes) * 100),
    });
  }

  // Static files (webmail)
  if (!path.startsWith("/api/")) {
    const file = Bun.file(`./webmail/dist${path === "/" ? "/index.html" : path}`);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response(Bun.file("./webmail/dist/index.html"));
  }

  return error("Not found", 404);
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────

const wsClients = new Map<string, { ws: any; userId: string }>();

export const websocketHandler = {
  async message(ws: any, message: string) {
    try {
      const data = JSON.parse(message);

      if (data.type === "auth") {
        const payload = await verifyToken(data.token);
        if (payload) {
          wsClients.set(ws.id, { ws, userId: payload.sub });
          ws.send(JSON.stringify({ type: "auth_ok" }));
        } else {
          ws.send(JSON.stringify({ type: "auth_error" }));
          ws.close();
        }
      }
    } catch {}
  },

  close(ws: any) {
    wsClients.delete(ws.id);
  },
};

// Broadcast new mail notification to user's WebSocket connections
export function notifyNewMail(userId: string, mailboxId: string, messageId: string): void {
  for (const [, client] of wsClients) {
    if (client.userId === userId) {
      client.ws.send(JSON.stringify({ type: "new_mail", mailboxId, messageId }));
    }
  }
}

// ─── Start API Server ─────────────────────────────────────────────────────────

export function startApiServer() {
  const server = Bun.serve({
    port: config.API_PORT,
    fetch: handleRequest,
    websocket: websocketHandler,
    error(err) {
      console.error("API error:", err);
      return json({ error: "Internal server error" }, 500);
    },
  });

  console.log(`🌐 API server listening on port ${config.API_PORT}`);
  return server;
}
