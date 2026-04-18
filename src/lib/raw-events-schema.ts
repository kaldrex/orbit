import { z } from "zod";

export const RAW_EVENT_SOURCES = [
  "whatsapp",
  "gmail",
  "calendar",
  "slack",
  "linear",
] as const;

export const rawEventSchema = z.object({
  source: z.enum(RAW_EVENT_SOURCES),
  source_event_id: z.string().min(1).max(256),
  channel: z.string().min(1).max(64),
  connector_version: z.string().max(64).optional(),

  occurred_at: z.string().datetime({ offset: true }),

  direction: z.enum(["in", "out"]).optional().nullable(),
  thread_id: z.string().max(256).optional().nullable(),

  participants_raw: z.array(z.unknown()).default([]),
  participant_phones: z.array(z.string()).default([]),
  participant_emails: z.array(z.string()).default([]),

  body_preview: z
    .string()
    .max(512)
    .optional()
    .nullable()
    .transform((v) => (v == null ? v : v.slice(0, 160))),

  attachments_present: z.boolean().default(false),
  raw_ref: z.unknown().optional().nullable(),
});

export type RawEvent = z.infer<typeof rawEventSchema>;

export const MAX_BATCH = 500;
export const rawEventsBatchSchema = z
  .array(rawEventSchema)
  .min(1)
  .max(MAX_BATCH);
