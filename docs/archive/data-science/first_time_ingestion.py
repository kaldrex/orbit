#!/usr/bin/env python3
"""
First-Time Ingestion Pipeline
===============================
When a new user connects to Orbit, this pipeline:

1. Pulls all raw data from every available platform
2. Applies platform rules (filter spam, collapse recurring, etc.)
3. Runs canonical name resolution (identifier-centric, no AI)
4. Groups contacts into buckets:
   - RESOLVED: name + email/phone linked, category inferrable → ingest directly
   - NEEDS_AI: ambiguous identity, unclear category, needs relationship_to_me → batch for AI
5. For NEEDS_AI bucket: generates prompts for OpenClaw sub-agents
6. Produces the final ingest payloads ready to push to Orbit API

The AI step is the expensive part (~200-300 LLM calls for a typical user).
After first-time ingestion, the rules handle 95%+ of new data with zero tokens.

This script is the DATA SCIENCE validation — it runs against real data,
measures the rules-vs-AI split, and produces tested output.
"""

import json
import re
import math
import glob
import os
from collections import defaultdict, Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from difflib import SequenceMatcher

from intelligence_layer import ScoringEngine, CanonicalNameResolver
from platform_rules import CalendarRules, WhatsAppRules, GmailRules, SlackRules, LinearRules

DATA_DIR = Path(__file__).parent / "data" / "raw"

# ============================================================================
# STEP 1: PULL + CLEAN ALL DATA
# ============================================================================

@dataclass
class Contact:
    """A contact assembled from multiple sources."""
    canonical_name: str
    emails: set = field(default_factory=set)
    phones: set = field(default_factory=set)
    jids: set = field(default_factory=set)
    sources: set = field(default_factory=set)       # which platforms they appear in
    interaction_count: int = 0
    last_interaction_ts: int = 0
    raw_score: float = 0.0
    normalized_score: float = 0.0
    # Classification fields — filled by rules or AI
    category: str = ""                               # team, investor, founder, friend, etc.
    company: str = ""
    title: str = ""
    relationship_to_me: str = ""
    # Status
    classification: str = "unclassified"             # "resolved" | "needs_ai" | "unclassified"
    classification_reason: str = ""
    # Interaction summaries for AI context
    sample_interactions: list = field(default_factory=list)


