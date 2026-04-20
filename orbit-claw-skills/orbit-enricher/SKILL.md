---
name: orbit-enricher
description: Enrich existing skeleton person cards in Orbit with real category, relationship_to_me, company, title — by reading recent WhatsApp + Gmail context and emitting one new kind:"person" observation per person_id.
metadata: {"openclaw":{"emoji":"🪶"}}
---

# orbit-enricher

## When to use

- Sanchay (or an orchestrator script) hands you a batch of `person_id`s that are already in Orbit but only have skeleton cards (`category: "other"`, `relationship_to_me: null`).
- You enrich them in place by reading recent context for each and emitting a fresh `kind:"person"` observation that supersedes the skeleton via latest-wins assembly.
- This is a sibling to the `orbit-observer` skill. The observer creates new persons from a seed; the enricher upgrades existing persons in bulk.

## When NOT to use

- Do NOT use this to create new person rows. If a person doesn't exist in Orbit, that's the observer's job.
- Do NOT use this for already-enriched persons. Skip if `category != "other"` OR `relationship_to_me` is set to a non-null, non-placeholder value.
- Do NOT touch `kind:"interaction"`, `kind:"merge"`, `kind:"correction"` records — enricher is person-only.
- Do NOT use for Slack / Linear / Calendar — V0 is WhatsApp + Gmail only.

## Safety

