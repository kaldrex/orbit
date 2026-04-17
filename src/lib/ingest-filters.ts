// Server-side safety net for the ingest endpoint.
// Ported from platform_rules.py

const NEWSLETTER_DOMAINS = new Set([
  "nvidia.com", "substack.com", "medium.com", "linkedin.com",
  "twitter.com", "facebook.com", "instagram.com", "netflix.com",
  "amazon.in", "amazon.com", "flipkart.com", "zomato.com", "swiggy.com",
  "grafana.com", "github.com", "vercel.com", "figma.com",
]);

const NEWSLETTER_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "donotreply", "newsletter", "notifications",
  "mailer-daemon", "postmaster", "support", "info", "marketing",
  "sales", "billing", "updates", "digest", "news", "alerts", "promo",
]);

const BOT_NAMES = new Set([
  "wazowski", "chad", "axe", "kite", "slackbot",
]);

export function isNewsletterEmail(email: string): boolean {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.indexOf("@");
  if (atIdx === -1) return false;

  const localPart = lower.slice(0, atIdx);
  if (NEWSLETTER_LOCAL_PARTS.has(localPart)) return true;

  const domain = lower.slice(atIdx + 1);
  return NEWSLETTER_DOMAINS.has(domain);
}

export function isBotName(name: string): boolean {
  return BOT_NAMES.has(name.toLowerCase().trim());
}

export function isJunkParticipant(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;

  // Phone numbers: mostly digits, spaces, dashes, parens, plus
  if (/^[\d\s\-+().]+$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 7) {
    return true;
  }

  // Email addresses used as names
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;

  return false;
}

export function filterIngestPayload<
  I extends { participants?: string[] },
  P extends { name?: string; email?: string },
>(
  interactions: I[],
  persons: P[],
): {
  interactions: I[];
  persons: P[];
  filtered: { junkParticipants: number; bots: number; newsletters: number };
} {
  const stats = { junkParticipants: 0, bots: 0, newsletters: 0 };

  // Filter persons
  const cleanPersons: P[] = persons.filter((p) => {
    if (!p.name || p.name.trim().length === 0) {
      stats.junkParticipants++;
      return false;
    }
    if (isBotName(p.name)) {
      stats.bots++;
      return false;
    }
    if (isJunkParticipant(p.name)) {
      stats.junkParticipants++;
      return false;
    }
    if (p.email && isNewsletterEmail(p.email)) {
      stats.newsletters++;
      return false;
    }
    return true;
  });

  // Filter interaction participants and remove empty interactions
  const cleanInteractions: I[] = interactions
    .map((interaction) => {
      if (!interaction.participants) return interaction;

      const cleanParticipants = interaction.participants.filter((name) => {
        if (isBotName(name)) {
          stats.bots++;
          return false;
        }
        if (isJunkParticipant(name)) {
          stats.junkParticipants++;
          return false;
        }
        return true;
      });

      return { ...interaction, participants: cleanParticipants };
    })
    .filter((interaction) => {
      if (!interaction.participants) return true;
      return interaction.participants.length > 0;
    });

  return {
    interactions: cleanInteractions,
    persons: cleanPersons,
    filtered: stats,
  };
}