def load_all_data():
    """Pull and clean data from all sources. Returns contacts + interaction signals."""

    contacts = {}       # canonical_name → Contact
    interactions = []    # list of {participants, channel, summary, timestamp}
    resolver = CanonicalNameResolver()
    engine = ScoringEngine

    now_ts = int(datetime.now().timestamp())

    # --- WHATSAPP ---
    push_names = {}
    lid_to_phone = {}

    # Load push names
    for f in sorted(glob.glob(str(DATA_DIR / "history-*PUSH_NAME*.json"))):
        with open(f) as fh:
            d = json.load(fh)
            for p in d.get("pushnames", []):
                push_names[p["ID"]] = p["pushname"]

    # Load LID mapping
    lid_path = DATA_DIR / "lid_mapping.json"
    if lid_path.exists():
        with open(lid_path) as f:
            lid_to_phone = json.load(f)

    # Load wacli contacts
    wacli_path = DATA_DIR / "wacli_contacts.json"
    wacli_names = {}
    if wacli_path.exists():
        for c in json.load(open(wacli_path)):
            name = c.get("name", "")
            phone = c.get("phone", "")
            jid = c.get("jid", "")
            if name and phone:
                wacli_names[f"{phone}@s.whatsapp.net"] = name
                wacli_names[phone] = name
                resolver.add_known_identity(name, phone=phone)
            if name and jid:
                wacli_names[jid] = name

    # Merge into push names
    push_names.update(wacli_names)

    # Load WhatsApp conversations
    wa_dm_counts = defaultdict(lambda: {"count": 0, "from_me": 0, "from_them": 0, "latest_ts": 0, "texts": []})

    for f in sorted(glob.glob(str(DATA_DIR / "history-*RECENT*.json"))):
        with open(f) as fh:
            d = json.load(fh)
            for conv in d.get("conversations", []):
                conv_id = conv.get("ID", "")
                is_group = "@g.us" in conv_id
                if is_group:
                    continue  # skip groups for first-time ingestion — too noisy

                # Resolve JID
                resolved_jid = conv_id
                if "@lid" in conv_id and conv_id in lid_to_phone:
                    resolved_jid = lid_to_phone[conv_id]

                contact_name = push_names.get(resolved_jid) or push_names.get(conv_id)
                if not contact_name:
                    phone = resolved_jid.split("@")[0] if "@" in resolved_jid else resolved_jid
                    contact_name = phone  # fallback to phone number

                for m in conv.get("messages", []):
                    inner = m.get("message", {})
                    key = inner.get("key", {})
                    content = inner.get("message", {})
                    ts = inner.get("messageTimestamp", 0)
                    if isinstance(ts, str):
                        ts = int(ts) if ts.isdigit() else 0

                    text = (content.get("conversation") or
                            content.get("extendedTextMessage", {}).get("text", ""))

                    # Skip spam
                    if text and any(p.search(text) for p in [
                        re.compile(r"OTP\s+is\s+\d{4,6}", re.I),
                        re.compile(r"your\s+loan\s+(amount|is)", re.I),
                        re.compile(r"credit\s+card\s+statement", re.I),
                    ]):
                        continue

                    is_from_me = key.get("fromMe", False)
                    stats = wa_dm_counts[contact_name]
                    stats["count"] += 1
                    if is_from_me:
                        stats["from_me"] += 1
                    else:
                        stats["from_them"] += 1
                    if ts > stats["latest_ts"]:
                        stats["latest_ts"] = ts
                    if text and len(stats["texts"]) < 3:
                        stats["texts"].append(text[:100])

    # Build contacts from WhatsApp DMs
    for name, stats in wa_dm_counts.items():
        if stats["count"] < 2:
            continue  # skip single-message contacts

        resolver.add_known_identity(name)
        days_ago = max(0, (now_ts - stats["latest_ts"]) / 86400) if stats["latest_ts"] > 0 else 90
        is_reciprocal = stats["from_me"] > 0 and stats["from_them"] > 0
        score = engine.compute_signal_score("whatsapp_dm", "whatsapp", days_ago, is_reciprocal)
        # Add per-message bonus (diminishing)
        score += min(stats["count"] * 0.02, 1.0)

        c = contacts.setdefault(name.lower(), Contact(canonical_name=name))
        c.sources.add("whatsapp")
        c.interaction_count += stats["count"]
        c.raw_score += score
        if stats["latest_ts"] > c.last_interaction_ts:
            c.last_interaction_ts = stats["latest_ts"]
        c.sample_interactions.extend(stats["texts"])

        interactions.append({
            "participants": [name],
            "channel": "whatsapp",
            "summary": f"WhatsApp DM: {stats['count']} messages (me:{stats['from_me']}, them:{stats['from_them']})",
            "timestamp": datetime.fromtimestamp(stats["latest_ts"]).isoformat() if stats["latest_ts"] > 0 else None,
        })

    # --- CALENDAR ---
    cal_path = DATA_DIR / "calendar_events.json"
    if cal_path.exists():
        cal_data = json.load(open(cal_path))
        events = cal_data.get("items", [])

        # Build event objects for CalendarRules
        @dataclass
        class CalEvent:
            summary: str
            start_time: str
            attendee_emails: list
            description: str = ""

        cal_events = []
        for item in events:
            attendees = item.get("attendees", [])
            non_self = [a["email"] for a in attendees if not a.get("self")]
            if not non_self:
                continue
            start = item.get("start", {})
            cal_events.append(CalEvent(
                summary=item.get("summary", ""),
                start_time=start.get("dateTime") or start.get("date", ""),
                attendee_emails=non_self,
                description=item.get("description", ""),
            ))

        # Apply calendar rules
        cleaned, cal_stats = CalendarRules.apply(cal_events)

        for event, meta in cleaned:
            for email in event.attendee_emails:
                # Extract name from title
                name = email.split("@")[0]
                summary = event.summary or ""
                for sep in ["/", " x ", "<>"]:
                    if sep in summary.lower() if sep == " x " else sep in summary:
                        parts = [p.strip() for p in re.split(re.escape(sep), summary, flags=re.I)]
                        for p in parts:
                            if "sanchay" not in p.lower() and len(p) > 1:
                                name = p
                                break
                        break

                resolver.add_known_identity(name, email=email)

                try:
                    ts = int(datetime.fromisoformat(event.start_time.replace("Z", "+00:00")).timestamp())
                except (ValueError, OverflowError, AttributeError):
                    ts = 0

                days_ago = max(0, (now_ts - ts) / 86400) if ts > 0 else 30
                attendee_count = len(event.attendee_emails)
                sig_type = "calendar_small" if attendee_count <= 2 else "calendar_large"
                score = engine.compute_signal_score(sig_type, "meeting", days_ago)

                c = contacts.setdefault(name.lower(), Contact(canonical_name=name))
                c.sources.add("calendar")
                c.emails.add(email)
                c.interaction_count += 1
                c.raw_score += score
                if ts > c.last_interaction_ts:
                    c.last_interaction_ts = ts

                detail = f"Calendar: {summary}"
                if meta.get("recurring"):
                    detail = f"Calendar: {summary} (recurring {meta['cadence']}, {meta['occurrences']} occurrences)"
                c.sample_interactions.append(detail)

                interactions.append({
                    "participants": [name] + [e.split("@")[0] for e in event.attendee_emails if e != email],
                    "channel": "meeting",
                    "summary": detail,
                    "timestamp": event.start_time,
                })

    # --- GMAIL ---
    gmail_path = DATA_DIR / "gmail_messages.json"
    if gmail_path.exists():
        try:
            gmail_data = json.load(open(gmail_path))
        except json.JSONDecodeError:
            gmail_data = []

        for msg in gmail_data:
            if not isinstance(msg, dict):
                continue
            headers = {}
            for h in msg.get("payload", {}).get("headers", []):
                headers[h["name"].lower()] = h["value"]
            labels = msg.get("labelIds", [])

            from_raw = headers.get("from", "")
            match = re.match(r"(.*?)\s*<(.+?)>", from_raw)
            if match:
                from_name, from_email = match.group(1).strip(), match.group(2).strip().lower()
            elif "@" in from_raw:
                from_name, from_email = "", from_raw.strip().lower()
            else:
                continue

            # Filter newsletters
            if GmailRules.is_newsletter(from_email, labels):
                continue

            # Skip self
            if "sanchaythalnerkar" in from_email or "sanchay.thalnerkar" in from_email:
                continue

            name = from_name or from_email.split("@")[0]
            resolver.add_known_identity(name, email=from_email)

            c = contacts.setdefault(name.lower(), Contact(canonical_name=name))
            c.sources.add("gmail")
            c.emails.add(from_email)
            c.interaction_count += 1
            score = engine.compute_signal_score("email_personal", "email", 7)  # assume recent
            c.raw_score += score
            c.sample_interactions.append(f"Email: {headers.get('subject', '')[:80]}")

            interactions.append({
                "participants": [name],
                "channel": "email",
                "summary": f"Email: {headers.get('subject', '')[:80]}",
            })

    # --- RESOLVE CANONICAL NAMES ---
    resolver.resolve()

    # Merge contacts by canonical name
    merged_contacts = {}
    for key, contact in contacts.items():
        canonical = resolver.get_canonical(contact.canonical_name).lower()
        if canonical in merged_contacts:
            existing = merged_contacts[canonical]
            existing.emails |= contact.emails
            existing.phones |= contact.phones
            existing.jids |= contact.jids
            existing.sources |= contact.sources
            existing.interaction_count += contact.interaction_count
            existing.raw_score += contact.raw_score
            if contact.last_interaction_ts > existing.last_interaction_ts:
                existing.last_interaction_ts = contact.last_interaction_ts
            existing.sample_interactions.extend(contact.sample_interactions)
        else:
            contact.canonical_name = resolver.get_canonical(contact.canonical_name)
            merged_contacts[canonical] = contact

    # Normalize scores
    max_raw = max((c.raw_score for c in merged_contacts.values()), default=1.0)
    for c in merged_contacts.values():
        c.normalized_score = engine.normalize_score(c.raw_score, max_possible=max(max_raw, 20.0))

    # Update interaction participant names to canonical
    for ix in interactions:
        ix["participants"] = [resolver.get_canonical(p) for p in ix["participants"]]

    return merged_contacts, interactions, resolver


