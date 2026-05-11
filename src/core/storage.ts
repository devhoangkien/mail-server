// src/core/storage.ts
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { config } from "./config";
import { v4 as uuidv4 } from "uuid";

// Implements a simplified Maildir++ format
// Structure: maildir/{userId}/{mailbox}/{new,cur,tmp}/

export const mailStorage = {
  async ensureMaildir(userId: string, mailbox: string): Promise<void> {
    const base = join(config.MAIL_DIR, userId, mailbox);
    for (const dir of ["new", "cur", "tmp"]) {
      const path = join(base, dir);
      if (!existsSync(path)) {
        await mkdir(path, { recursive: true });
      }
    }
  },

  async saveMessage(userId: string, mailbox: string, rawMessage: string): Promise<string> {
    await this.ensureMaildir(userId, mailbox);

    const filename = `${Date.now()}.${uuidv4()}.${config.HOSTNAME}`;
    const tmpPath = join(config.MAIL_DIR, userId, mailbox, "tmp", filename);
    const newPath = join(config.MAIL_DIR, userId, mailbox, "new", filename);

    // Write to tmp first, then move atomically
    await writeFile(tmpPath, rawMessage, "utf8");
    await Bun.write(newPath, await Bun.file(tmpPath).arrayBuffer());
    await unlink(tmpPath);

    return join(userId, mailbox, "new", filename); // relative path stored in DB
  },

  async readMessage(bodyPath: string): Promise<string> {
    const fullPath = join(config.MAIL_DIR, bodyPath);
    return readFile(fullPath, "utf8");
  },

  async deleteMessage(bodyPath: string): Promise<void> {
    const fullPath = join(config.MAIL_DIR, bodyPath);
    try {
      await unlink(fullPath);
    } catch {
      // ignore if already deleted
    }
  },

  async getMessageSize(bodyPath: string): Promise<number> {
    const fullPath = join(config.MAIL_DIR, bodyPath);
    const file = Bun.file(fullPath);
    return file.size;
  },

  // Move message from new/ to cur/ (marks as delivered/seen by client)
  async markDelivered(bodyPath: string): Promise<string> {
    if (!bodyPath.includes("/new/")) return bodyPath;

    const newPath = join(config.MAIL_DIR, bodyPath);
    const curPath = join(config.MAIL_DIR, bodyPath.replace("/new/", "/cur/"));

    try {
      await Bun.write(curPath, await Bun.file(newPath).arrayBuffer());
      await unlink(newPath);
      return bodyPath.replace("/new/", "/cur/");
    } catch {
      return bodyPath;
    }
  },
};
