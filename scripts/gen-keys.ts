// scripts/gen-keys.ts — Generate TLS and DKIM keys

import { execSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync } from "fs";

const CERTS_DIR = "./certs";

if (!existsSync(CERTS_DIR)) mkdirSync(CERTS_DIR);

console.log("🔑 Generating keys...\n");

// TLS self-signed cert (for dev — use Let's Encrypt in production)
if (!existsSync(`${CERTS_DIR}/cert.pem`)) {
  execSync(
    `openssl req -x509 -newkey rsa:4096 -keyout ${CERTS_DIR}/key.pem ` +
    `-out ${CERTS_DIR}/cert.pem -days 365 -nodes ` +
    `-subj "/C=VN/ST=Hanoi/L=Hanoi/O=BunMail/CN=mail.local"`,
    { stdio: "pipe" }
  );
  console.log("✅ TLS certificate generated: certs/cert.pem, certs/key.pem");
} else {
  console.log("⏭  TLS certificate already exists");
}

// DKIM RSA key pair
if (!existsSync(`${CERTS_DIR}/dkim-private.pem`)) {
  execSync(
    `openssl genrsa -out ${CERTS_DIR}/dkim-private.pem 2048`,
    { stdio: "pipe" }
  );
  execSync(
    `openssl rsa -in ${CERTS_DIR}/dkim-private.pem -pubout -out ${CERTS_DIR}/dkim-public.pem`,
    { stdio: "pipe" }
  );

  // Extract public key in DNS format
  const pubKeyRaw = execSync(
    `openssl rsa -in ${CERTS_DIR}/dkim-private.pem -pubout -outform DER 2>/dev/null | base64 -w 0`
  ).toString().trim();

  const dnsRecord = `v=DKIM1; k=rsa; p=${pubKeyRaw}`;

  writeFileSync(`${CERTS_DIR}/dkim-dns.txt`, dnsRecord);
  console.log("✅ DKIM keys generated: certs/dkim-private.pem, certs/dkim-public.pem");
  console.log("\n📋 Add this DNS TXT record for DKIM:");
  console.log(`   Hostname: mail._domainkey.yourdomain.com`);
  console.log(`   Value: ${dnsRecord.slice(0, 80)}...`);
  console.log(`   (Full value in certs/dkim-dns.txt)`);
} else {
  console.log("⏭  DKIM keys already exist");
}

console.log("\n✅ Done! Keys are in ./certs/");