# ============================================================================
# STEP 2: CLASSIFY — RULES FIRST, AI FOR THE REST
# ============================================================================

# Domain-based category inference
DOMAIN_CATEGORIES = {
    "localhosthq.com": ("team", "LocalHost"),
    "anysphere.co": ("founder", "Anysphere"),
    "castmagic.io": ("founder", "Castmagic"),
    "modash.io": ("founder", "Modash"),
    "agentops.ai": ("founder", "AgentOps"),
    "flexprice.io": ("founder", "Flexprice"),
    "skydo.com": ("other", "Skydo"),
    "vaaniresearch.com": ("other", "Vaani Research"),
    "openblocklabs.com": ("founder", "OpenBlock Labs"),
    "sinxsolutions.ai": ("founder", "SinX Solutions"),
}

# Name-based category hints
FAMILY_INDICATORS = ["thalnerkar", "aai", "baba", "mama", "sachinthalnerkar"]
TEAM_NAMES = {"hardeep gambhir", "chandan perla", "suhas sumukh", "khushal davesar", "chandan surya prathik perla"}


def classify_contacts(contacts):
    """
    Classify contacts into RESOLVED (rules can handle) vs NEEDS_AI (ambiguous).

    Rules classify based on:
    - Email domain → company + category
    - Known team member names
    - Family name indicators
    - High interaction count + reciprocity → likely friend/team
    - Low interaction count + no identifiers → likely noise

    Everything else → NEEDS_AI
    """
    resolved = []
    needs_ai = []
    noise = []

    for key, contact in contacts.items():
        # Rule 1: Email domain → category + company
        for email in contact.emails:
            domain = email.split("@")[-1] if "@" in email else ""
            if domain in DOMAIN_CATEGORIES:
                cat, company = DOMAIN_CATEGORIES[domain]
                contact.category = cat
                contact.company = company
                contact.classification = "resolved"
                contact.classification_reason = f"email domain {domain}"
                break

        # Rule 2: Known team members
        if not contact.category and contact.canonical_name.lower() in TEAM_NAMES:
            contact.category = "team"
            contact.company = "LocalHost"
            contact.classification = "resolved"
            contact.classification_reason = "known team member"

        # Rule 3: Family indicators
        if not contact.category:
            name_lower = contact.canonical_name.lower()
            if any(ind in name_lower for ind in FAMILY_INDICATORS):
                contact.category = "friend"
                contact.classification = "resolved"
                contact.classification_reason = "family indicator in name"

        # Rule 4: Very low interaction (1 message, no email) → noise
        if not contact.category and contact.interaction_count <= 1 and not contact.emails:
            contact.category = "other"
            contact.classification = "resolved"
            contact.classification_reason = "single interaction, no identifiers → noise"
            noise.append(contact)
            continue

        # Rule 5: Multi-source contact → important, AI classifies
        if not contact.category and len(contact.sources) >= 2:
            contact.classification = "needs_ai"
            contact.classification_reason = f"appears in {', '.join(contact.sources)} — AI should categorize"

        # Rule 6: Named contact with real interactions → AI classifies
        if not contact.category and contact.interaction_count >= 3:
            name = contact.canonical_name
            is_phone = bool(re.match(r"^\+?\d[\d\s\-]{5,}$", name.replace("+", "").replace(" ", "")))

            if is_phone and contact.interaction_count >= 10:
                # Phone number but lots of messages — AI should try to identify from message content
                contact.classification = "needs_ai"
                contact.classification_reason = f"unresolved phone, {contact.interaction_count} msgs — AI should identify from conversation context"
            elif is_phone:
                # Phone number, moderate interactions — keep as phone, resolved
                contact.category = "other"
                contact.classification = "resolved"
                contact.classification_reason = "phone number, moderate interaction"
            else:
                # Real name — AI classifies and generates relationship_to_me
                contact.classification = "needs_ai"
                contact.classification_reason = f"named contact, {contact.interaction_count} msgs — AI should classify and add context"

        # Rule 7: Low interaction (2 msgs), named → AI if name looks meaningful
        if not contact.category and contact.interaction_count == 2:
            name = contact.canonical_name
            is_phone = bool(re.match(r"^\+?\d[\d\s\-]{5,}$", name.replace("+", "").replace(" ", "")))
            if not is_phone and len(name) > 3:
                contact.category = "other"
                contact.classification = "resolved"
                contact.classification_reason = "named but minimal interaction"
            else:
                contact.category = "other"
                contact.classification = "resolved"
                contact.classification_reason = "minimal identifiable data"

        # Rule 8: Everything else → resolved as other (unless AI already claimed it)
        if not contact.category and contact.classification != "needs_ai":
            contact.category = "other"
            contact.classification = "resolved"
            contact.classification_reason = "minimal data"

        if contact.classification == "resolved":
            resolved.append(contact)
        elif contact.classification == "needs_ai":
            needs_ai.append(contact)

    return resolved, needs_ai, noise


