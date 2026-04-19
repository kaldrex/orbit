# orbit-rules

OpenClaw plugin that provides five stateless deterministic rule tools to the `orbit-observer` and `orbit-resolver` skills on a founder's agent (currently Wazowski on `claw`).

## Tools

| tool | input | output |
|---|---|---|
| `orbit_rules_normalize_phone` | `{phone, default_country?}` | `{e164, country_code, valid, original}` |
| `orbit_rules_canonicalize_email` | `{email}` | `{canonical, domain, valid, original}` |
| `orbit_rules_domain_class` | `{domain, localpart_for_bot_check?}` | `{class, confidence, evidence}` — class ∈ {personal, work, bot, saas, press, other} |
| `orbit_rules_lid_to_phone` | `{lid, lid_map_source?}` | `{phone, source_path}` (phone may be null) |
| `orbit_rules_fuzzy_match` | `{name_a, name_b}` | `{score, reason}` — score 0..1 |

## Install (on claw)

Assumes node 20+ and npm installed.

```bash
# From the Orbit repo root on your dev machine
rsync -a orbit-rules-plugin/ claw:~/.openclaw/plugins/orbit-rules/

# On claw
ssh claw
cd ~/.openclaw/plugins/orbit-rules
npm install --omit=dev
# add to openclaw.json plugins.allowList if not already there
```

## Env vars

- `WACLI_SESSION_DB` — override path to the whatsmeow session.db (default: `~/.wacli/session.db`). Used only by `lid_to_phone`.
- `ORBIT_RULES_DEFAULT_COUNTRY` — ISO 3166-1 alpha-2 default country for `normalize_phone`. Default: `IN`.

## Tests

Unit tests live alongside the main Orbit test suite (`tests/unit/orbit-rules-plugin.test.mjs`). Run from repo root: `npm test`.
