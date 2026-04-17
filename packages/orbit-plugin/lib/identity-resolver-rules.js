// identity-resolver-rules.js — Stage A of Pass A (identity resolution).
//
// Deterministic cluster builder. Takes a list of Person entries
// { id, name, email, phone } and groups them into clusters where a merge
// is SAFE without calling an LLM. Ported from
// docs/data-science/intelligence_layer.py CanonicalNameResolver.
//
// Cluster criteria (any one of):
//   1. Shared email (exact, case-insensitive)
//   2. Shared phone (digits-only)
//   3. "Email-as-name": email local part matches an existing cluster's name
//      with ratio > 0.8 (e.g. "ramongberrios@gmail.com" ↔ "Ramon Berrios")
//   4. Abbreviation bridge: two names share a distinctive first name (>2
//      chars) AND one is an abbreviation of the other (e.g. "Ramon B" ↔
//      "Ramon Berrios") OR a single name bridges to a 2+ word full name
//      with a distinctive first name (>4 chars).
//
// Names NEVER merge on fuzzy similarity alone. "Ramon Berrios" and
// "Rahul Batra" do not cluster — different last names are decisive even
// though the first-initial matches.

// ── String similarity (Ratcliff-Obershelp, same algorithm as Python
//    difflib.SequenceMatcher) ────────────────────────────────────────────
//
// Minimal self-contained implementation — finds longest common substring
// recursively, ratio = 2*M / (T) where M is matching chars, T is total.
function sequenceMatcherRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const matches = lcsMatches(a, b, 0, a.length, 0, b.length);
  return (2 * matches) / (a.length + b.length);
}

function lcsMatches(a, b, alo, ahi, blo, bhi) {
  // Find the longest matching block between a[alo:ahi] and b[blo:bhi].
  let bestI = alo;
  let bestJ = blo;
  let bestSize = 0;
  const j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newJ2len = new Map();
    const ch = a[i];
    for (let j = blo; j < bhi; j++) {
      if (b[j] === ch) {
        const k = (j2len.get(j - 1) || 0) + 1;
        newJ2len.set(j, k);
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
    }
    j2len.clear();
    for (const [j, k] of newJ2len) j2len.set(j, k);
  }
  if (bestSize === 0) return 0;
  return (
    bestSize +
    lcsMatches(a, b, alo, bestI, blo, bestJ) +
    lcsMatches(a, b, bestI + bestSize, ahi, bestJ + bestSize, bhi)
  );
}

// ── Small helpers ──────────────────────────────────────────────────────

function normEmail(e) {
  if (!e || typeof e !== "string") return null;
  const t = e.trim().toLowerCase();
  return t.includes("@") ? t : null;
}
function normPhone(p) {
  if (!p || typeof p !== "string") return null;
  const d = p.replace(/\D/g, "");
  return d.length >= 7 ? d : null;
}
function stripSpecials(s) {
  return (s || "").replace(/[\s.\-_]/g, "");
}
function stripLeading(s) {
  return (s || "").replace(/^[~\s]+/, "").trim();
}
function firstName(name) {
  const parts = stripLeading(name).split(/\s+/);
  return (parts[0] || "").toLowerCase();
}

// ── Main resolver ──────────────────────────────────────────────────────

export class CanonicalNameResolver {
  constructor() {
    this._entries = []; // { id, name, email, phone }
    this._groups = new Map(); // gid → { ids: Set, names: Map<lowerName, displayName> }
    this._byEmail = new Map(); // email → gid
    this._byPhone = new Map(); // phone → gid
    this._byId = new Map(); // personId → gid
    this._nextGid = 0;
  }

  // `isSelf` marks the user's own canonical node. When a cluster contains
  // such an entry, self wins as canonical and the cluster auto-applies
  // even when it would otherwise be ambiguous.
  //
  // Deliberately does NOT accept a per-id aliases list — injecting alias
  // entries into the rules engine's input can drag unrelated clusters
  // together via the email-as-name bridge. The abbreviation rules (shared
  // first name + shared last name, shared first name + last-initial, etc.)
  // already cover the common self-dedup cases without that risk. Self-
  // alias matching at ingest time is handled separately by buildSelfIdentity.
  add({ id, name, email, phone, isSelf = false }) {
    if (!id || !name) return;
    this._entries.push({
      id,
      name: name.trim(),
      email: normEmail(email),
      phone: normPhone(phone),
      isSelf,
    });
  }

