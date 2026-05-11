// src/core/db.ts
import postgres from "postgres";
import { config } from "./config";

export const sql = postgres(config.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: postgres.camel,
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  quotaBytes: number;
  usedBytes: number;
  active: boolean;
  createdAt: Date;
}

export interface Domain {
  id: string;
  name: string;
  active: boolean;
  dkimSelector: string;
  createdAt: Date;
}

export interface Mailbox {
  id: string;
  userId: string;
  name: string;       // INBOX, Sent, Drafts, Trash, Spam
  uidValidity: number;
  uidNext: number;
  flags: string[];
  createdAt: Date;
}

export interface Message {
  id: string;
  mailboxId: string;
  uid: number;
  messageId: string;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs: string[];
  subject: string;
  bodyPath: string;   // path in maildir
  sizeBytes: number;
  flags: string[];    // \Seen, \Answered, \Flagged, \Deleted, \Draft
  internalDate: Date;
  createdAt: Date;
}

export interface Alias {
  id: string;
  fromEmail: string;
  toEmail: string;
  active: boolean;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export const db = {
  // Users
  async getUserByEmail(email: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE email = ${email.toLowerCase()} AND active = true
    `;
    return user ?? null;
  },

  async getUserById(id: string): Promise<User | null> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id}
    `;
    return user ?? null;
  },

  async createUser(data: {
    email: string;
    passwordHash: string;
    displayName: string;
    quotaBytes?: number;
  }): Promise<User> {
    const [user] = await sql<User[]>`
      INSERT INTO users (email, password_hash, display_name, quota_bytes)
      VALUES (${data.email.toLowerCase()}, ${data.passwordHash}, ${data.displayName}, ${data.quotaBytes ?? 1073741824})
      RETURNING *
    `;
    return user;
  },

  async updateUserQuota(userId: string, deltaBytes: number): Promise<void> {
    await sql`
      UPDATE users SET used_bytes = used_bytes + ${deltaBytes} WHERE id = ${userId}
    `;
  },

  // Domains
  async getDomain(name: string): Promise<Domain | null> {
    const [domain] = await sql<Domain[]>`
      SELECT * FROM domains WHERE name = ${name} AND active = true
    `;
    return domain ?? null;
  },

  async listDomains(): Promise<Domain[]> {
    return sql<Domain[]>`SELECT * FROM domains WHERE active = true`;
  },

  // Mailboxes
  async getMailboxes(userId: string): Promise<Mailbox[]> {
    return sql<Mailbox[]>`
      SELECT * FROM mailboxes WHERE user_id = ${userId} ORDER BY name
    `;
  },

  async getMailbox(userId: string, name: string): Promise<Mailbox | null> {
    const [mb] = await sql<Mailbox[]>`
      SELECT * FROM mailboxes WHERE user_id = ${userId} AND name = ${name}
    `;
    return mb ?? null;
  },

  async getMailboxById(id: string): Promise<Mailbox | null> {
    const [mb] = await sql<Mailbox[]>`SELECT * FROM mailboxes WHERE id = ${id}`;
    return mb ?? null;
  },

  async createMailbox(userId: string, name: string): Promise<Mailbox> {
    const uidValidity = Math.floor(Date.now() / 1000);
    const [mb] = await sql<Mailbox[]>`
      INSERT INTO mailboxes (user_id, name, uid_validity, uid_next)
      VALUES (${userId}, ${name}, ${uidValidity}, 1)
      RETURNING *
    `;
    return mb;
  },

  async incrementUidNext(mailboxId: string): Promise<number> {
    const [mb] = await sql<{ uidNext: number }[]>`
      UPDATE mailboxes SET uid_next = uid_next + 1 WHERE id = ${mailboxId} RETURNING uid_next
    `;
    return mb.uidNext - 1; // return the UID that was just assigned
  },

  // Messages
  async saveMessage(data: {
    mailboxId: string;
    uid: number;
    messageId: string;
    fromAddr: string;
    toAddrs: string[];
    ccAddrs: string[];
    subject: string;
    bodyPath: string;
    sizeBytes: number;
    flags?: string[];
    internalDate?: Date;
  }): Promise<Message> {
    const [msg] = await sql<Message[]>`
      INSERT INTO messages (mailbox_id, uid, message_id, from_addr, to_addrs, cc_addrs,
        subject, body_path, size_bytes, flags, internal_date)
      VALUES (
        ${data.mailboxId}, ${data.uid}, ${data.messageId},
        ${data.fromAddr}, ${data.toAddrs}, ${data.ccAddrs},
        ${data.subject}, ${data.bodyPath}, ${data.sizeBytes},
        ${data.flags ?? []}, ${data.internalDate ?? new Date()}
      )
      RETURNING *
    `;
    return msg;
  },

  async getMessages(mailboxId: string, options?: {
    flags?: string[];
    uid?: { min?: number; max?: number };
    limit?: number;
    offset?: number;
  }): Promise<Message[]> {
    return sql<Message[]>`
      SELECT * FROM messages
      WHERE mailbox_id = ${mailboxId}
        AND NOT ('\\Deleted' = ANY(flags))
      ORDER BY uid ASC
      LIMIT ${options?.limit ?? 1000}
      OFFSET ${options?.offset ?? 0}
    `;
  },

  async getMessage(mailboxId: string, uid: number): Promise<Message | null> {
    const [msg] = await sql<Message[]>`
      SELECT * FROM messages WHERE mailbox_id = ${mailboxId} AND uid = ${uid}
    `;
    return msg ?? null;
  },

  async updateMessageFlags(messageId: string, flags: string[]): Promise<void> {
    await sql`UPDATE messages SET flags = ${flags} WHERE id = ${messageId}`;
  },

  async getMessageCount(mailboxId: string): Promise<{ total: number; unseen: number }> {
    const [row] = await sql<{ total: number; unseen: number }[]>`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags)))::int as unseen
      FROM messages
      WHERE mailbox_id = ${mailboxId} AND NOT ('\\Deleted' = ANY(flags))
    `;
    return row;
  },

  async moveMessage(messageId: string, targetMailboxId: string, newUid: number): Promise<void> {
    await sql`
      UPDATE messages SET mailbox_id = ${targetMailboxId}, uid = ${newUid} WHERE id = ${messageId}
    `;
  },

  async deleteMessages(mailboxId: string): Promise<void> {
    await sql`
      DELETE FROM messages WHERE mailbox_id = ${mailboxId} AND '\\Deleted' = ANY(flags)
    `;
  },

  // Aliases
  async resolveAlias(email: string): Promise<string | null> {
    const [alias] = await sql<Alias[]>`
      SELECT * FROM aliases WHERE from_email = ${email.toLowerCase()} AND active = true
    `;
    return alias?.toEmail ?? null;
  },
};
