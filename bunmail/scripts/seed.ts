// scripts/seed.ts — Seed initial data for development

import postgres from "postgres";
import bcrypt from "bcryptjs";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://bunmail:bunmail@localhost:5432/bunmail";
const sql = postgres(DATABASE_URL, { transform: postgres.camel });

async function seed() {
  console.log("🌱 Seeding database...");

  // Add domain
  await sql`
    INSERT INTO domains (name, dkim_selector)
    VALUES ('mail.local', 'mail')
    ON CONFLICT (name) DO NOTHING
  `;
  console.log("  ✅ Domain: mail.local");

  // Add test users
  const hash = await bcrypt.hash("password123", 12);

  const [user1] = await sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES ('alice@mail.local', ${hash}, 'Alice')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `;

  const [user2] = await sql`
    INSERT INTO users (email, password_hash, display_name)
    VALUES ('bob@mail.local', ${hash}, 'Bob')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `;

  console.log("  ✅ Users: alice@mail.local, bob@mail.local (password: password123)");

  // Create default mailboxes
  const defaultBoxes = ["INBOX", "Sent", "Drafts", "Trash", "Spam"];

  for (const userId of [user1.id, user2.id]) {
    for (const name of defaultBoxes) {
      const uidValidity = Math.floor(Date.now() / 1000);
      await sql`
        INSERT INTO mailboxes (user_id, name, uid_validity)
        VALUES (${userId}, ${name}, ${uidValidity})
        ON CONFLICT (user_id, name) DO NOTHING
      `;
    }
  }

  console.log("  ✅ Mailboxes created");

  // Add alias example
  await sql`
    INSERT INTO aliases (from_email, to_email)
    VALUES ('postmaster@mail.local', 'alice@mail.local')
    ON CONFLICT (from_email) DO NOTHING
  `;
  console.log("  ✅ Alias: postmaster@mail.local → alice@mail.local");

  console.log("\n✅ Seed complete!");
  await sql.end();
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
