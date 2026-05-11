// scripts/migrate.ts
import postgres from "postgres";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://bunmail:bunmail@localhost:5432/bunmail";
const sql = postgres(DATABASE_URL);

async function migrate() {
  console.log("🔄 Running migrations...");

  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const applied = await sql<{ filename: string }[]>`SELECT filename FROM _migrations ORDER BY id`;
  const appliedSet = new Set(applied.map((r) => r.filename));

  const migrationDir = "./migrations";
  const files = readdirSync(migrationDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  ⏭  ${file} (already applied)`);
      continue;
    }

    const content = readFileSync(join(migrationDir, file), "utf8");
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (filename) VALUES (${file})`;
    console.log(`  ✅ ${file}`);
    count++;
  }

  if (count === 0) {
    console.log("  Nothing to migrate.");
  } else {
    console.log(`\n✅ Applied ${count} migration(s)`);
  }

  await sql.end();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