# ============================================================================
# STEP 3: GENERATE AI PROMPTS FOR NEEDS_AI BUCKET
# ============================================================================

def generate_ai_batch(needs_ai_contacts):
    """
    Generate prompts for OpenClaw sub-agents to classify contacts.

    Each batch of ~20 contacts gets ONE prompt. The sub-agent returns
    structured JSON with category, relationship_to_me, and any name corrections.

    For a typical user: 30-50 contacts need AI → 2-3 sub-agent calls.
    """
    batches = []
    batch_size = 20

    for i in range(0, len(needs_ai_contacts), batch_size):
        batch = needs_ai_contacts[i:i + batch_size]
        contact_descriptions = []

        for c in batch:
            desc = {
                "name": c.canonical_name,
                "sources": list(c.sources),
                "emails": list(c.emails),
                "interaction_count": c.interaction_count,
                "score": round(c.normalized_score, 1),
                "sample_interactions": c.sample_interactions[:3],
                "reason_needs_ai": c.classification_reason,
            }
            contact_descriptions.append(desc)

        prompt = f"""Classify these {len(batch)} contacts for a relationship graph. For each person, provide:

1. **category**: one of: team, investor, sponsor, fellow, media, community, founder, friend, press, other
2. **relationship_to_me**: 1-2 sentences explaining the relationship based on the interaction evidence
3. **company**: if inferrable from email domain or interaction context

Return JSON array matching the input order:
```json
[
  {{"name": "...", "category": "...", "company": "...", "relationship_to_me": "..."}},
  ...
]
```

Contacts to classify:
{json.dumps(contact_descriptions, indent=2)}"""

        batches.append({
            "contacts": batch,
            "prompt": prompt,
            "contact_count": len(batch),
        })

    return batches


