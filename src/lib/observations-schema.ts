import { z } from "zod";

export const OBSERVERS = ["wazowski", "chad", "axe", "kite"] as const;

export const OBSERVATION_KINDS = [
  "interaction",
  "person",
  "correction",
  "merge",
  "split",
] as const;

export const INTERACTION_CHANNELS = [
  "slack",
  "whatsapp",
  "email",
  "meeting",
  "telegram",
  "linear",
  "github",
] as const;

export const INTERACTION_TOPICS = [
  "fundraising",
  "hiring",
  "product",
  "tech",
  "personal",
  "business",
] as const;

export const INTERACTION_SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
] as const;

export const PERSON_CATEGORIES = [
  "investor",
  "team",
  "sponsor",
  "fellow",
  "media",
  "community",
  "founder",
  "friend",
  "press",
  "other",
] as const;

export const CORRECTION_SOURCES = [
  "telegram",
  "decision-tinder",
  "other",
] as const;

const interactionPayloadSchema = z.object({
  participants: z.array(z.string().min(1).max(256)).min(1).max(50),
  channel: z.enum(INTERACTION_CHANNELS),
  summary: z.string().min(1).max(2000),
  topic: z.enum(INTERACTION_TOPICS),
  relationship_context: z.string().max(1000).default(""),
  connection_context: z.string().max(1000).default(""),
  sentiment: z.enum(INTERACTION_SENTIMENTS),
});

const personPayloadSchema = z.object({
  name: z.string().min(1).max(256),
  company: z.string().max(256).nullable().default(null),
  category: z.enum(PERSON_CATEGORIES),
  title: z.string().max(256).nullable().default(null),
  relationship_to_me: z.string().max(2000).default(""),
  phones: z.array(z.string().max(64)).default([]),
  emails: z.array(z.string().max(256)).default([]),
});

const correctionPayloadSchema = z.object({
  target_person_id: z.string().uuid(),
  field: z.string().min(1).max(64),
  old_value: z.unknown().nullable(),
  new_value: z.unknown(),
  source: z.enum(CORRECTION_SOURCES),
});

// Single-source merge is a valid terminal state (see
// memory/project_single_source_valid.md). A kind:"merge" with exactly one
// merged_observation_id materializes a person from a single origin obs —
// this is what the AddContactDialog uses for manual entry, and what a
// per-channel observer emits when only one channel has evidence for the
// human. Multi-source clusters use .length >= 2 and carry their bridges
// in deterministic_bridges[]; the shape is the same.
const mergePayloadSchema = z.object({
  person_id: z.string().uuid(),
  merged_observation_ids: z.array(z.string().uuid()).min(1),
  deterministic_bridges: z.array(z.string().max(256)).default([]),
});

const splitPayloadSchema = z.object({
  person_id: z.string().uuid(),
  split_off_observation_ids: z.array(z.string().uuid()).min(1),
  reason: z.string().min(1).max(1000),
});

const baseEnvelope = z.object({
  observed_at: z.string().datetime({ offset: true }),
  observer: z.enum(OBSERVERS),
  evidence_pointer: z.string().min(1).max(512),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export const observationSchema = z.discriminatedUnion("kind", [
  baseEnvelope.extend({
    kind: z.literal("interaction"),
    payload: interactionPayloadSchema,
  }),
  baseEnvelope.extend({
    kind: z.literal("person"),
    payload: personPayloadSchema,
  }),
  baseEnvelope.extend({
    kind: z.literal("correction"),
    payload: correctionPayloadSchema,
  }),
  baseEnvelope.extend({
    kind: z.literal("merge"),
    payload: mergePayloadSchema,
  }),
  baseEnvelope.extend({
    kind: z.literal("split"),
    payload: splitPayloadSchema,
  }),
]);

export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;
export type PersonPayload = z.infer<typeof personPayloadSchema>;
export type CorrectionPayload = z.infer<typeof correctionPayloadSchema>;
export type MergePayload = z.infer<typeof mergePayloadSchema>;
export type SplitPayload = z.infer<typeof splitPayloadSchema>;
export type Observation = z.infer<typeof observationSchema>;

export const MAX_BATCH = 100;
export const observationsBatchSchema = z
  .array(observationSchema)
  .min(1)
  .max(MAX_BATCH);
