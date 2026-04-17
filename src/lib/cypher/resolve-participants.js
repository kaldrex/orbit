// Cypher query used by both the ingest path (src/lib/neo4j.ts) and the
// bleed replay harness (scripts/replay-bleed.js). Keeping it in one place
// means the verification replay always tests what the server actually runs.
//
// Match cascade (in order):
//   1. by email   — case-insensitive, only if input.email is set
//   2. by phone   — exact (caller normalizes to digits-only)
//   3. by self    — input matches any known self-alias (email/phone/name)
//   4. by name    — case-insensitive, excluding category="self"
//   5. create new — with email/phone attached so the next tick matches
//
// After a match, opportunistically enrich the matched Person with any
// email/phone the input carried if those fields were null.

export const RESOLVE_PARTICIPANTS_CYPHER = `
UNWIND $batch AS p

// Candidate 1: email match
OPTIONAL MATCH (byEmail:Person {userId: $userId})
  WHERE p.email IS NOT NULL AND byEmail.email IS NOT NULL
    AND toLower(byEmail.email) = toLower(p.email)
WITH p, head(collect(byEmail)) AS byEmail

// Candidate 2: phone match
OPTIONAL MATCH (byPhone:Person {userId: $userId})
  WHERE p.phone IS NOT NULL AND byPhone.phone IS NOT NULL
    AND byPhone.phone = p.phone
WITH p, byEmail, head(collect(byPhone)) AS byPhone

// Candidate 3: self identity
OPTIONAL MATCH (bySelf:Person {userId: $userId, category: "self"})
  WHERE (p.email IS NOT NULL AND toLower(p.email) IN $selfEmails)
     OR (p.phone IS NOT NULL AND p.phone IN $selfPhones)
     OR (p.name IS NOT NULL AND toLower(p.name) IN $selfNames)
WITH p, byEmail, byPhone, head(collect(bySelf)) AS bySelf

// Candidate 4: name match (excluding self)
OPTIONAL MATCH (byName:Person {userId: $userId})
  WHERE p.name IS NOT NULL AND byName.name IS NOT NULL
    AND toLower(byName.name) = toLower(p.name)
    AND byName.category <> "self"
WITH p, byEmail, byPhone, bySelf, head(collect(byName)) AS byName

WITH p, COALESCE(byEmail, byPhone, bySelf, byName) AS existing

// Create new Person if no match
FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
  CREATE (:Person {
    id: p.newId, userId: $userId, name: p.name,
    email: p.email, phone: p.phone,
    category: "other", relationship_score: 1, source: "agent"
  })
)

// Opportunistic enrichment: fill in email/phone on matched Person if currently null
FOREACH (_ IN CASE WHEN existing IS NOT NULL AND p.email IS NOT NULL AND existing.email IS NULL THEN [1] ELSE [] END |
  SET existing.email = p.email
)
FOREACH (_ IN CASE WHEN existing IS NOT NULL AND p.phone IS NOT NULL AND existing.phone IS NULL THEN [1] ELSE [] END |
  SET existing.phone = p.phone
)

RETURN COALESCE(existing.id, p.newId) AS id, p.name AS name
`;

// Normalize phone to digits-only so identity matching is consistent across
// "+15551234" vs "15551234" vs "1 555 1234". Returns null for empty.
export function normalizePhone(input) {
  if (!input || typeof input !== "string") return null;
  const digits = input.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

// Normalize an email: trim + lowercase. Returns null for empty.
export function normalizeEmail(input) {
  if (!input || typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  return e.includes("@") ? e : null;
}
