// Mirror of src/lib/observations-schema.ts, trimmed to what the CLI needs
// for fail-fast local validation before POSTing. Kept in sync manually —
// this is plumbing, so the canonical schema still lives in the Next.js app;
// we just pre-validate here to surface errors before a network round-trip.

import { z } from "zod";

export const OBSERVERS = ["wazowski"];

export const OBSERVATION_KINDS = [
  "interaction",
  "person",
  "correction",
  "merge",
  "split",
];

const INTERACTION_CHANNELS = [
  "slack",
  "whatsapp",
  "email",
  "meeting",
  "telegram",
  "linear",
  "github",
];

const INTERACTION_TOPICS = [
  "fundraising",
  "hiring",
  "product",
  "tech",
  "personal",
  "business",
];

const INTERACTION_SENTIMENTS = ["positive", "neutral", "negative"];

const PERSON_CATEGORIES = [
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
];

const CORRECTION_SOURCES = ["telegram", "decision-tinder", "other"];

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

const mergePayloadSchema = z.object({
  person_id: z.string().uuid(),
  merged_observation_ids: z.array(z.string().uuid()).min(2),
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

export const MAX_BATCH = 100;

export const UUID_RE = /^[0-9a-f-]{36}$/i;
