// src/core/domain-resolver.ts
// Resolves a recipient address through: exact user → alias → wildcard alias → catch-all

import { sql } from "./db";
import { db } from "./db";

export type ResolveResult =
  | { type: "local_user";    userId: string; email: string }
  | { type: "alias";         target: string }
  | { type: "wildcard";      target: string; pattern: string }
  | { type: "catch_all";     target: string; domain: string }
  | { type: "not_found" };

export const domainResolver = {
  /**
   * Full resolution pipeline for a recipient address.
   * Order: exact user → exact alias → wildcard alias → catch-all → not_found
   */
  async resolve(recipient: string): Promise<ResolveResult> {
    const email = recipient.toLowerCase();
    const [localPart, domainPart] = email.split("@");
    if (!domainPart) return { type: "not_found" };

    // 1. Exact local user
    const user = await db.getUserByEmail(email);
    if (user) return { type: "local_user", userId: user.id, email: user.email };

    // 2. Exact alias
    const alias = await db.resolveAlias(email);
    if (alias) return { type: "alias", target: alias };

    // 3. Wildcard alias for this domain (*@domain.com)
    const wildcard = await this.resolveWildcard(domainPart);
    if (wildcard) return { type: "wildcard", target: wildcard, pattern: `*@${domainPart}` };

    // 4. Domain catch-all
    const catchAll = await this.resolveCatchAll(domainPart);
    if (catchAll) return { type: "catch_all", target: catchAll, domain: domainPart };

    return { type: "not_found" };
  },

  async resolveWildcard(domain: string): Promise<string | null> {
    const [row] = await sql<{ toEmail: string }[]>`
      SELECT to_email FROM wildcard_aliases
      WHERE domain = ${domain} AND active = true
      LIMIT 1
    `;
    return row?.toEmail ?? null;
  },

  async resolveCatchAll(domain: string): Promise<string | null> {
    const [row] = await sql<{ catchAllAddress: string }[]>`
      SELECT catch_all_address FROM domains
      WHERE name = ${domain} AND active = true AND catch_all_enabled = true
        AND catch_all_address IS NOT NULL
      LIMIT 1
    `;
    return row?.catchAllAddress ?? null;
  },

  /** Check if a domain is hosted on this server */
  async isLocalDomain(domain: string): Promise<boolean> {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM domains WHERE name = ${domain} AND active = true LIMIT 1
    `;
    return !!row;
  },

  /** List all active wildcard aliases */
  async listWildcards(): Promise<{ id: string; domain: string; toEmail: string; active: boolean; createdAt: Date }[]> {
    return sql`SELECT id, domain, to_email, active, created_at FROM wildcard_aliases ORDER BY domain`;
  },

  /** Upsert wildcard alias for a domain */
  async setWildcard(domain: string, toEmail: string): Promise<void> {
    await sql`
      INSERT INTO wildcard_aliases (domain, to_email)
      VALUES (${domain}, ${toEmail})
      ON CONFLICT (domain) DO UPDATE SET to_email = EXCLUDED.to_email, active = true
    `;
  },

  async deleteWildcard(domain: string): Promise<void> {
    await sql`UPDATE wildcard_aliases SET active = false WHERE domain = ${domain}`;
  },
};