- Read-only against `wacli` and `gws`. Never call `wacli send` or `gws gmail send`.
- Never write to Supabase directly. Go through `orbit_observation_emit` from the orbit-cli plugin.
- Never construct raw HTTP / curl. Use the tools.
- Drop persons whose name is phone-shaped or email-shaped (defensive — shouldn't happen post-cleanup).
- Drop persons with zero phones AND zero emails on their current card — no signal to enrich from.
- Drop persons where you can't pull a single real message of context — better to leave a skeleton than fabricate.

## Your tools

From the `orbit-rules` plugin:
- `orbit_rules_normalize_phone({phone, default_country?})` → `{e164, country_code, valid, original}`
- `orbit_rules_canonicalize_email({email})` → `{canonical, domain, valid, original}`
- `orbit_rules_domain_class({domain, localpart_for_bot_check?})` → `{class, confidence, evidence}`

From the `orbit-cli` plugin:
- `orbit_person_get({person_id})` → `{card}` — read existing card (phones, emails, name, current category)
- `orbit_observation_emit({observation})` → `{ok, accepted, inserted, deduped}` — write the enriched observation

From existing skills:
- `wacli messages search --chat <jid> --limit <N>`
- `gws gmail users messages list --q "..." --max-results <N>`
- `gws gmail users messages get --id <id>`

## Order of operations (per person_id in the batch)

For EACH `person_id` in the input list, do exactly this loop. When you're done with one, move to the next. Do not interleave persons.

1. **Fetch the current card.**
   - `orbit_person_get({person_id})` → `{card}`.
   - If the call errors or returns no card, log `enricher SKIP person=<id> reason=card_missing` and continue.
2. **Skip-if-already-enriched check.**
   - If `card.category` exists and is one of `investor|team|sponsor|fellow|media|community|founder|friend|press` (anything but `other`), log `enricher SKIP person=<id> reason=already_enriched category=<cat>` and continue. Do NOT re-emit.
   - Also skip if `card.relationship_to_me` is a non-empty string AND not the literal placeholder `"(skeleton — no enrichment yet)"`.
3. **Skip-if-no-signal check.**
   - If `card.phones.length === 0` AND `card.emails.length === 0`, log `enricher SKIP person=<id> reason=no_handles` and continue.
   - If `card.name` matches `^\+?\d{6,}$` (phone-as-name) or contains `@` (email-as-name), log `enricher SKIP person=<id> reason=name_is_handle` and continue.
4. **Pull recent context (read-only, capped).**
   - For EACH phone in `card.phones` (cap at 3 phones to keep cost bounded):
     - `wacli messages search --chat <phone-without-plus>@s.whatsapp.net --limit 30`
     - Capture: counterparty `push_name`/`full_name`, last 30 message bodies (up to ~5 KB total per chat — truncate per message to 200 chars).
   - For EACH email in `card.emails` (cap at 3 emails):
     - `gws gmail users messages list --q "from:<email> OR to:<email>" --max-results 10`
     - For up to 5 of those message ids: `gws gmail users messages get --id <id>` and capture From/To/Cc/Subject/Date headers + the first ~500 chars of the snippet/body.
   - Track: `dm_msg_count`, `gmail_msg_count`, `groups_seen` (group names only).
5. **Reason — pick category, relationship, company, title.**
   - **category** — one of `investor|team|sponsor|fellow|media|community|founder|friend|press|other`. Default to `other` ONLY if signal is genuinely ambiguous. Use these heuristics:
     - `investor` — VC firm domain, "term sheet", "deck", "ticket size", "diligence" in messages.
     - `team` — coworker in current company, daily ops talk, payroll/HR signals.
     - `founder` — they identify as founder/CEO of their own company in signature/bio.
     - `friend` — personal warmth, non-work topics dominate (movies, family, jokes).
     - `community` — meetup/hackathon/builder-group context, no work relationship.
     - `media` / `press` — journalist or podcast host reaching out for an interview.
     - `sponsor` — paying for / attending a Sanchay-hosted event in sponsor capacity.
     - `fellow` — same accelerator, fellowship, cohort.
     - `other` — explicitly couldn't tell.
   - **relationship_to_me** — 1-2 sentences, specific, no filler. Cite the actual signal you saw ("Worked together on X at Y", "Met at Z hackathon", "WhatsApp DM about ML projects", etc.). Never write "important contact" or "worth keeping in touch" or other generic prose.
   - **company** — best inference from email domain (`@stripe.com` → `Stripe`), Gmail signature, or DM context. Null if unclear.
   - **title** — best inference from signature, Calendly link, or stated role. Null if unclear.
   - **Bot drop** — if the dominant inbound sender's email domain classifies as `bot` (per `orbit_rules_domain_class`), log `enricher SKIP person=<id> reason=bot_only` and continue without emitting.
6. **Compose the observation envelope.**
   ```
   {
     "observed_at":      "<now ISO 8601 with offset>",
     "observer":         "wazowski",
     "kind":             "person",
     "evidence_pointer": "enrichment://stage-6-2026-04-20/person-<person_id>",
     "confidence":       0.8,                       // 0.85 if 5+ messages of strong signal; 0.7 if thin
     "reasoning":        "<one paragraph: how many DM messages, how many Gmail threads, what signals drove category + relationship inference>",
     "payload": {
       "name":               "<best name from card.name; do NOT change it>",
       "company":            "<inferred or null>",
       "category":           "<one of the 10 enums>",
       "title":              "<inferred or null>",
       "relationship_to_me": "<1-2 specific sentences>",
       "phones":             <copy card.phones verbatim>,
       "emails":             <copy card.emails verbatim>
     }
   }
   ```
   - **Do NOT add or remove phones/emails.** Enricher does not change identity — it changes interpretation. Identity edits are the resolver's job.
   - **Do NOT change the name** unless the existing name is clearly garbage and you have a strong replacement from a Gmail signature. If you do change it, mention it in `reasoning`.
7. **Emit.**
   - `orbit_observation_emit({observation: <envelope>})`.
   - Expected response: `{ok: true, accepted: 1, inserted: 1}` on first run; `{ok: true, accepted: 1, deduped: 1}` on idempotent re-run. Both are success.
   - On HTTP error or schema validation failure: log `enricher ERROR person=<id> error=<short>` and continue. Do NOT retry inside this skill — the orchestrator handles retries.
8. **Log one line per person.**
   ```
   enriched person=<id> name="<name>" category=<cat> confidence=<c> sources={dm:<N>,gmail:<N>,groups:<N>} result=<inserted|deduped|skipped|error>
   ```

## Confidence scale

- `0.85` — 5+ DM messages or 3+ full Gmail threads, clear category signal, real company/title.
- `0.80` — moderate signal: 2-4 DM messages or 1-2 Gmail threads, category obvious from one strong cue.
- `0.70` — thin signal: 1 message of context, category is best-guess.
- `0.60` — bare minimum: only the existing card metadata (phones/emails/name) gave you anything; you're inferring almost entirely from email domain. Use sparingly.

## Final batch summary

When the batch is done, print one line:
```
enricher batch_done size=<N> enriched=<N> skipped=<N> errors=<N>
```

## Worked example (one person)

Input: `person_id = "5dedb51c-a53f-402c-9f80-2f62062f5079"` (skeleton, name "Hardeep Gambhir", phones `[+919XXXXXXXXX]`, emails `[hardeep@example.com]`).

You should:
1. Read card → confirm `category=="other"`, has 1 phone + 1 email.
2. `wacli messages search --chat 919XXXXXXXXX@s.whatsapp.net --limit 30` → see 12 messages discussing AI infra.
3. `gws gmail users messages list --q "from:hardeep@example.com OR to:hardeep@example.com" --max-results 10` → see 3 threads about a hackathon.
4. Reason: category = `community` (hackathon co-organizer), relationship_to_me = "Met through Bangalore AI hackathon Mar 2025; ongoing technical discussions on inference infra over WhatsApp.", company = inferred from email domain, title = null.
5. Emit envelope with `confidence: 0.8`, `evidence_pointer: "enrichment://stage-6-2026-04-20/person-5dedb51c-a53f-402c-9f80-2f62062f5079"`.
6. Log: `enriched person=5dedb51c-... name="Hardeep Gambhir" category=community confidence=0.8 sources={dm:12,gmail:3,groups:0} result=inserted`.

## Hard rules

- One observation per person per batch run. No exceptions.
- Never fabricate. If signal is missing, drop the person and say so in the log.
- Never mutate phones, emails, or name unless the existing name is obviously a placeholder and you have a high-confidence replacement (mention in `reasoning`).
- Never call `orbit_observation_emit` with `kind != "person"` from this skill.
- Never call `orbit_observation_bulk` from this skill — single emit per person, one at a time.
