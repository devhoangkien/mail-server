// src/smtp/dkim.ts
import { createSign, createVerify } from "crypto";
import { readFileSync, existsSync } from "fs";
import { config } from "../core/config";

// ─── DKIM Signer ──────────────────────────────────────────────────────────────

export class DKIMSigner {
  private privateKey: string | null = null;

  constructor() {
    if (existsSync(config.DKIM_PRIVATE_KEY_PATH)) {
      this.privateKey = readFileSync(config.DKIM_PRIVATE_KEY_PATH, "utf8");
    } else {
      console.warn("⚠️  DKIM private key not found. Outbound mail will not be DKIM-signed.");
    }
  }

  sign(domain: string, rawMessage: string): string {
    if (!this.privateKey) return rawMessage;

    // Split headers and body
    const sep = rawMessage.indexOf("\r\n\r\n");
    const headerSection = rawMessage.substring(0, sep);
    const body = rawMessage.substring(sep + 4);

    // Canonicalize body (relaxed)
    const canonBody = this.canonicalizeBodyRelaxed(body);
    const bodyHash = this.sha256Base64(canonBody);

    // Select headers to sign
    const headersToSign = ["from", "to", "subject", "date", "message-id", "mime-version"];
    const canonHeaders = this.canonicalizeHeadersRelaxed(headerSection, headersToSign);

    // Build DKIM-Signature header (without b= value)
    const timestamp = Math.floor(Date.now() / 1000);
    const dkimHeader = [
      "v=1",
      "a=rsa-sha256",
      `c=relaxed/relaxed`,
      `d=${domain}`,
      `s=${config.DKIM_SELECTOR}`,
      `t=${timestamp}`,
      `bh=${bodyHash}`,
      `h=${headersToSign.join(":")}`,
      "b=",
    ].join("; ");

    const signingInput = canonHeaders + `\r\ndkim-signature:${dkimHeader}`;

    const sign = createSign("RSA-SHA256");
    sign.update(signingInput);
    const signature = sign.sign(this.privateKey, "base64");

    // Fold signature at 72 chars
    const foldedSig = signature.match(/.{1,72}/g)!.join("\r\n\t");

    return `DKIM-Signature: ${dkimHeader}${foldedSig}\r\n${rawMessage}`;
  }

  private canonicalizeBodyRelaxed(body: string): string {
    return body
      .split("\r\n")
      .map((line) => line.replace(/\s+/g, " ").trimEnd())
      .join("\r\n")
      .replace(/(\r\n)+$/, "\r\n");
  }

  private canonicalizeHeadersRelaxed(headers: string, names: string[]): string {
    const headerMap = new Map<string, string>();
    const lines = headers.split("\r\n");

    let current = "";
    for (const line of lines) {
      if (line.startsWith(" ") || line.startsWith("\t")) {
        current += " " + line.trim();
      } else {
        if (current) {
          const [name, ...rest] = current.split(":");
          headerMap.set(name.toLowerCase(), rest.join(":").trim());
        }
        current = line;
      }
    }

    return names
      .filter((n) => headerMap.has(n))
      .map((n) => `${n}:${headerMap.get(n)}`)
      .join("\r\n");
  }

  private sha256Base64(data: string): string {
    const { createHash } = require("crypto");
    return createHash("sha256").update(data).digest("base64");
  }
}

// ─── SPF Checker (simplified) ─────────────────────────────────────────────────

export class SPFChecker {
  async check(senderDomain: string, senderIP: string): Promise<"pass" | "fail" | "neutral" | "none"> {
    try {
      // Look up SPF record
      const txtRecords = await Bun.dns.resolve(senderDomain, "TXT");
      const spfRecord = txtRecords.find((r: string) => r.startsWith("v=spf1"));

      if (!spfRecord) return "none";

      // Parse mechanisms
      const parts = spfRecord.split(" ");
      for (const part of parts) {
        if (part === "v=spf1") continue;
        if (part === "-all") return "fail";
        if (part === "~all") return "neutral";
        if (part === "+all") return "pass";

        if (part.startsWith("ip4:")) {
          const range = part.slice(4);
          if (this.ipInRange(senderIP, range)) return "pass";
        }

        if (part.startsWith("include:")) {
          const includeDomain = part.slice(8);
          const result = await this.check(includeDomain, senderIP);
          if (result === "pass") return "pass";
        }
      }

      return "neutral";
    } catch {
      return "neutral";
    }
  }

  private ipInRange(ip: string, range: string): boolean {
    if (!range.includes("/")) return ip === range;

    const [network, prefixStr] = range.split("/");
    const prefix = parseInt(prefixStr);
    const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;

    const ipNum = this.ipToNum(ip);
    const netNum = this.ipToNum(network);

    return (ipNum & mask) === (netNum & mask);
  }

  private ipToNum(ip: string): number {
    return ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  }
}

export const dkimSigner = new DKIMSigner();
export const spfChecker = new SPFChecker();
