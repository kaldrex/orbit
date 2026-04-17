import { queryNeo4j } from "@/lib/neo4j";

export interface SelfIdentity {
  selfNodeId: string;
  emails: string[]; // lowercased, trimmed
  phones: string[]; // digits only
  names: string[];  // lowercased, trimmed
}

// Cached per request via module-local WeakRef? — no, we just recompute per
// ingest call. It's a single Cypher read; the cost is ~2ms against Aura.
// Callers should invoke this ONCE per request and pass the result through.

/**
 * Build the self-identity signature used by batchResolveParticipants to
 * route self-references (the user's own WhatsApp messages, own email sends)
 * onto the single canonical self node.
 *
 * Sources:
 *   - Neo4j self node's name / email / phone
 *   - Caller-provided aliases (auth email, display name) from the session
 *
 * De-duplicates, lowercases, strips obvious garbage.
 */
export async function buildSelfIdentity(
  userId: string,
  selfNodeId: string,
  extras: { authEmail?: string; displayName?: string }
): Promise<SelfIdentity> {
  const rows = await queryNeo4j<{
    name: string | null;
    email: string | null;
    phone: string | null;
    aliases: string[] | null;
  }>(
    userId,
    `MATCH (p:Person {id: $selfNodeId, userId: $userId, category: "self"})
     RETURN p.name AS name, p.email AS email, p.phone AS phone, p.aliases AS aliases`,
    { selfNodeId }
  );

  const node = rows[0] ?? { name: null, email: null, phone: null, aliases: null };

  const emails = new Set<string>();
  const phones = new Set<string>();
  const names = new Set<string>();

  const addEmail = (e: string | null | undefined) => {
    if (!e) return;
    const t = e.trim().toLowerCase();
    if (t.includes("@")) emails.add(t);
  };
  const addPhone = (p: string | null | undefined) => {
    if (!p) return;
    const digits = String(p).replace(/\D/g, "");
    if (digits.length >= 7) phones.add(digits);
  };
  const addName = (n: string | null | undefined) => {
    if (!n) return;
    const t = n.trim().toLowerCase();
    if (t.length >= 2) names.add(t);
  };

  addEmail(node.email);
  addEmail(extras.authEmail);
  addPhone(node.phone);
  addName(node.name);
  addName(extras.displayName);

  // Aliases stored on the self node (future: user-provided "also known as" list)
  if (Array.isArray(node.aliases)) {
    for (const a of node.aliases) {
      if (typeof a !== "string") continue;
      if (a.includes("@")) addEmail(a);
      else if (/^\+?\d[\d\s-]+$/.test(a)) addPhone(a);
      else addName(a);
    }
  }

  return {
    selfNodeId,
    emails: Array.from(emails),
    phones: Array.from(phones),
    names: Array.from(names),
  };
}
