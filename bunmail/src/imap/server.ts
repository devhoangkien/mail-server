// src/imap/server.ts
import type { Socket } from "bun";
import { config } from "../core/config";
import { db } from "../core/db";
import { mailStorage } from "../core/storage";
import { imapCache } from "../core/queue";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

// ─── IMAP Session ─────────────────────────────────────────────────────────────

interface ImapSession {
  id: string;
  state: "NOT_AUTHENTICATED" | "AUTHENTICATED" | "SELECTED" | "LOGOUT";
  userId: string | null;
  userEmail: string | null;
  selectedMailboxId: string | null;
  selectedMailboxName: string | null;
  lineBuffer: string;
}

const sessions = new Map<Socket, ImapSession>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(tag: string, msg = "OK"): string {
  return `${tag} OK ${msg}\r\n`;
}

function no(tag: string, msg = "NO"): string {
  return `${tag} NO ${msg}\r\n`;
}

function bad(tag: string, msg = "BAD"): string {
  return `${tag} BAD ${msg}\r\n`;
}

function untagged(msg: string): string {
  return `* ${msg}\r\n`;
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleCommand(
  socket: Socket,
  session: ImapSession,
  tag: string,
  cmd: string,
  args: string
): Promise<void> {
  const command = cmd.toUpperCase();

  // Commands allowed in any state
  if (command === "CAPABILITY") {
    socket.write(untagged("CAPABILITY IMAP4rev1 AUTH=PLAIN LITERAL+"));
    socket.write(ok(tag, "CAPABILITY completed"));
    return;
  }

  if (command === "LOGOUT") {
    socket.write(untagged("BYE Logging out"));
    socket.write(ok(tag, "LOGOUT completed"));
    socket.end();
    return;
  }

  if (command === "NOOP") {
    socket.write(ok(tag, "NOOP completed"));
    return;
  }

  // Not authenticated state
  if (session.state === "NOT_AUTHENTICATED") {
    if (command === "LOGIN") {
      await handleLogin(socket, session, tag, args);
    } else if (command === "AUTHENTICATE") {
      await handleAuthenticate(socket, session, tag, args);
    } else {
      socket.write(no(tag, "Not authenticated"));
    }
    return;
  }

  // Authenticated state
  if (session.state === "AUTHENTICATED" || session.state === "SELECTED") {
    switch (command) {
      case "LIST":
        await handleList(socket, session, tag, args);
        break;
      case "LSUB":
        await handleList(socket, session, tag, args); // simplified: same as LIST
        break;
      case "SELECT":
        await handleSelect(socket, session, tag, args, false);
        break;
      case "EXAMINE":
        await handleSelect(socket, session, tag, args, true);
        break;
      case "CREATE":
        await handleCreate(socket, session, tag, args);
        break;
      case "DELETE":
        await handleDelete(socket, session, tag, args);
        break;
      case "STATUS":
        await handleStatus(socket, session, tag, args);
        break;
      case "SUBSCRIBE":
      case "UNSUBSCRIBE":
        socket.write(ok(tag, `${command} completed`));
        break;
      default:
        if (session.state === "SELECTED") {
          await handleSelectedCommand(socket, session, tag, command, args);
        } else {
          socket.write(bad(tag, `Unknown command: ${command}`));
        }
    }
  }
}

async function handleLogin(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  const match = args.match(/^"?([^"\s]+)"?\s+"?([^"]+)"?$/);
  if (!match) {
    socket.write(bad(tag, "Invalid LOGIN syntax"));
    return;
  }
  const [, username, password] = match;
  const user = await db.getUserByEmail(username);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    socket.write(no(tag, "Authentication failed"));
    return;
  }

  session.state = "AUTHENTICATED";
  session.userId = user.id;
  session.userEmail = user.email;
  socket.write(ok(tag, "LOGIN completed"));
}

async function handleAuthenticate(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  // Only PLAIN supported for now
  const parts = args.split(" ");
  if (parts[0].toUpperCase() !== "PLAIN") {
    socket.write(no(tag, "Unsupported mechanism"));
    return;
  }

  if (parts[1]) {
    const decoded = Buffer.from(parts[1], "base64").toString("utf8");
    const [, username, password] = decoded.split("\0");
    const user = await db.getUserByEmail(username);

    if (user && (await bcrypt.compare(password, user.passwordHash))) {
      session.state = "AUTHENTICATED";
      session.userId = user.id;
      session.userEmail = user.email;
      socket.write(ok(tag, "AUTHENTICATE completed"));
    } else {
      socket.write(no(tag, "Authentication failed"));
    }
  } else {
    socket.write("+ \r\n"); // challenge
  }
}

