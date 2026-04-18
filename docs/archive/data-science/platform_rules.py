#!/usr/bin/env python3
"""
Platform-Specific Data Quality Rules for Orbit
================================================
Each platform has its own quirks. These rules clean the data BEFORE
it enters the scoring algorithm, so every user gets accurate results.
"""

import re
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta


# ============================================================================
# CALENDAR RULES
# ============================================================================

class CalendarRules:
    """
    Problems observed:
    1. Recurring events inflate relationship scores (daily standup = 365 signals/year)
    2. Auto-created events (flights, hotels, reminders) have no real attendees
    3. Events with 20+ attendees are company all-hands, not personal meetings
    4. Far-future events (2055) from broken recurrence rules
    """

    # Events with these words and no real attendees are auto-created noise
    AUTO_EVENT_PATTERNS = [
        r"flight\s+to\b", r"hotel\b", r"check.?in\b", r"check.?out\b",
        r"pickup\b", r"drop.?off\b", r"reminder\b", r"birthday\b",
        r"anniversary\b", r"bill\s+due\b", r"renewal\b", r"subscription\b",
    ]

    MAX_ATTENDEES_FOR_PERSONAL = 8  # meetings with more attendees are org-wide
    MAX_FUTURE_DAYS = 180  # ignore events more than 6 months in the future

    @staticmethod
    def is_auto_event(summary, attendees):
        """Filter out auto-generated events (flights, hotels, reminders)."""
        if not attendees:
            return True
        summary_lower = (summary or "").lower()
        for pattern in CalendarRules.AUTO_EVENT_PATTERNS:
            if re.search(pattern, summary_lower):
                return True
        return False

    @staticmethod
    def is_too_far_future(start_time_str):
        """Filter out events with broken far-future dates."""
        try:
            if "T" in start_time_str:
                dt = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
            else:
                dt = datetime.strptime(start_time_str[:10], "%Y-%m-%d")
            return dt > datetime.now(dt.tzinfo) + timedelta(days=CalendarRules.MAX_FUTURE_DAYS)
        except (ValueError, OverflowError, TypeError):
            return True

    @staticmethod
    def collapse_recurring_events(events):
        """
        Detect recurring events and collapse into one signal per series.

        A recurring series is: same attendee set + similar title + regular intervals.
        Instead of N separate signals, produces ONE signal with:
        - Weight = base weight (not multiplied by N)
        - Recency = most recent occurrence
        - Metadata = "recurring daily/weekly, N occurrences"

        Returns: list of (event, metadata) tuples where metadata indicates
                 if the event was collapsed and how.
        """
        # Group by (frozenset of attendee emails, normalized title)
        groups = defaultdict(list)
        for event in events:
            attendees = frozenset(event.attendee_emails)
            # Normalize title: remove dates, numbers, strip whitespace
            title = re.sub(r"\d{4}[-/]\d{2}[-/]\d{2}", "", event.summary or "")
            title = re.sub(r"\b\d+\b", "", title).strip().lower()
            title = re.sub(r"\s+", " ", title)
            key = (attendees, title)
            groups[key].append(event)

        result = []
        for (attendees, title), group_events in groups.items():
            if len(group_events) >= 3:
                # This is a recurring series — check if intervals are regular
                timestamps = []
                for e in group_events:
                    try:
                        ts_str = e.start_time
                        if "T" in ts_str:
                            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                        else:
                            ts = datetime.strptime(ts_str[:10], "%Y-%m-%d").timestamp()
                        timestamps.append(ts)
                    except (ValueError, OverflowError, TypeError):
                        pass

                if len(timestamps) >= 3:
                    timestamps.sort()
                    intervals = [timestamps[i+1] - timestamps[i] for i in range(len(timestamps)-1)]
                    median_interval = sorted(intervals)[len(intervals)//2]

                    # If median interval is consistent (within 50%), it's recurring
                    consistent = sum(1 for i in intervals
                                     if 0.5 * median_interval <= i <= 1.5 * median_interval)
                    is_recurring = consistent >= len(intervals) * 0.6

                    if is_recurring:
                        # Determine cadence
                        days = median_interval / 86400
                        if days < 1.5:
                            cadence = "daily"
                        elif days < 5:
                            cadence = f"every {int(round(days))} days"
                        elif days < 8:
                            cadence = "weekly"
                        elif days < 16:
                            cadence = "biweekly"
                        else:
                            cadence = "monthly"

                        # Keep only the MOST RECENT event, with metadata
                        most_recent = max(group_events, key=lambda e: e.start_time)
                        metadata = {
                            "recurring": True,
                            "cadence": cadence,
                            "occurrences": len(group_events),
                            "first_seen": min(e.start_time for e in group_events),
                            "last_seen": max(e.start_time for e in group_events),
                        }
                        result.append((most_recent, metadata))
                        continue

            # Not recurring — pass through each event individually
            for event in group_events:
                result.append((event, {"recurring": False}))

        return result

    @staticmethod
    def apply(events):
        """Apply all calendar rules. Returns cleaned events with metadata."""
        filtered = []
        stats = {"total": len(events), "auto_filtered": 0, "future_filtered": 0,
                 "large_meeting_filtered": 0, "recurring_collapsed": 0, "kept": 0}

        for event in events:
            if CalendarRules.is_auto_event(event.summary, event.attendee_emails):
                stats["auto_filtered"] += 1
                continue
            if CalendarRules.is_too_far_future(event.start_time):
                stats["future_filtered"] += 1
                continue
            non_self = [e for e in event.attendee_emails
                        if "sanchaythalnerkar" not in e.lower()]
            if len(non_self) > CalendarRules.MAX_ATTENDEES_FOR_PERSONAL:
                stats["large_meeting_filtered"] += 1
                continue
            filtered.append(event)

        # Collapse recurring events
        collapsed = CalendarRules.collapse_recurring_events(filtered)
        recurring_count = sum(1 for _, m in collapsed if m.get("recurring"))
        stats["recurring_collapsed"] = recurring_count
        stats["kept"] = len(collapsed)

        return collapsed, stats


# ============================================================================
# WHATSAPP RULES
# ============================================================================

class WhatsAppRules:
    """
    Problems observed:
    1. Push name coverage is only ~14% of DM contacts (1000 out of 7000+)
    2. LID JIDs (linked device IDs) don't map to phone numbers directly
    3. Business/spam messages from banks, services, promotions
    4. Some push names are just emojis or numbers (not real names)
    5. Group participant JIDs are 97% @lid format
    """

    # Business/spam JID patterns (these are automated, not personal)
    BUSINESS_PATTERNS = [
        r"^91\d{5}00\d{3}@",  # toll-free style numbers
        r"@broadcast$",        # broadcast lists
        r"^status@",           # WhatsApp status
    ]

    # Push names that are useless for identity resolution
    USELESS_PUSHNAME_PATTERNS = [
        r"^[\d\s+\-()]+$",     # just phone digits
        r"^[^\w]+$",            # only emojis/symbols
        r"^.{1,2}$",            # 1-2 chars (abbreviations too short)
    ]

    # Known spam/business sender patterns in message content
    SPAM_CONTENT_PATTERNS = [
        r"OTP\s+is\s+\d{4,6}",
        r"your\s+loan\s+(amount|is)\s+",
        r"insta\s+cash\s+amount",
        r"credit\s+card\s+statement",
        r"your\s+order\s+#",
        r"track\s+your\s+(shipment|order|delivery)",
    ]

    @staticmethod
    def is_business_jid(jid):
        """Filter out business/automated WhatsApp accounts."""
        for pattern in WhatsAppRules.BUSINESS_PATTERNS:
            if re.search(pattern, jid):
                return True
        return False

    @staticmethod
    def is_useless_pushname(name):
        """Check if a push name is too short/meaningless for identity matching."""
        if not name:
            return True
        for pattern in WhatsAppRules.USELESS_PUSHNAME_PATTERNS:
            if re.match(pattern, name.strip()):
                return True
        return False

    @staticmethod
    def is_spam_message(text):
        """Detect automated/spam message content."""
        if not text:
            return False
        text_lower = text.lower()
        for pattern in WhatsAppRules.SPAM_CONTENT_PATTERNS:
            if re.search(pattern, text_lower):
                return True
        return False

    @staticmethod
    def score_dm_relationship(messages):
        """
        Score a DM relationship based on message patterns, not just count.

        Returns a quality multiplier (0.0 - 1.0) that adjusts the raw signal weight.
        Factors:
        - Reciprocity: both sides sending messages (not just one-way)
        - Conversation depth: back-and-forth vs one-way bursts
        - Content quality: actual text vs just media/reactions
        """
        if not messages:
            return 0.0

        from_me = sum(1 for m in messages if m.is_from_me)
        from_them = len(messages) - from_me
        with_text = sum(1 for m in messages if m.text)

        # Reciprocity score: 1.0 if balanced, lower if one-sided
        total = from_me + from_them
        if total == 0:
            return 0.0
        balance = min(from_me, from_them) / max(from_me, from_them) if max(from_me, from_them) > 0 else 0
        reciprocity = 0.3 + 0.7 * balance  # 0.3 minimum for any conversation

        # Content quality: prefer text over empty/media-only
        text_ratio = with_text / total if total > 0 else 0
        content_quality = 0.5 + 0.5 * text_ratio

        return reciprocity * content_quality

    @staticmethod
    def resolve_all_jids(push_names, lid_to_phone):
        """
        Build a comprehensive JID → display name mapping.
        Uses push names + LID mapping to resolve as many JIDs as possible.

        Returns: dict mapping JID → display name (or None if unresolvable)
        """
        jid_to_name = {}

        # Direct push name matches
        for jid, name in push_names.items():
            if not WhatsAppRules.is_useless_pushname(name):
                jid_to_name[jid] = name

        # Resolve LID JIDs to phone JIDs, then check push names
        for lid, phone in lid_to_phone.items():
            if lid not in jid_to_name and phone in jid_to_name:
                jid_to_name[lid] = jid_to_name[phone]
            elif phone not in jid_to_name and lid in jid_to_name:
                jid_to_name[phone] = jid_to_name[lid]

        return jid_to_name

    @staticmethod
    def apply(messages, push_names, lid_to_phone):
        """Apply all WhatsApp rules. Returns cleaned messages + resolved names."""
        stats = {"total": len(messages), "business_filtered": 0,
                 "spam_filtered": 0, "kept": 0}

        jid_to_name = WhatsAppRules.resolve_all_jids(push_names, lid_to_phone)

        cleaned = []
        for msg in messages:
            if WhatsAppRules.is_business_jid(msg.conversation_id):
                stats["business_filtered"] += 1
                continue
            if msg.text and WhatsAppRules.is_spam_message(msg.text):
                stats["spam_filtered"] += 1
                continue
            cleaned.append(msg)

        stats["kept"] = len(cleaned)
        stats["names_resolved"] = len(jid_to_name)

        return cleaned, jid_to_name, stats


# ============================================================================
# GMAIL RULES
# ============================================================================

class GmailRules:
    """
    Problems observed:
    1. ~80% of inbox is newsletters/promotions (NVIDIA, Grafana, ET, etc.)
    2. Gmail labels help: CATEGORY_PERSONAL and IMPORTANT are high-signal
    3. Cc chains reveal KNOWS relationships (who works with whom)
    4. Auto-generated emails (bills, OTPs, order confirmations) are noise
    """

    NEWSLETTER_DOMAINS = {
        "nvidia.com", "google.com", "grafana.com", "substack.com", "medium.com",
        "linkedin.com", "twitter.com", "facebook.com", "instagram.com",
        "coursera.org", "maven.com", "udemy.com", "economictimesnews.com",
        "etprime.com", "getonecard.app", "hdfcbank.bank.in", "netflix.com",
        "amazon.in", "amazon.com", "flipkart.com", "zomato.com", "swiggy.com",
        "paytm.com", "phonepe.com", "googlepay.com", "members.netflix.com",
        "mailers.hdfcbank.bank.in", "notifications.google.com",
    }

    NEWSLETTER_LOCAL_PARTS = {
        "noreply", "no-reply", "donotreply", "newsletter", "notifications",
        "mailer-daemon", "postmaster", "support", "info", "hello", "team",
        "marketing", "sales", "billing", "updates", "digest", "news",
        "alerts", "notify", "account-info", "service", "promo",
    }

    @staticmethod
    def is_newsletter(from_addr, labels=None):
        """Detect newsletters using both email patterns and Gmail labels."""
        if not from_addr:
            return True

        email_lower = from_addr.lower()
        domain = email_lower.split("@")[-1] if "@" in email_lower else ""
        local = email_lower.split("@")[0] if "@" in email_lower else ""

        # Check domain
        if domain in GmailRules.NEWSLETTER_DOMAINS:
            return True

        # Check local part
        if local in GmailRules.NEWSLETTER_LOCAL_PARTS:
            return True

        # Subdomains of known domains (mail.xyz.com, mailers.xyz.com)
        for nl_domain in GmailRules.NEWSLETTER_DOMAINS:
            if domain.endswith("." + nl_domain):
                return True

        # Gmail label check — CATEGORY_PROMOTIONS is almost always newsletters
        if labels:
            if "CATEGORY_PROMOTIONS" in labels:
                return True

        return False

    @staticmethod
    def signal_quality(msg, labels=None):
        """
        Rate email signal quality on a 0-1 scale.

        High quality (>0.7): CATEGORY_PERSONAL, has Cc, personal domain
        Medium quality (0.3-0.7): CATEGORY_UPDATES from known domains
        Low quality (<0.3): everything else
        """
        if labels is None:
            labels = []

        score = 0.5  # baseline

        # Gmail category signals
        if "CATEGORY_PERSONAL" in labels:
            score += 0.3
        if "IMPORTANT" in labels:
            score += 0.2
        if "CATEGORY_UPDATES" in labels:
            score -= 0.1
        if "CATEGORY_PROMOTIONS" in labels:
            score -= 0.4

        # Cc indicates business relationship (multiple people)
        if msg.cc_addrs:
            score += 0.15

        # Personal domain (gmail, outlook, etc.) vs corporate newsletter
        domain = msg.from_addr.split("@")[-1] if "@" in msg.from_addr else ""
        personal_domains = {"gmail.com", "outlook.com", "yahoo.com", "hotmail.com",
                           "icloud.com", "protonmail.com"}
        if domain in personal_domains:
            score += 0.1

        return max(0.0, min(1.0, score))

    @staticmethod
    def apply(messages):
        """Apply Gmail rules. Returns cleaned messages with quality scores."""
        stats = {"total": len(messages), "newsletters_filtered": 0, "kept": 0}

        cleaned = []
        for msg in messages:
            labels = getattr(msg, 'labels', [])
            if GmailRules.is_newsletter(msg.from_addr, labels):
                stats["newsletters_filtered"] += 1
                continue
            msg.quality = GmailRules.signal_quality(msg, labels)
            cleaned.append(msg)

        stats["kept"] = len(cleaned)
        return cleaned, stats


# ============================================================================
# SLACK RULES
# ============================================================================

class SlackRules:
    """
    Problems observed:
    1. Bot accounts mixed in with human members
    2. Agent bots (Wazowski, Chad, Axe, Kite) are not real people
    3. Slack user IDs need to be resolved to display names
    4. Some members have joke titles (not useful metadata)
    """

    KNOWN_BOT_NAMES = {
        "wazowski", "chad", "axe", "kite", "slackbot",
    }

    @staticmethod
    def is_real_human(member):
        """Filter out bots, apps, and known agent accounts."""
        if member.is_bot:
            return False
        if member.user_id == "USLACKBOT":
            return False
        name_lower = (member.real_name or member.name or "").lower()
        if name_lower in SlackRules.KNOWN_BOT_NAMES:
            return False
        return True

    @staticmethod
    def apply(members):
        """Apply Slack rules. Returns only real human members."""
        humans = [m for m in members if SlackRules.is_real_human(m)]
        stats = {"total": len(members), "bots_filtered": len(members) - len(humans),
                 "humans": len(humans)}
        return humans, stats


# ============================================================================
# LINEAR RULES
# ============================================================================

class LinearRules:
    """
    Problems observed:
    1. Issues without assignees have no relationship signal
    2. Issue comments are better relationship signals than just assignment
    3. Stale/closed issues shouldn't weight as much as active ones
    """

    @staticmethod
    def issue_signal_weight(issue):
        """
        Weight a Linear issue's relationship signal based on state and activity.

        Active issues with comments = strong signal.
        Old closed issues = weak signal.
        Unassigned issues = no signal.
        """
        if not issue.get("assignee"):
            return 0.0

        state = issue.get("state", {}).get("name", "").lower()
        comments = issue.get("comments", {}).get("nodes", [])

        base = 1.0
        if state in ("done", "completed", "cancelled", "canceled"):
            base *= 0.5  # completed work is less current
        if state in ("backlog", "triage"):
            base *= 0.3  # not actively worked on

        # Comments indicate real collaboration
        comment_bonus = min(len(comments) * 0.2, 1.0)

        return base + comment_bonus

    @staticmethod
    def apply(issues):
        """Apply Linear rules. Returns issues with quality weights."""
        stats = {"total": len(issues), "with_assignee": 0, "with_comments": 0}

        weighted = []
        for issue in issues:
            weight = LinearRules.issue_signal_weight(issue)
            if weight > 0:
                issue["_signal_weight"] = weight
                weighted.append(issue)
                stats["with_assignee"] += 1
                if issue.get("comments", {}).get("nodes"):
                    stats["with_comments"] += 1

        stats["kept"] = len(weighted)
        return weighted, stats


# ============================================================================
# CROSS-PLATFORM IDENTITY BRIDGE
# ============================================================================

class IdentityBridge:
    """
    Provides manual seed identities to bridge the gap between platforms.

    Without this, Calendar (email) and WhatsApp (phone) can never link.
    Even 20-30 seeds for key contacts dramatically improves cross-source scoring.

    File format (seed_identities.json):
    [
        {
            "name": "Ramon Berrios",
            "emails": ["ramongberrios@gmail.com", "ramon@castmagic.io"],
            "phones": ["17874244135"],
            "whatsapp_jids": ["17874244135@s.whatsapp.net"],
            "category": "founder"
        }
    ]
    """

    @staticmethod
    def load_seeds(path):
        """Load seed identities from JSON file."""
        import json
        from pathlib import Path
        p = Path(path)
        if not p.exists():
            return []
        with open(p) as f:
            return json.load(f)

    @staticmethod
    def apply_seeds(identities, email_to_key, phone_to_key, jid_to_key, seeds):
        """
        Merge seed identities into the resolved identity graph.
        This is the BRIDGE between platforms.
        """
        merged_count = 0
        for seed in seeds:
            # Find all existing identity keys for this person
            keys = set()
            for email in seed.get("emails", []):
                if email.lower() in email_to_key:
                    keys.add(email_to_key[email.lower()])
            for phone in seed.get("phones", []):
                if phone in phone_to_key:
                    keys.add(phone_to_key[phone])
            for jid in seed.get("whatsapp_jids", []):
                if jid in jid_to_key:
                    keys.add(jid_to_key[jid])

            if len(keys) > 1:
                # Merge all keys into one
                keys_list = list(keys)
                base = keys_list[0]
                for other in keys_list[1:]:
                    if other in identities and base in identities:
                        identities[base].merge(identities[other])
                        # Update mappings
                        for email, k in list(email_to_key.items()):
                            if k == other:
                                email_to_key[email] = base
                        for phone, k in list(phone_to_key.items()):
                            if k == other:
                                phone_to_key[phone] = base
                        for jid, k in list(jid_to_key.items()):
                            if k == other:
                                jid_to_key[jid] = base
                        del identities[other]
                        merged_count += 1

            # Apply seed metadata to the resolved identity
            if keys:
                key = next(iter(keys))
                if key in identities:
                    ident = identities[key]
                    ident.canonical_name = seed["name"]
                    if seed.get("category"):
                        ident.category = seed["category"]

        return merged_count


# ============================================================================
# SUMMARY
# ============================================================================

def print_rules_summary():
    """Print a human-readable summary of all platform rules."""
    print("""
ORBIT PLATFORM-SPECIFIC DATA QUALITY RULES
============================================

CALENDAR:
  - Filter auto-events (flights, hotels, reminders)
  - Filter events >6 months in the future
  - Filter meetings with >8 attendees (org-wide, not personal)
  - COLLAPSE recurring events into 1 signal per series
    (daily standup = 1 signal, not 365)

WHATSAPP:
  - Filter business/spam JIDs
  - Filter spam message content (OTPs, loan offers)
  - Resolve LID JIDs via phoneNumberToLidMappings
  - Filter useless push names (emojis, single chars)
  - Score DMs by reciprocity + content quality

GMAIL:
  - Filter newsletters by domain, local part, AND Gmail category labels
  - Use CATEGORY_PERSONAL + IMPORTANT as high-quality signals
  - Rate each email's signal quality (0-1 scale)
  - Detect Cc chains for KNOWS edges

SLACK:
  - Filter bots and known agent accounts
  - Keep only real human workspace members

LINEAR:
  - Weight issues by state (active > done > backlog)
  - Bonus for issues with comments (= real collaboration)
  - Skip unassigned issues

CROSS-PLATFORM:
  - Seed identity file bridges email ↔ phone ↔ WhatsApp JID
  - Even 20-30 seeds for key contacts fixes cross-source resolution
""")


if __name__ == "__main__":
    print_rules_summary()
