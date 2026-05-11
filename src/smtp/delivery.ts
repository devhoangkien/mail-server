// src/smtp/delivery.ts
// Processes the outbound message queue and delivers to remote MTAs

import { queue, type QueuedMessage } from "../core/queue";
import { db } from "../core/db";
import { mailStorage } from "../core/storage";
import { simpleParser } from "mailparser";
import { config } from "../core/config";

interface MxRecord {
  exchange: string;
  priority: number;
}

async function resolveMx(domain: string): Promise<MxRecord[]> {
  try {
    const records = await Bun.dns.resolve(domain, "MX");
    return (records as MxRecord[]).sort((a, b) => a.priority - b.priority);
  } catch {
    // Fallback: try A record
    return [{ exchange: domain, priority: 10 }];
  }
}

async function deliverToRemote(msg: QueuedMessage, recipient: string): Promise<boolean> {
  const domain = recipient.split("@")[1];
  const mxRecords = await resolveMx(domain);

  for (const mx of mxRecords) {
    try {
      const success = await attemptDelivery(mx.exchange, msg.from, recipient, msg.data);
      if (success) return true;
    } catch (err) {
      console.error(`❌ Failed delivery to ${mx.exchange}:`, (err as Error).message);
    }
  }
  return false;
}

async function attemptDelivery(
  mxHost: string,
  from: string,
  to: string,
  rawMessage: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let state = "GREETING";

    const socket = Bun.connect({
      hostname: mxHost,
      port: 25,
      socket: {
        open(s) {
          // Wait for greeting
        },
        data(s, data) {
          const response = data.toString();
          const code = parseInt(response.slice(0, 3));

          switch (state) {
            case "GREETING":
              if (code === 220) {
                state = "EHLO";
                s.write(`EHLO ${config.DOMAIN}\r\n`);
              } else {
                reject(new Error(`Unexpected greeting: ${response}`));
              }
              break;

            case "EHLO":
              if (code === 250) {
                state = "MAIL";
                s.write(`MAIL FROM:<${from}>\r\n`);
              } else {
                reject(new Error(`EHLO rejected: ${response}`));
              }
              break;

            case "MAIL":
              if (code === 250) {
                state = "RCPT";
                s.write(`RCPT TO:<${to}>\r\n`);
              } else {
                reject(new Error(`MAIL FROM rejected: ${response}`));
              }
              break;

            case "RCPT":
              if (code === 250) {
                state = "DATA";
                s.write("DATA\r\n");
              } else {
                reject(new Error(`RCPT TO rejected: ${response}`));
              }
              break;

            case "DATA":
              if (code === 354) {
                state = "BODY";
                // Send message body, dot-stuff, end with .
                const stuffed = rawMessage
                  .split("\r\n")
                  .map((l) => (l.startsWith(".") ? "." + l : l))
                  .join("\r\n");
                s.write(stuffed + "\r\n.\r\n");
              } else {
                reject(new Error(`DATA rejected: ${response}`));
              }
              break;

            case "BODY":
              if (code === 250) {
                state = "QUIT";
                s.write("QUIT\r\n");
                resolve(true);
              } else {
                reject(new Error(`Message rejected: ${response}`));
              }
              break;

            case "QUIT":
              s.end();
              break;
          }
        },
        close() {},
        error(s, err) {
          reject(err);
        },
        connectError(s, err) {
          reject(err);
        },
        timeout(s) {
          reject(new Error("Connection timed out"));
          s.end();
        },
      },
    });
  });
}

async function deliverInbound(msg: QueuedMessage): Promise<void> {
  const parsed = await simpleParser(msg.data);

  for (const recipient of msg.to) {
    // Resolve alias
    let targetEmail = recipient;
    const alias = await db.resolveAlias(recipient);
    if (alias) targetEmail = alias;

    const user = await db.getUserByEmail(targetEmail);
    if (!user) {
      console.error(`❌ No local user for ${targetEmail}`);
      continue;
    }

    // Check quota
    if (user.usedBytes + (msg.data.length) > user.quotaBytes) {
      console.error(`❌ Quota exceeded for ${targetEmail}`);
      // TODO: send bounce
      continue;
    }

    // Get or create INBOX
    let inbox = await db.getMailbox(user.id, "INBOX");
    if (!inbox) {
      inbox = await db.createMailbox(user.id, "INBOX");
    }

    const uid = await db.incrementUidNext(inbox.id);
    const bodyPath = await mailStorage.saveMessage(user.id, "INBOX", msg.data);

    await db.saveMessage({
      mailboxId: inbox.id,
      uid,
      messageId: parsed.messageId ?? `<${msg.id}@${config.DOMAIN}>`,
      fromAddr: parsed.from?.text ?? msg.from,
      toAddrs: (parsed.to as any)?.value?.map((a: any) => a.address) ?? msg.to,
      ccAddrs: (parsed.cc as any)?.value?.map((a: any) => a.address) ?? [],
      subject: parsed.subject ?? "(no subject)",
      bodyPath,
      sizeBytes: msg.data.length,
      flags: [],
      internalDate: parsed.date ?? new Date(),
    });

    await db.updateUserQuota(user.id, msg.data.length);
    console.log(`✅ Delivered to ${targetEmail} (uid=${uid})`);
  }
}

// ─── Worker Loop ──────────────────────────────────────────────────────────────

export async function startDeliveryWorker(): Promise<void> {
  console.log("🚚 Delivery worker started");

  // Process outbound queue
  setInterval(async () => {
    await queue.promoteDelayed();

    const msg = await queue.dequeueOutbound();
    if (!msg) return;

    for (const recipient of msg.to) {
      const domain = recipient.split("@")[1];
      const localDomains = await db.listDomains();
      const isLocal = localDomains.some((d) => d.name === domain);

      if (isLocal) {
        await queue.enqueueInbound({ ...msg, to: [recipient] });
      } else {
        const success = await deliverToRemote(msg, recipient);
        if (!success) {
          if (msg.retries < 5) {
            // Exponential backoff: 5m, 15m, 1h, 4h, 24h
            const delays = [300, 900, 3600, 14400, 86400];
            await queue.requeueWithDelay(msg, delays[msg.retries]);
            console.warn(`⏰ Requeued ${recipient} (retry ${msg.retries + 1})`);
          } else {
            console.error(`💀 Permanent failure for ${recipient} after 5 retries`);
            // TODO: send bounce message to sender
          }
        }
      }
    }
  }, 1000); // poll every second

  // Process inbound queue
  setInterval(async () => {
    const msg = await queue.dequeueInbound();
    if (!msg) return;

    try {
      await deliverInbound(msg);
    } catch (err) {
      console.error("❌ Inbound delivery error:", err);
    }
  }, 500);
}