async function handleList(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  const mailboxes = await db.getMailboxes(session.userId!);
  for (const mb of mailboxes) {
    socket.write(untagged(`LIST (\\HasNoChildren) "/" "${mb.name}"`));
  }
  socket.write(ok(tag, "LIST completed"));
}

async function handleSelect(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  readOnly: boolean
): Promise<void> {
  const name = args.replace(/"/g, "").trim();
  const mailbox = await db.getMailbox(session.userId!, name);

  if (!mailbox) {
    socket.write(no(tag, `No such mailbox: ${name}`));
    return;
  }

  session.state = "SELECTED";
  session.selectedMailboxId = mailbox.id;
  session.selectedMailboxName = mailbox.name;

  const { total, unseen } = await db.getMessageCount(mailbox.id);

  socket.write(untagged(`${total} EXISTS`));
  socket.write(untagged("0 RECENT"));
  socket.write(untagged(`OK [UNSEEN ${unseen}] Message ${unseen} is first unseen`));
  socket.write(untagged(`OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`));
  socket.write(untagged(`OK [UIDNEXT ${mailbox.uidNext}] Predicted next UID`));
  socket.write(untagged("FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)"));
  socket.write(untagged("OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited"));
  socket.write(ok(tag, `[${readOnly ? "READ-ONLY" : "READ-WRITE"}] SELECT completed`));
}

async function handleCreate(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  const name = args.replace(/"/g, "").trim();
  const existing = await db.getMailbox(session.userId!, name);
  if (existing) {
    socket.write(no(tag, "Mailbox already exists"));
    return;
  }
  await db.createMailbox(session.userId!, name);
  socket.write(ok(tag, "CREATE completed"));
}

async function handleDelete(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  const name = args.replace(/"/g, "").trim();
  if (name === "INBOX") {
    socket.write(no(tag, "Cannot delete INBOX"));
    return;
  }
  // TODO: delete mailbox and move messages to Trash
  socket.write(ok(tag, "DELETE completed"));
}

async function handleStatus(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string
): Promise<void> {
  const match = args.match(/^"?([^"\s]+)"?\s+\(([^)]+)\)$/);
  if (!match) {
    socket.write(bad(tag, "Invalid STATUS syntax"));
    return;
  }

  const [, name, items] = match;
  const mailbox = await db.getMailbox(session.userId!, name);
  if (!mailbox) {
    socket.write(no(tag, `No such mailbox: ${name}`));
    return;
  }

  const { total, unseen } = await db.getMessageCount(mailbox.id);
  const statusItems: string[] = [];

  if (items.includes("MESSAGES")) statusItems.push(`MESSAGES ${total}`);
  if (items.includes("UNSEEN")) statusItems.push(`UNSEEN ${unseen}`);
  if (items.includes("UIDNEXT")) statusItems.push(`UIDNEXT ${mailbox.uidNext}`);
  if (items.includes("UIDVALIDITY")) statusItems.push(`UIDVALIDITY ${mailbox.uidValidity}`);

  socket.write(untagged(`STATUS "${name}" (${statusItems.join(" ")})`));
  socket.write(ok(tag, "STATUS completed"));
}

async function handleSelectedCommand(
  socket: Socket,
  session: ImapSession,
  tag: string,
  command: string,
  args: string
): Promise<void> {
  const mailboxId = session.selectedMailboxId!;

  switch (command) {
    case "FETCH":
      await handleFetch(socket, session, tag, args, mailboxId);
      break;
    case "STORE":
      await handleStore(socket, session, tag, args, mailboxId);
      break;
    case "SEARCH":
      await handleSearch(socket, session, tag, args, mailboxId);
      break;
    case "EXPUNGE":
      await handleExpunge(socket, session, tag, mailboxId);
      break;
    case "COPY":
      await handleCopy(socket, session, tag, args, mailboxId);
      break;
    case "UID":
      await handleUid(socket, session, tag, args, mailboxId);
      break;
    default:
      socket.write(bad(tag, `Unknown command in selected state: ${command}`));
  }
}

async function handleFetch(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  mailboxId: string
): Promise<void> {
  const [seqSet, ...itemParts] = args.split(" ");
  const items = itemParts.join(" ").toUpperCase();

  const messages = await db.getMessages(mailboxId);

  // Parse sequence set (simplified: handles n, n:m, *)
  const indices = parseSequenceSet(seqSet, messages.length);

  for (const idx of indices) {
    const msg = messages[idx - 1];
    if (!msg) continue;

    const parts: string[] = [];

    if (items.includes("FLAGS")) {
      parts.push(`FLAGS (${msg.flags.join(" ")})`);
    }
    if (items.includes("INTERNALDATE")) {
      parts.push(`INTERNALDATE "${msg.internalDate.toUTCString()}"`);
    }
    if (items.includes("RFC822.SIZE") || items.includes("BODY")) {
      parts.push(`RFC822.SIZE ${msg.sizeBytes}`);
    }
    if (items.includes("ENVELOPE")) {
      parts.push(
        `ENVELOPE ("${msg.internalDate.toUTCString()}" "${msg.subject}" ` +
        `((NIL NIL "${msg.fromAddr.split("@")[0]}" "${msg.fromAddr.split("@")[1]}")) ` +
        `NIL NIL NIL ` +
        `((NIL NIL "${msg.toAddrs[0]?.split("@")[0]}" "${msg.toAddrs[0]?.split("@")[1]}")) ` +
        `NIL NIL NIL "<${msg.messageId}>")`
      );
    }
    if (items.includes("BODY[]") || items.includes("RFC822")) {
      try {
        const body = await mailStorage.readMessage(msg.bodyPath);
        parts.push(`BODY[] {${body.length}}\r\n${body}`);
        // Mark as seen
        if (!msg.flags.includes("\\Seen")) {
          const newFlags = [...msg.flags, "\\Seen"];
          await db.updateMessageFlags(msg.id, newFlags);
        }
      } catch {
        parts.push("BODY[] NIL");
      }
    }
    if (items.includes("BODY[HEADER]") || items.includes("RFC822.HEADER")) {
      try {
        const body = await mailStorage.readMessage(msg.bodyPath);
        const headerEnd = body.indexOf("\r\n\r\n");
        const headers = headerEnd > -1 ? body.slice(0, headerEnd + 2) : body;
        parts.push(`BODY[HEADER] {${headers.length}}\r\n${headers}`);
      } catch {
        parts.push("BODY[HEADER] NIL");
      }
    }

    if (parts.length > 0) {
      socket.write(untagged(`${idx} FETCH (${parts.join(" ")})`));
    }
  }

  socket.write(ok(tag, "FETCH completed"));
}

async function handleStore(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  mailboxId: string
): Promise<void> {
  const match = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+\(([^)]*)\)$/i);
  if (!match) {
    socket.write(bad(tag, "Invalid STORE syntax"));
    return;
  }

  const [, seqSet, flagCmd, flagList] = match;
  const newFlags = flagList.split(" ").filter(Boolean);
  const messages = await db.getMessages(mailboxId);
  const indices = parseSequenceSet(seqSet, messages.length);
  const silent = flagCmd.toUpperCase().includes("SILENT");

  for (const idx of indices) {
    const msg = messages[idx - 1];
    if (!msg) continue;

    let updatedFlags: string[];
    if (flagCmd.startsWith("+")) {
      updatedFlags = [...new Set([...msg.flags, ...newFlags])];
    } else if (flagCmd.startsWith("-")) {
      updatedFlags = msg.flags.filter((f) => !newFlags.includes(f));
    } else {
      updatedFlags = newFlags;
    }

    await db.updateMessageFlags(msg.id, updatedFlags);

    if (!silent) {
      socket.write(untagged(`${idx} FETCH (FLAGS (${updatedFlags.join(" ")}))`));
    }
  }

  socket.write(ok(tag, "STORE completed"));
}