  resolve() {
    for (const entry of this._entries) {
      let gid = null;

      if (entry.email && this._byEmail.has(entry.email)) {
        gid = this._byEmail.get(entry.email);
      }

      if (entry.phone && this._byPhone.has(entry.phone)) {
        const pGid = this._byPhone.get(entry.phone);
        if (gid != null && gid !== pGid) {
          gid = this._mergeGroups(gid, pGid);
        } else if (gid == null) {
          gid = pGid;
        }
      }

      // Email-as-name bridge (e.g. "ramongberrios@gmail.com" ↔ "Ramon Berrios")
      if (entry.email && gid == null) {
        const localPart = entry.email.split("@")[0].replace(/[.\-_\d]/g, "");
        if (localPart.length > 4) {
          for (const [candidateGid, group] of this._groups) {
            for (const candidateName of group.names.keys()) {
              const cleanName = stripSpecials(candidateName);
              if (sequenceMatcherRatio(localPart, cleanName) > 0.8) {
                gid = candidateGid;
                break;
              }
            }
            if (gid != null) break;
          }
        }
      }

      if (gid == null) {
        gid = this._nextGid++;
        this._groups.set(gid, { ids: new Set(), names: new Map() });
      }

      const group = this._groups.get(gid);
      group.ids.add(entry.id);
      const lower = entry.name.toLowerCase();
      if (!group.names.has(lower)) group.names.set(lower, entry.name);
      this._byId.set(entry.id, gid);
      if (entry.email) this._byEmail.set(entry.email, gid);
      if (entry.phone) this._byPhone.set(entry.phone, gid);
    }

    // Cross-group abbreviation merging — loop until converged.
    let changed = true;
    while (changed) {
      changed = false;
      const gids = Array.from(this._groups.keys());
      outer: for (let i = 0; i < gids.length; i++) {
        if (!this._groups.has(gids[i])) continue;
        for (let j = i + 1; j < gids.length; j++) {
          if (!this._groups.has(gids[j])) continue;
          if (this._shouldMerge(gids[i], gids[j])) {
            this._mergeGroups(gids[i], gids[j]);
            changed = true;
            break outer;
          }
        }
      }
    }

    return this.getClusters();
  }

  _mergeGroups(keepGid, dropGid) {
    const keep = this._groups.get(keepGid);
    const drop = this._groups.get(dropGid);
    for (const id of drop.ids) {
      keep.ids.add(id);
      this._byId.set(id, keepGid);
    }
    for (const [lower, display] of drop.names) {
      if (!keep.names.has(lower)) keep.names.set(lower, display);
    }
    for (const [email, gid] of this._byEmail) {
      if (gid === dropGid) this._byEmail.set(email, keepGid);
    }
    for (const [phone, gid] of this._byPhone) {
      if (gid === dropGid) this._byPhone.set(phone, keepGid);
    }
    this._groups.delete(dropGid);
    return keepGid;
  }

