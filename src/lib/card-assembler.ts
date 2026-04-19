import type {
  Observation,
  InteractionPayload,
  PersonPayload,
  CorrectionPayload,
} from "./observations-schema";

/**
 * The shape consumed by UI + agent reads. V0 card is minimal by design
 * per plan decision D — grow the card from what an honest first pass
 * actually produces, don't pre-commit to a large schema.
 */
export interface PersonCard {
  person_id: string;
  name: string | null;
  company: string | null;
  title: string | null;
  category: string | null;
  phones: string[];
  emails: string[];
  relationship_to_me: string;
  last_touch: string | null;
  one_paragraph_summary: string;
  observations: {
    interactions: ObservationRef[];
    recent_corrections: ObservationRef[];
    total: number;
  };
}

interface ObservationRef {
  id: string;
  observed_at: string;
  kind: Observation["kind"];
  evidence_pointer: string;
  confidence: number;
  summary: string;
}

/**
 * A row as it comes from the DB. We type it loosely here because the
 * DB row has extra columns (id, user_id, ingested_at, dedup_key) that
 * the zod schema doesn't — and the payload is `unknown` until we
 * dispatch on `kind`.
 */
export interface ObservationRow {
  id: string;
  user_id: string;
  observed_at: string;
  ingested_at: string;
  observer: string;
  kind: Observation["kind"];
  evidence_pointer: string;
  confidence: number;
  reasoning: string;
  payload: unknown;
}

/**
 * Pure assembly from a set of observations into a PersonCard.
 *
 * Algorithm (latest-wins + corrections-override):
 *  1. Filter to observations relevant to this person (callers pass
 *     pre-filtered sets; this function trusts the input).
 *  2. Walk `kind:"person"` observations in observed_at ASC order; fold
 *     the last non-null value of each field.
 *  3. Walk `kind:"correction"` observations in observed_at ASC order;
 *     overwrite the corresponding card field. Corrections are ground
 *     truth by convention (confidence=1.0, source=human).
 *  4. Aggregate phones/emails as the union across all person obs.
 *  5. last_touch = max observed_at across `kind:"interaction"` obs.
 *  6. one_paragraph_summary = latest person obs's relationship_to_me,
 *     plus (if space) the most recent interaction's summary.
 */
export function assembleCard(
  personId: string,
  rows: ObservationRow[],
): PersonCard {
  // Sort ascending for fold semantics.
  const sorted = [...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at));

  const phones = new Set<string>();
  const emails = new Set<string>();
  const interactions: ObservationRef[] = [];
  const corrections: ObservationRef[] = [];

  let name: string | null = null;
  let company: string | null = null;
  let title: string | null = null;
  let category: string | null = null;
  let relationship_to_me = "";
  let last_touch: string | null = null;

  for (const row of sorted) {
    if (row.kind === "person") {
      const p = row.payload as PersonPayload;
      if (p.name) name = p.name;
      if (p.company !== undefined && p.company !== null) company = p.company;
      if (p.title !== undefined && p.title !== null) title = p.title;
      if (p.category) category = p.category;
      if (p.relationship_to_me) relationship_to_me = p.relationship_to_me;
      for (const ph of p.phones ?? []) phones.add(ph);
      for (const em of p.emails ?? []) emails.add(em);
    } else if (row.kind === "interaction") {
      const p = row.payload as InteractionPayload;
      interactions.push({
        id: row.id,
        observed_at: row.observed_at,
        kind: row.kind,
        evidence_pointer: row.evidence_pointer,
        confidence: row.confidence,
        summary: p.summary,
      });
      if (!last_touch || row.observed_at > last_touch) {
        last_touch = row.observed_at;
      }
    } else if (row.kind === "correction") {
      const p = row.payload as CorrectionPayload;
      corrections.push({
        id: row.id,
        observed_at: row.observed_at,
        kind: row.kind,
        evidence_pointer: row.evidence_pointer,
        confidence: row.confidence,
        summary: `${p.field} -> ${JSON.stringify(p.new_value)}`,
      });
      // corrections override field-by-field
      switch (p.field) {
        case "name":
          if (typeof p.new_value === "string") name = p.new_value;
          break;
        case "company":
          if (p.new_value === null || typeof p.new_value === "string") {
            company = p.new_value as string | null;
          }
          break;
        case "title":
          if (p.new_value === null || typeof p.new_value === "string") {
            title = p.new_value as string | null;
          }
          break;
        case "category":
          if (typeof p.new_value === "string") category = p.new_value;
          break;
        case "relationship_to_me":
          if (typeof p.new_value === "string") relationship_to_me = p.new_value;
          break;
        case "phones":
          if (Array.isArray(p.new_value)) {
            phones.clear();
            for (const ph of p.new_value) {
              if (typeof ph === "string") phones.add(ph);
            }
          }
          break;
        case "emails":
          if (Array.isArray(p.new_value)) {
            emails.clear();
            for (const em of p.new_value) {
              if (typeof em === "string") emails.add(em);
            }
          }
          break;
        // unknown fields: no-op for V0; observation is still stored for audit.
      }
    }
    // kind === "merge" / "split" affect the person-observation link graph,
    // not the card content directly. They shape *which* observations are
    // included (handled by the caller's filter).
  }

  // Build a short summary: prefer relationship_to_me; append the most
  // recent interaction summary if it fits and isn't redundant.
  const recentInteraction = interactions.length
    ? interactions[interactions.length - 1].summary
    : "";
  const one_paragraph_summary = [relationship_to_me, recentInteraction]
    .filter((s) => s && s.length > 0)
    .join(" · ");

  return {
    person_id: personId,
    name,
    company,
    title,
    category,
    phones: Array.from(phones),
    emails: Array.from(emails),
    relationship_to_me,
    last_touch,
    one_paragraph_summary,
    observations: {
      interactions: interactions.slice(-20),
      recent_corrections: corrections.slice(-10),
      total: rows.length,
    },
  };
}
