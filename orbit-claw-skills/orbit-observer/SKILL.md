---
name: orbit-observer
description: Scan local WhatsApp + Gmail data for one seed human and emit observations into Orbit's basket.
metadata: {"openclaw":{"emoji":"🔭"}}
---

# orbit-observer

## When to use

- Sanchay asks "make a card for X", "what do we know about X", "scan Umayr / Hardeep / <name>".
- A resolver pass asks for a fresh re-observation of a specific seed.
- Single-seed only. Do NOT use for bulk ingestion — that's a future skill.

## When NOT to use

- For Slack / Linear / Calendar — V0 is WhatsApp + Gmail only.
- For people Sanchay hasn't actually DM'd with — this is about real cross-channel activity.
- Without a concrete seed (jid, phone, email, or resolved person name you can look up in wacli).

## Safety

- Read-only against `wacli`, `gws`. Never call `wacli send` or `gws gmail send`.
- Never write to Supabase directly. Go through Orbit's `POST /api/v1/observations`.
- Drop observations about bots / newsletters — see §safety drops below.
- Never emit more than one `kind:"interaction"` observation per thread (KNOWS-edge rule below).

## Your tools

From the `orbit-rules` plugin (call these instead of re-implementing):
- `orbit_rules_normalize_phone({phone, default_country?})` → `{e164, country_code, valid, original}`
- `orbit_rules_canonicalize_email({email})` → `{canonical, domain, valid, original}`
- `orbit_rules_domain_class({domain, localpart_for_bot_check?})` → `{class, confidence, evidence}`
- `orbit_rules_lid_to_phone({lid})` → `{phone, source_path}`
- `orbit_rules_fuzzy_match({name_a, name_b})` → `{score, reason}`

From the existing skills:
- `wacli chats list`, `wacli messages search`, `wacli contacts show`, `wacli groups list`
- `gws gmail users messages list`, `gws gmail users messages get`, `gws contacts list`

## Order of operations

Given a seed (jid, phone, or email), do these in order:

1. **Resolve the seed to a canonical identity tuple.**
   - If `@lid`, call `orbit_rules_lid_to_phone` → phone.
   - Call `orbit_rules_normalize_phone` on any phone.
   - Call `orbit_rules_canonicalize_email` on any email.
   - The result should be a tuple `{phone?, email?, jid?, lid?}`. At least one must be non-null.

2. **Gather WhatsApp state (via wacli).**
   - `wacli chats list --query <name or phone>` to find relevant chats (DM + groups).
   - For the DM: `wacli messages search --chat <dm_jid> --limit 100` to get recent messages.
   - `wacli contacts show --jid <jid>` for push_name / full_name.
   - For groups the seed is in: capture group names; do NOT fetch all group messages.

3. **Gather Gmail state (via gws).**
   - `gws gmail users messages list --q "from:<email> OR to:<email>" --max-results 50`.
   - For each msg id in the top 20: `gws gmail users messages get --id <id>` for From, To, Cc, Date, Subject, Message-ID, List-Unsubscribe headers only. Skip body.

4. **Gather Google Contacts (via gws).**
   - `gws contacts list --query <name>` for display names that match; record phones + emails.

5. **Classify each inbound sender.**
   - For every From email: call `orbit_rules_domain_class`. If class is `bot`, drop that message entirely.
   - For every sender name: reject if it matches `^\+?\d{6,}$` (phone-as-name) or contains `@` (email-as-name). Drop the observation.

6. **Group into interactions (KNOWS-edge rule).**
   - For each thread (WhatsApp chat_jid OR Gmail thread_id), collect the union of participants across all messages in the thread.
   - Emit ONE `kind:"interaction"` observation per thread with all N participants in `payload.participants[]`.
   - **Never emit N single-participant observations for the same thread.** A 1:1 DM is 2 participants (you + peer). A group of 5 is 5 participants, one observation.

7. **Emit person observations.**
   - For each unique human identified (with at least `phone` OR `email` canonical), emit ONE `kind:"person"` observation.
   - Include `phones[]`, `emails[]`, best `name`, inferred `company` (from email domain if `work` class), inferred `category`, 1-sentence `relationship_to_me`.