  _shouldMerge(aGid, bGid) {
    const a = this._groups.get(aGid);
    const b = this._groups.get(bGid);
    for (const na of a.names.keys()) {
      for (const nb of b.names.keys()) {
        const partsA = stripLeading(na).split(/\s+/);
        const partsB = stripLeading(nb).split(/\s+/);

        // Skip if BOTH are single-word — too ambiguous
        if (partsA.length < 2 && partsB.length < 2) continue;

        // First name must match exactly
        if (!partsA[0] || !partsB[0] || partsA[0] !== partsB[0]) continue;

        // First name must be >2 chars
        if (partsA[0].length <= 2) continue;

        const [shorter, longer] =
          partsA.length <= partsB.length ? [partsA, partsB] : [partsB, partsA];

        // "Suhas" → "Suhas Sumukh" (distinctive first name, >4 chars)
        if (shorter.length === 1 && longer.length >= 2 && shorter[0].length > 4) {
          return true;
        }

        // "Ramon B" → "Ramon Berrios" (last token abbreviation)
        if (
          shorter.length >= 2 &&
          shorter[shorter.length - 1].length <= 2 &&
          longer.length >= 2
        ) {
          const shortLast = shorter[shorter.length - 1][0];
          const longLast = longer[longer.length - 1];
          if (longLast && longLast.startsWith(shortLast)) {
            return true;
          }
        }

        // "Sanchay Thalnerkar" → "Sanchay Sachin Thalnerkar" (middle name
        // optional). Both first and last tokens match, longer just inserts
        // middle tokens — same person.
        if (
          shorter.length >= 2 &&
          longer.length > shorter.length &&
          shorter[0] === longer[0] &&
          shorter[shorter.length - 1] === longer[longer.length - 1] &&
          shorter[shorter.length - 1].length >= 3
        ) {
          return true;
        }

        // Exact match after leading-char strip
        const stripA = stripLeading(na);
        const stripB = stripLeading(nb);
        if (stripA === stripB && stripA.split(/\s+/).length >= 2) return true;

        // Strong 2+ word similarity
        if (
          stripA.split(/\s+/).length >= 2 &&
          stripB.split(/\s+/).length >= 2 &&
          sequenceMatcherRatio(stripA, stripB) > 0.88
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // Returns clusters of size >= 2. Each cluster carries a `certainty`:
  //   - "certain": safe to auto-merge (all members share one first name and
  //     have compatible last names, OR the cluster contains the self node
  //     — ghost-self merges are always correct when they pass the bridge).
  //   - "ambiguous": shared identifier with heterogeneous last names — one
  //     real person owns the identifier, others are wrong-attribution.
  //     Defers to Stage B (LLM) or user review.
  getClusters() {
    const out = [];
    for (const group of this._groups.values()) {
      if (group.ids.size < 2) continue;
      const members = Array.from(group.ids);
      const entriesInGroup = this._entries.filter((e) => group.ids.has(e.id));
      const names = Array.from(group.names.values());

      // If a self entry exists in the group, self wins as canonical
      // unconditionally. Otherwise pick the "best" name — most word
      // parts, then longest.
      let best = null;
      const selfEntry = entriesInGroup.find((e) => e.isSelf);
      if (selfEntry) {
        best = selfEntry.id;
      } else {
        let bestScore = -1;
        for (const entry of entriesInGroup) {
          const parts = entry.name.trim().split(/\s+/).length;
          const score = parts * 100 + entry.name.length;
          if (score > bestScore) {
            bestScore = score;
            best = entry.id;
          }
        }
      }

      // Self-including clusters are always "certain" — merging ghost
      // self-nodes into the canonical self is the whole point of the pass.
      // For non-self clusters, check for heterogeneity.
      const certainty = selfEntry
        ? "certain"
        : this._classifyCertainty(entriesInGroup);

      out.push({
        canonical: best,
        members: members.filter((m) => m !== best),
        allMembers: members,
        names,
        certainty,
        isSelfMerge: Boolean(selfEntry),
        reasoning: this._reasoningFor(group, certainty, Boolean(selfEntry)),
        confidence: certainty === "certain" ? 1.0 : 0.0,
      });
    }
    return out;
  }

  // A cluster is AMBIGUOUS when it contains clearly distinct persons. We
  // check both first-name and last-name diversity:
  //
  //   - Multiple distinct FIRST names (≥3 chars, not prefixes of each
  //     other) → ambiguous. "Gabe + Gabriel" = same person (prefix).
  //     "Ashutosh + Shahid" on the same email = wrong-attribution.
  //   - Multiple distinct full LAST names (≥3 letters, not abbreviations
  //     or paren tags) → ambiguous. "Eric Guo + Eric Bernstein + Eric Gao"
  //     = three different people who got the wrong shared email.
  //
  // Either fires → defer to Stage B / user review.
  _classifyCertainty(entries) {
    const distinctFirsts = new Set();
    const distinctLasts = new Set();
    for (const e of entries) {
      const parts = stripLeading(e.name).split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      const first = parts[0].toLowerCase().replace(/[^a-z]/g, "");
      if (first.length >= 3) distinctFirsts.add(first);
      if (parts.length >= 2) {
        const lastRaw = parts[parts.length - 1];
        const isParenTag = /^\(.*\)$/.test(lastRaw);
        const isAbbrev = lastRaw.length <= 2;
        if (isParenTag || isAbbrev) continue;
        const lettersOnly = lastRaw.toLowerCase().replace(/[^a-z]/g, "");
        if (lettersOnly.length >= 3) distinctLasts.add(lettersOnly);
      }
    }

    // Multiple first names: ambiguous unless every pair is prefix-related
    // (e.g. "Sam ⊂ Samantha" — rare but real). Classic nicknames like
    // "Gabe ↔ Gabriel" aren't prefixes and correctly fall through to
    // Stage B (LLM) — the rules engine intentionally stays cautious here.
    if (distinctFirsts.size >= 2) {
      const firsts = Array.from(distinctFirsts);
      let allPrefix = true;
      for (let i = 0; i < firsts.length && allPrefix; i++) {
        for (let j = i + 1; j < firsts.length; j++) {
          if (!firsts[i].startsWith(firsts[j]) && !firsts[j].startsWith(firsts[i])) {
            allPrefix = false;
            break;
          }
        }
      }
      if (!allPrefix) return "ambiguous";
    }

    // Multiple distinct last names → ambiguous
    if (distinctLasts.size >= 2) return "ambiguous";

    return "certain";
  }

  _reasoningFor(group, certainty, isSelfMerge) {
    const tokens = [];
    const sharedEmails = new Set();
    const sharedPhones = new Set();
    for (const entry of this._entries) {
      if (!group.ids.has(entry.id)) continue;
      if (entry.email) sharedEmails.add(entry.email);
      if (entry.phone) sharedPhones.add(entry.phone);
    }
    if (sharedEmails.size === 1 && group.ids.size > 1) {
      tokens.push(`shared email ${Array.from(sharedEmails)[0]}`);
    }
    if (sharedPhones.size === 1 && group.ids.size > 1) {
      tokens.push(`shared phone ${Array.from(sharedPhones)[0]}`);
    }
    if (tokens.length === 0) {
      tokens.push(`abbreviation/name-bridge: ${Array.from(group.names.values()).join(" | ")}`);
    }
    const prefix = isSelfMerge
      ? "self-dedup"
      : certainty === "certain"
      ? "auto-merge"
      : "ambiguous — defer to Stage B/user";
    return `${prefix} — ${tokens.join("; ")}`;
  }
}
