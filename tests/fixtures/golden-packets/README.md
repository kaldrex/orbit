# Golden Packets

Canonical `person_packet_*.json` examples from the 2026-04-18 hypothesis test
(v3 — post Gmail widening, real data from Sanchay's channels).

Track 3's packet assembler (`GET /api/v1/person/:id/packet`) must produce
JSON diff-clean against these three fixtures for the named persons.

| Fixture | Person | Demo property |
|---|---|---|
| `person_packet_imran.json` | Imran Sable | cross-source work partner, RISING trend, 2 emails linked to 1 phone |
| `person_packet_aryan_yadav.json` | Aryan Yadav | going-cold (18d quiet), 150 interactions, unanswered questions preserved |
| `person_packet_hardeep.json` | Hardeep Gambhir | internal teammate, 21 shared WhatsApp groups via CO_PRESENT_IN |

Source: `outputs/hypothesis-test-20260418-v3/` (parent repo, untracked).
