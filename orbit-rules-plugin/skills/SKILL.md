---
name: orbit-rules
description: Deterministic canonicalizers and bridges used by orbit-observer + orbit-resolver. Call these tools whenever you have a raw phone, email, domain, LID, or name pair — do not re-implement the logic in prose.
metadata: {"openclaw":{"emoji":"📏"}}
---

# orbit-rules

Five pure, stateless tools. Use them **before** you emit any phone, email, or person claim into Orbit — they are cheap and their output is the canonical form Orbit's resolver will merge on.

## When to call each

- **`orbit_rules_normalize_phone`** — any time you've seen a phone string (WhatsApp jid like `971586783040@s.whatsapp.net`, a Google Contacts entry, a message body). Pass the raw string in; get E.164 back. If the number is ambiguous (no country code), override `default_country` with the ISO code you can infer from context; defaults to IN.
- **`orbit_rules_canonicalize_email`** — any time you've seen an email in a Gmail header, an inline signature, or Google Contacts. Lowercases, strips `+suffix` aliases, collapses gmail/googlemail.
- **`orbit_rules_domain_class`** — when deciding whether an email sender is `personal | work | bot | saas | press | other`. Feed it just the domain (e.g. `sinxsolutions.ai`) or the full email split as `{domain, localpart_for_bot_check}` if the local-part matters (e.g. `noreply@example.com` — the `noreply@` pattern flags it even if the domain isn't on the bot list).
- **`orbit_rules_lid_to_phone`** — WhatsApp group messages carry `<lid>@lid` instead of a phone. Call this to map the LID back to a phone using `~/.wacli/session.db.whatsmeow_lid_map`. If it returns `phone: null`, the LID has no known phone bridge — record the LID as the identity and don't invent a phone.
- **`orbit_rules_fuzzy_match`** — comparing two name strings for merge candidacy. Returns a 0..1 score. Use >0.85 as a strong signal for auto-merge, 0.6-0.85 for LLM disambiguation candidates, <0.6 for "probably unrelated."

## Do NOT

- Re-implement any of this in your prompt output ("I'll just lowercase the email and strip spaces" — no, call the tool).
- Apply these tools blindly to bulk data; pass one value at a time and thread the canonical form forward.
- Treat tool output as authoritative if `valid: false` — that means the input didn't look like the thing it was supposed to be; record as unresolved in the observation, don't fabricate.

## Output contract

Every tool returns a JSON-string payload in the MCP envelope. Parse it. Each shape is documented in the tool's parameter block.