async function handleSearch(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  mailboxId: string
): Promise<void> {
  const messages = await db.getMessages(mailboxId);
  const criteria = args.toUpperCase();

  const matched: number[] = [];
  messages.forEach((msg, i) => {
    const seqNum = i + 1;
    let match = true;

    if (criteria.includes("UNSEEN") && msg.flags.includes("\\Seen")) match = false;
    if (criteria.includes("SEEN") && !msg.flags.includes("\\Seen")) match = false;
    if (criteria.includes("FLAGGED") && !msg.flags.includes("\\Flagged")) match = false;
    if (criteria.includes("DELETED") && !msg.flags.includes("\\Deleted")) match = false;
    if (criteria === "ALL") match = true;

    if (match) matched.push(seqNum);
  });

  socket.write(untagged(`SEARCH ${matched.join(" ")}`));
  socket.write(ok(tag, "SEARCH completed"));
}

async function handleExpunge(
  socket: Socket,
  session: ImapSession,
  tag: string,
  mailboxId: string
): Promise<void> {
  const messages = await db.getMessages(mailboxId);
  const deleted = messages
    .map((m, i) => ({ msg: m, seq: i + 1 }))
    .filter(({ msg }) => msg.flags.includes("\\Deleted"));

  // Delete in reverse order
  for (const { msg, seq } of deleted.reverse()) {
    await mailStorage.deleteMessage(msg.bodyPath);
    socket.write(untagged(`${seq} EXPUNGE`));
  }

  await db.deleteMessages(mailboxId);
  await imapCache.invalidate(mailboxId);
  socket.write(ok(tag, "EXPUNGE completed"));
}