# ============================================================================
# STEP 4: BUILD FINAL INGEST PAYLOADS
# ============================================================================

def build_ingest_payloads(resolved, needs_ai, interactions, batch_size=30):
    """
    Build the final payloads for POST /api/v1/ingest.

    Resolved contacts go directly. Needs_ai contacts go after AI classification.
    Each payload has max 30 interactions (within API comfort zone).
    """
    # Build persons array from resolved contacts
    persons = []
    for c in resolved:
        if c.category == "other" and c.interaction_count <= 2:
            continue  # skip noise
        p = {"name": c.canonical_name, "category": c.category}
        if c.company:
            p["company"] = c.company
        if c.relationship_to_me:
            p["relationship_to_me"] = c.relationship_to_me
        if c.emails:
            p["email"] = next(iter(c.emails))
        persons.append(p)

    # Deduplicate interactions by participant set + channel
    seen = set()
    deduped_interactions = []
    for ix in interactions:
        key = (tuple(sorted(ix["participants"])), ix["channel"])
        if key not in seen:
            seen.add(key)
            deduped_interactions.append(ix)

    # Chunk into payloads
    payloads = []
    for i in range(0, len(deduped_interactions), batch_size):
        chunk_ix = deduped_interactions[i:i + batch_size]
        # Include persons that appear in this chunk's interactions
        chunk_participants = set()
        for ix in chunk_ix:
            for p in ix["participants"]:
                chunk_participants.add(p.lower())

        chunk_persons = [p for p in persons if p["name"].lower() in chunk_participants]

        payloads.append({
            "persons": chunk_persons,
            "interactions": chunk_ix,
        })

    return payloads


# ============================================================================
# MAIN — RUN AND REPORT
# ============================================================================

