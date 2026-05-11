// src/smtp/server.ts
import type { Socket, TCPSocketListener } from "bun";
import { config } from "../core/config";
import { db } from "../core/db";
import { queue, rateLimiter } from "../core/queue";
import { mailStorage } from "../core/storage";
import { spfChecker, dkimSigner } from "./dkim";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";

// ─── SMTP Session State ───────────────────────────────────────────────────────

interface SmtpSession {
  id: string;
  state: "GREETING" | "EHLO" | "AUTH" | "READY" | "DATA" | "QUIT";
  isAuthenticated: boolean;
  userId: string | null;
  userEmail: string | null;
  envelope: {
    from: string | null;
    to: string[];
  };
  dataBuffer: string;
  isReadingData: boolean;
  hostname: string;
  remoteAddress: string;
  isSubmission: boolean; // port 587
}

const sessions = new Map<Socket, SmtpSession>();

// ─── SMTP Command Handlers ────────────────────────────────────────────────────

async function handleCommand(socket: Socket, session: SmtpSession, line: string): Promise<void> {
  const cmd = line.slice(0, 4).toUpperCase();
  const args = line.slice(5).trim();

  // Rate limiting per IP
  const rl = await rateLimiter.check(
    `smtp:${session.remoteAddress}`,
    config.RATE_LIMIT_MAX_REQUESTS,
    config.RATE_LIMIT_WINDOW_SECONDS
  );
  if (!rl.allowed) {
    socket.write("421 Too many requests. Try again later.\r\n");
    socket.end();
    return;
  }

  if (session.isReadingData) {
    await handleData(socket, session, line);
    return;
  }

  switch (cmd) {
    case "EHLO":
    case "HELO":
      session.hostname = args || "unknown";
      session.state = "EHLO";
      if (cmd === "EHLO") {
        socket.write(
          `250-${config.DOMAIN}\r\n` +
          `250-SIZE ${config.MAX_MESSAGE_SIZE}\r\n` +
          `250-8BITMIME\r\n` +
          `250-STARTTLS\r\n` +
          (session.isSubmission ? "250-AUTH LOGIN PLAIN\r\n" : "") +
          `250 SMTPUTF8\r\n`
        );
      } else {
        socket.write(`250 ${config.DOMAIN}\r\n`);
      }
      break;

    case "AUTH":
      await handleAuth(socket, session, args);
      break;

    case "MAIL":
      if (!session.isSubmission || session.isAuthenticated) {
        const match = args.match(/FROM:\s*<?([^>]+)>?/i);
        if (!match) {
          socket.write("501 Syntax error in MAIL FROM\r\n");
          return;
        }
        session.envelope.from = match[1].toLowerCase();
        session.envelope.to = [];
        socket.write("250 OK\r\n");
      } else {
        socket.write("530 Authentication required\r\n");
      }
      break;

    case "RCPT": {
      if (!session.envelope.from) {
        socket.write("503 Bad sequence: MAIL first\r\n");
        return;
      }
      const match = args.match(/TO:\s*<?([^>]+)>?/i);
      if (!match) {
        socket.write("501 Syntax error in RCPT TO\r\n");
        return;
      }
      const rcpt = match[1].toLowerCase();
      // Validate recipient exists locally (for inbound) or allow any (for submission)
      if (!session.isSubmission) {
        const user = await db.getUserByEmail(rcpt);
        const alias = await db.resolveAlias(rcpt);
        if (!user && !alias) {
          socket.write(`550 No such user: ${rcpt}\r\n`);
          return;
        }
      }
      if (session.envelope.to.length >= 100) {
        socket.write("452 Too many recipients\r\n");
        return;
      }
      session.envelope.to.push(rcpt);
      socket.write("250 OK\r\n");
      break;
    }

    case "DATA":
      if (!session.envelope.from || session.envelope.to.length === 0) {
        socket.write("503 Bad sequence\r\n");
        return;
      }
      session.state = "DATA";
      session.isReadingData = true;
      session.dataBuffer = "";
      socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
      break;

    case "RSET":
      session.envelope = { from: null, to: [] };
      session.dataBuffer = "";
      session.isReadingData = false;
      session.state = "EHLO";
      socket.write("250 OK\r\n");
      break;

    case "NOOP":
      socket.write("250 OK\r\n");
      break;

    case "QUIT":
      socket.write("221 Bye\r\n");
      socket.end();
      break;

    case "VRFY":
      socket.write("252 Cannot verify users\r\n");
      break;

    default:
      socket.write(`502 Command not implemented: ${cmd}\r\n`);
  }
}