async function handleCopy(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  mailboxId: string
): Promise<void> {
  const [seqSet, targetName] = args.split(" ");
  const target = await db.getMailbox(session.userId!, targetName.replace(/"/g, ""));

  if (!target) {
    socket.write(no(tag, `[TRYCREATE] No such mailbox: ${targetName}`));
    return;
  }

  const messages = await db.getMessages(mailboxId);
  const indices = parseSequenceSet(seqSet, messages.length);

  for (const idx of indices) {
    const msg = messages[idx - 1];
    if (!msg) continue;

    const uid = await db.incrementUidNext(target.id);
    const raw = await mailStorage.readMessage(msg.bodyPath);
    const newPath = await mailStorage.saveMessage(session.userId!, target.name, raw);

    await db.saveMessage({
      mailboxId: target.id,
      uid,
      messageId: msg.messageId,
      fromAddr: msg.fromAddr,
      toAddrs: msg.toAddrs,
      ccAddrs: msg.ccAddrs,
      subject: msg.subject,
      bodyPath: newPath,
      sizeBytes: msg.sizeBytes,
      flags: msg.flags.filter((f) => f !== "\\Recent"),
    });
  }

  socket.write(ok(tag, "COPY completed"));
}

async function handleUid(
  socket: Socket,
  session: ImapSession,
  tag: string,
  args: string,
  mailboxId: string
): Promise<void> {
  const [subCmd, ...rest] = args.split(" ");
  // Simplified: treat UID commands same as sequence-based
  await handleSelectedCommand(socket, session, tag, subCmd, rest.join(" "), mailboxId);
}

// Override to pass mailboxId
async function handleSelectedCommandWithMailbox(
  socket: Socket,
  session: ImapSession,
  tag: string,
  command: string,
  args: string,
  mailboxId: string
): Promise<void> {
  await handleSelectedCommand(socket, session, tag, command, args, mailboxId);
}

// ─── Sequence Set Parser ──────────────────────────────────────────────────────

function parseSequenceSet(seqSet: string, total: number): number[] {
  const result: number[] = [];
  const parts = seqSet.split(",");

  for (const part of parts) {
    if (part.includes(":")) {
      const [startStr, endStr] = part.split(":");
      const start = startStr === "*" ? total : parseInt(startStr);
      const end = endStr === "*" ? total : parseInt(endStr);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (i >= 1 && i <= total) result.push(i);
      }
    } else {
      const n = part === "*" ? total : parseInt(part);
      if (n >= 1 && n <= total) result.push(n);
    }
  }

  return [...new Set(result)].sort((a, b) => a - b);
}

// ─── IMAP Server ──────────────────────────────────────────────────────────────

export function startImapServer() {
  const server = Bun.listen({
    hostname: "0.0.0.0",
    port: config.IMAP_PORT,
    socket: {
      open(socket) {
        const session: ImapSession = {
          id: uuidv4(),
          state: "NOT_AUTHENTICATED",
          userId: null,
          userEmail: null,
          selectedMailboxId: null,
          selectedMailboxName: null,
          lineBuffer: "",
        };
        sessions.set(socket, session);
        socket.write(`* OK ${config.DOMAIN} IMAP4rev1 BunMail ready\r\n`);
      },

      data(socket, data) {
        const session = sessions.get(socket);
        if (!session) return;

        session.lineBuffer += data.toString();

        let newline: number;
        while ((newline = session.lineBuffer.indexOf("\r\n")) !== -1) {
          const line = session.lineBuffer.slice(0, newline);
          session.lineBuffer = session.lineBuffer.slice(newline + 2);

          const spaceIdx = line.indexOf(" ");
          if (spaceIdx === -1) continue;

          const tag = line.slice(0, spaceIdx);
          const rest = line.slice(spaceIdx + 1);
          const cmdEnd = rest.indexOf(" ");
          const cmd = cmdEnd === -1 ? rest : rest.slice(0, cmdEnd);
          const args = cmdEnd === -1 ? "" : rest.slice(cmdEnd + 1);

          handleCommand(socket, session, tag, cmd, args).catch((err) => {
            console.error("IMAP error:", err);
            socket.write(`${tag} BAD Internal error\r\n`);
          });
        }
      },

      close(socket) {
        sessions.delete(socket);
      },

      error(socket, err) {
        console.error("IMAP socket error:", err.message);
        sessions.delete(socket);
      },
    },
  });

  console.log(`📨 IMAP server listening on port ${config.IMAP_PORT}`);
  return server;
}
