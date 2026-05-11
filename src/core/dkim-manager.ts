// src/core/dkim-manager.ts
// Generates and stores per-domain DKIM RSA key pairs in PostgreSQL

import { generateKeyPairSync, createSign } from "crypto";
import { sql } from "./db";
import { config } from "./config";

export interface DomainDkimInfo {
  domain: string;
  selector: string;
  privateKey: string;
  publicKey: string;
  dnsValue: string; // full TXT record value to put in DNS
}

// ─── Key Generation ───────────────────────────────────────────────────────────

export function generateDkimKeyPair(domain: string, selector: string): DomainDkimInfo {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Strip PEM headers/newlines for DNS record
  const pubKeyBase64 = publicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");

  const dnsValue = `v=DKIM1; k=rsa; p=${pubKeyBase64}`;

  return { domain, selector, privateKey, publicKey, dnsValue };
}

// ─── DB Operations ────────────────────────────────────────────────────────────

export const dkimManager = {
  async generateForDomain(domainName: string, selector = "mail"): Promise<DomainDkimInfo> {
    const info = generateDkimKeyPair(domainName, selector);

    await sql`
      UPDATE domains
      SET
        dkim_selector   = ${selector},
        dkim_private_key = ${info.privateKey},
        dkim_public_key  = ${info.publicKey},
        dkim_dns_value   = ${info.dnsValue}
      WHERE name = ${domainName}
    `;

    return info;
  },

  async getForDomain(domainName: string): Promise<DomainDkimInfo | null> {
    const [row] = await sql<{
      name: string;
      dkimSelector: string;
      dkimPrivateKey: string | null;
      dkimPublicKey: string | null;
      dkimDnsValue: string | null;
    }[]>`
      SELECT name, dkim_selector, dkim_private_key, dkim_public_key, dkim_dns_value
      FROM domains WHERE name = ${domainName} AND active = true
    `;

    if (!row || !row.dkimPrivateKey) return null;

    return {
      domain: row.name,
      selector: row.dkimSelector,
      privateKey: row.dkimPrivateKey,
      publicKey: row.dkimPublicKey!,
      dnsValue: row.dkimDnsValue!,
    };
  },

  // Sign a raw RFC5322 message using domain-specific DKIM key
  sign(info: DomainDkimInfo, rawMessage: string): string {
    const sep = rawMessage.indexOf("\r\n\r\n");
    const headerSection = rawMessage.substring(0, sep);
    const body = rawMessage.substring(sep + 4);

    const canonBody = canonicalizeBodyRelaxed(body);
    const bodyHash = sha256b64(canonBody);

    const headersToSign = ["from", "to", "subject", "date", "message-id", "mime-version"];
    const canonHeaders = canonicalizeHeadersRelaxed(headerSection, headersToSign);

    const timestamp = Math.floor(Date.now() / 1000);
    const dkimHeader = [
      "v=1",
      "a=rsa-sha256",
      "c=relaxed/relaxed",
      `d=${info.domain}`,
      `s=${info.selector}`,
      `t=${timestamp}`,
      `bh=${bodyHash}`,
      `h=${headersToSign.join(":")}`,
      "b=",
    ].join("; ");

    const sigInput = canonHeaders + `\r\ndkim-signature:${dkimHeader}`;

    const signer = createSign("RSA-SHA256");
    signer.update(sigInput);
    const sig = signer.sign(info.privateKey, "base64");
    const foldedSig = sig.match(/.{1,72}/g)!.join("\r\n\t");

    return `DKIM-Signature: ${dkimHeader}${foldedSig}\r\n${rawMessage}`;
  },
};

// ─── Canonicalization helpers ─────────────────────────────────────────────────

function canonicalizeBodyRelaxed(body: string): string {
  return body
    .split("\r\n")
    .map((l) => l.replace(/\s+/g, " ").trimEnd())
    .join("\r\n")
    .replace(/(\r\n)+$/, "\r\n");
}

function canonicalizeHeadersRelaxed(headers: string, names: string[]): string {
  const map = new Map<string, string>();
  let current = "";
  for (const line of headers.split("\r\n")) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      current += " " + line.trim();
    } else {
      if (current) {
        const idx = current.indexOf(":");
        map.set(current.slice(0, idx).toLowerCase(), current.slice(idx + 1).trim());
      }
      current = line;
    }
  }
  return names
    .filter((n) => map.has(n))
    .map((n) => `${n}:${map.get(n)}`)
    .join("\r\n");
}

function sha256b64(data: string): string {
  const { createHash } = require("crypto");
  return createHash("sha256").update(data).digest("base64");
}