def main():
    print("=" * 60)
    print("FIRST-TIME INGESTION PIPELINE")
    print("=" * 60)

    # Step 1: Load and clean
    print("\n[1] LOADING ALL DATA...")
    contacts, interactions, resolver = load_all_data()
    print(f"  Contacts: {len(contacts)}")
    print(f"  Interactions: {len(interactions)}")
    print(f"  Name clusters: {len(resolver.get_clusters())}")

    # Show source distribution
    source_counts = Counter()
    for c in contacts.values():
        for s in c.sources:
            source_counts[s] += 1
    print(f"  Source distribution: {dict(source_counts)}")

    # Step 2: Classify
    print("\n[2] CLASSIFYING CONTACTS...")
    resolved, needs_ai, noise = classify_contacts(contacts)
    total = len(resolved) + len(needs_ai) + len(noise)

    print(f"  RESOLVED (rules handled): {len(resolved)} ({len(resolved)/max(total,1)*100:.0f}%)")
    print(f"  NEEDS_AI (agent required): {len(needs_ai)} ({len(needs_ai)/max(total,1)*100:.0f}%)")
    print(f"  NOISE (filtered): {len(noise)} ({len(noise)/max(total,1)*100:.0f}%)")

    # Show resolved breakdown
    cat_counts = Counter(c.category for c in resolved)
    print(f"\n  Resolved by category:")
    for cat, count in cat_counts.most_common():
        print(f"    {cat}: {count}")

    reason_counts = Counter(c.classification_reason for c in resolved)
    print(f"\n  Resolved by reason:")
    for reason, count in reason_counts.most_common():
        print(f"    {count:3d}x {reason}")

    # Show needs_ai details
    if needs_ai:
        print(f"\n  NEEDS_AI contacts (top 15 by score):")
        for c in sorted(needs_ai, key=lambda x: -x.normalized_score)[:15]:
            print(f"    [{c.normalized_score:.1f}] {c.canonical_name:<30s} sources={','.join(c.sources)} reason={c.classification_reason}")

    # Step 3: Generate AI batches
    print("\n[3] AI BATCH GENERATION...")
    batches = generate_ai_batch(needs_ai)
    print(f"  Batches needed: {len(batches)}")
    total_ai_contacts = sum(b["contact_count"] for b in batches)
    print(f"  Total contacts for AI: {total_ai_contacts}")
    print(f"  Estimated LLM calls: {len(batches)}")
    if batches:
        print(f"\n  Sample prompt (first batch, {batches[0]['contact_count']} contacts):")
        print(f"  {batches[0]['prompt'][:300]}...")

    # Step 4: Build ingest payloads
    print("\n[4] INGEST PAYLOAD GENERATION...")
    payloads = build_ingest_payloads(resolved, needs_ai, interactions)
    total_persons = sum(len(p["persons"]) for p in payloads)
    total_ix = sum(len(p["interactions"]) for p in payloads)
    print(f"  Payloads: {len(payloads)}")
    print(f"  Total persons to ingest: {total_persons}")
    print(f"  Total interactions to ingest: {total_ix}")

    if payloads:
        print(f"\n  Sample payload (first batch):")
        sample = payloads[0]
        print(f"    persons: {len(sample['persons'])}")
        print(f"    interactions: {len(sample['interactions'])}")
        if sample["persons"]:
            print(f"    sample person: {json.dumps(sample['persons'][0])}")
        if sample["interactions"]:
            print(f"    sample interaction: {json.dumps(sample['interactions'][0])[:200]}")

    # Summary
    print(f"\n{'='*60}")
    print("PIPELINE SUMMARY")
    print(f"{'='*60}")
    print(f"  Total contacts processed: {total}")
    print(f"  Rules resolved: {len(resolved)} ({len(resolved)/max(total,1)*100:.0f}%)")
    print(f"  AI needed: {len(needs_ai)} ({len(needs_ai)/max(total,1)*100:.0f}%)")
    print(f"  Noise filtered: {len(noise)} ({len(noise)/max(total,1)*100:.0f}%)")
    print(f"  AI batches (LLM calls): {len(batches)}")
    print(f"  Ingest payloads: {len(payloads)} ({total_persons} persons, {total_ix} interactions)")
    print(f"  Estimated first-time cost: {len(batches)} LLM calls (~{len(batches)*2} min)")
    print(f"  After setup: 0 LLM calls for routine ingestion")


if __name__ == "__main__":
    os.chdir(Path(__file__).parent / "data" / "raw")
    main()