8. **POST to Orbit.**
   - URL: `${ORBIT_API_URL}/observations` (note: `ORBIT_API_URL` in env ends in `/api/v1`, so the path is just `/observations`).
   - Header: `Authorization: Bearer ${ORBIT_API_KEY}`.
   - Body: batches of ≤100 observations.

## Observation envelope (required fields)

Every observation you emit must have:
```
{
  "observed_at":      "<ISO 8601 with offset>",
  "observer":         "wazowski",
  "kind":             "interaction" | "person",
  "evidence_pointer": "wacli://messages/rowid=<N>" | "gmail://message-id/<rfc822-id>" | "wacli://contacts/jid=<jid>" | "gmail://from/<canonical-email>" | "google-contacts://resourceName/<name>",
  "confidence":       <0..1>,
  "reasoning":        "<one paragraph explaining WHY you emitted this, cite the concrete evidence you saw>",
  "payload":          <kind-specific>
}
```

## Interaction payload

```
{
  "participants":         ["Name1", "Name2"],
  "channel":              "whatsapp" | "gmail",  // others not used in V0
  "summary":              "1-sentence what happened (don't leak body text verbatim, paraphrase)",
  "topic":                "fundraising" | "hiring" | "product" | "tech" | "personal" | "business",
  "relationship_context": "why this interaction matters in the founder's life",
  "connection_context":   "how these participants know each other",
  "sentiment":            "positive" | "neutral" | "negative"
}
```

If you can't classify `topic` or `sentiment` confidently, pick the best fit and set `confidence: 0.6`. If truly impossible, pick `"business"` / `"neutral"` and lower confidence to 0.5.

## Person payload

```
{
  "name":                "Full Name" (best you can produce from wacli contacts + Gmail display names + Google Contacts),
  "company":             "Company" or null,
  "category":            "investor" | "team" | "sponsor" | "fellow" | "media" | "community" | "founder" | "friend" | "press" | "other",
  "title":               "Job Title" or null,
  "relationship_to_me":  "1-2 sentences on who this human is to Sanchay",
  "phones":              ["+E164", ...] (canonical E.164 only; skip invalid),
  "emails":              ["canonical@domain.com", ...] (canonical form only)
}
```

## Confidence scale (pick honestly)

- `0.95` — seen directly on disk with full provenance (wacli.db row, Gmail Message-Id, Google Contacts resourceName).
- `0.85` — seen indirectly (inferred from participant list, cross-referenced but not primary).
- `0.7` — heuristic classification (topic, sentiment, relationship_context from context clues).
- `0.5` — guess under uncertainty (fill-in-the-blank for required enum values you can't determine).

## Safety drops (enforce before emitting)

- Drop any participant whose name matches:
  - `^\+?\d{6,}$` (phone as name)
  - `.+@.+` (email as name)
  - `\s*$` (empty / whitespace)
  - Known bot names: `wazowski`, `chad`, `axe`, `kite`, `slackbot`, `github-actions`.
- Drop any message/thread where the sole sender's email has `domain_class === "bot"`.
- Drop any Gmail with `List-Unsubscribe` header OR `Precedence: bulk`.
- Drop `List-Id`-carrying messages (mailing lists).

## Identity format notes (WhatsApp)

- Direct message chat: `<phone>@s.whatsapp.net` (e.g. `971586783040@s.whatsapp.net`).
- Group chat: `<group_id>@g.us`.
- Group participant (LID mode): `<lid>@lid` — call `orbit_rules_lid_to_phone` to bridge.
- `wacli.db.contacts` has `jid, phone, push_name, full_name` — treat `full_name` as the best display name when present.

## Final log line

When you're done, print a one-line summary:
```
observed seed=<...> threads=<N> interactions=<N> persons=<N> posted inserted=<N> deduped=<N>
```

## Example call (for Umayr)

Input: `orbit-observer scan --seed 971586783040@s.whatsapp.net`

What you should produce:
- ~20-30 `kind:"interaction"` observations (one per distinct WA thread with activity in last 30 days + Gmail threads)
- 1 `kind:"person"` observation for Umayr, with phone, email, company, category, and a 1-2 sentence relationship summary.
- POSTed to Orbit in one batch of ≤100.

If any step fails (wacli offline, gws token expired, POST returns 4xx), log the failure, don't fabricate, emit what you have, exit with a truthful summary.