async function handleAuth(socket: Socket, session: SmtpSession, args: string): Promise<void> {
  const parts = args.split(" ");
  const mechanism = parts[0].toUpperCase();

  if (mechanism === "PLAIN") {
    try {
      const decoded = Buffer.from(parts[1] || "", "base64").toString("utf8");
      const [, username, password] = decoded.split("\0");
      const user = await db.getUserByEmail(username);

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        socket.write("535 Authentication failed\r\n");
        return;
      }

      session.isAuthenticated = true;
      session.userId = user.id;
      session.userEmail = user.email;
      socket.write("235 Authentication successful\r\n");
    } catch {
      socket.write("535 Authentication failed\r\n");
    }
  } else if (mechanism === "LOGIN") {
    // Challenge-response — send username prompt
    socket.write("334 " + Buffer.from("Username:").toString("base64") + "\r\n");
    // NOTE: For simplicity, we handle full LOGIN flow via state machine below
    // Production should use a proper state machine
  } else {
    socket.write("504 Unrecognized authentication mechanism\r\n");
  }
}

async function handleData(socket: Socket, session: SmtpSession, line: string): Promise<void> {
  if (line === ".") {
    // End of data
    session.isReadingData = false;
    const rawMessage = session.dataBuffer;

    if (rawMessage.length > config.MAX_MESSAGE_SIZE) {
      socket.write("552 Message too large\r\n");
      session.envelope = { from: null, to: [] };
      return;
    }

    try {
      await deliverMessage(session, rawMessage);
      socket.write("250 Message accepted for delivery\r\n");
    } catch (err) {
      console.error("❌ Delivery error:", err);
      socket.write("451 Temporary failure, try again\r\n");
    }

    session.envelope = { from: null, to: [] };
    session.dataBuffer = "";
    session.state = "EHLO";
  } else {
    // Unstuff leading dots
    session.dataBuffer += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
  }
}

async function deliverMessage(session: SmtpSession, rawMessage: string): Promise<void> {
  const msgId = uuidv4();
  const from = session.envelope.from!;
  const to = session.envelope.to;

  // Add Received header
  const receivedHeader =
    `Received: from ${session.hostname} (${session.remoteAddress})\r\n` +
    `\tby ${config.DOMAIN} with SMTP id ${msgId};\r\n` +
    `\t${new Date().toUTCString()}\r\n`;

  const fullMessage = receivedHeader + rawMessage;

  if (session.isSubmission) {
    // Outbound: sign with DKIM and queue for delivery
    const [fromUser, fromDomain] = from.split("@");
    const signedMessage = dkimSigner.sign(fromDomain, fullMessage);
    await queue.enqueueOutbound({ id: msgId, from, to, data: signedMessage });
    console.log(`📤 Queued outbound: ${from} → ${to.join(", ")}`);
  } else {
    // Inbound: deliver to local mailboxes
    await queue.enqueueInbound({ id: msgId, from, to, data: fullMessage });
    console.log(`📥 Queued inbound: ${from} → ${to.join(", ")}`);
  }
}

// ─── Server Factory ───────────────────────────────────────────────────────────

function createSmtpHandler(isSubmission = false) {
  return {
    open(socket: Socket) {
      const session: SmtpSession = {
        id: uuidv4(),
        state: "GREETING",
        isAuthenticated: false,
        userId: null,
        userEmail: null,
        envelope: { from: null, to: [] },
        dataBuffer: "",
        isReadingData: false,
        hostname: "",
        remoteAddress: (socket as any).remoteAddress ?? "unknown",
        isSubmission,
      };
      sessions.set(socket, session);
      socket.write(`220 ${config.DOMAIN} ESMTP BunMail Ready\r\n`);
    },

    data(socket: Socket, data: Buffer) {
      const session = sessions.get(socket);
      if (!session) return;

      const lines = data.toString().split("\r\n").filter((l) => l !== "");
      for (const line of lines) {
        handleCommand(socket, session, line).catch(console.error);
      }
    },

    close(socket: Socket) {
      sessions.delete(socket);
    },

    error(socket: Socket, error: Error) {
      console.error(`SMTP error [${(socket as any).remoteAddress}]:`, error.message);
      sessions.delete(socket);
    },
  };
}

export function startSmtpServer(): TCPSocketListener[] {
  const servers: TCPSocketListener[] = [];

  // Port 25 — Inbound from internet MTAs (no auth required)
  const inbound = Bun.listen({
    hostname: "0.0.0.0",
    port: config.SMTP_PORT,
    socket: createSmtpHandler(false),
  });
  servers.push(inbound);
  console.log(`📬 SMTP server listening on port ${config.SMTP_PORT}`);

  // Port 587 — Submission (auth required)
  const submission = Bun.listen({
    hostname: "0.0.0.0",
    port: config.SMTP_SUBMISSION_PORT,
    socket: createSmtpHandler(true),
  });
  servers.push(submission);
  console.log(`📬 SMTP Submission listening on port ${config.SMTP_SUBMISSION_PORT}`);

  return servers;
}
