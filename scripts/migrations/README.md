# Migrations

This directory is reserved for one-shot data-repair scripts that are *not*
part of the regular ingest or resolver pipeline.

**The identity resolver ([`packages/orbit-plugin/lib/identity-resolver.js`]
and the `orbit_resolve_identities` tool) is the universal path for
deduping Person nodes — including ghost self-nodes.** Every user's graph
self-heals the same way; no per-user migration is required.

If a new destructive one-shot is ever needed (e.g. a schema change that
can't be expressed through `/api/v1/merge`), the convention is:

- Name: `NNN-brief-description.js`
- Dry-run by default, `--apply` to execute
- Write a manifest to `.applied/` for audit
- Universal logic only — no hardcoded ids, names, or tenant constants

The earlier `001-self-dedup.js` was removed once the resolver learned to
handle self-ghosts universally (Phase 3). Historical audit record for
that one-shot is preserved under `.applied/`.
