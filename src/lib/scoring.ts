// Scoring engine — TypeScript port of intelligence_layer.py ScoringEngine

const SIGNAL_WEIGHTS: Record<string, number> = {
  calendar_small: 1.5,
  calendar_large: 0.8,
  whatsapp_dm: 1.2,
  whatsapp_group: 0.3,
  email_personal: 1.0,
  email_cc: 0.5,
  slack_dm: 1.0,
  slack_channel: 0.2,
  linear: 0.4,
};

const CHANNEL_BOOST: Record<string, number> = {
  calendar: 1.3,
  whatsapp: 1.1,
  email: 1.0,
  slack: 1.0,
  linear: 0.8,
  meeting: 1.3,
};

export function recencyFactor(daysAgo: number): number {
  if (daysAgo < 0) daysAgo = 0;
  return Math.exp(-daysAgo / 90);
}

export function computeSignalScore(
  signalType: string,
  channel: string,
  daysAgo: number,
  isReciprocal = false,
): number {
  const baseWeight = SIGNAL_WEIGHTS[signalType] ?? 0.5;
  const channelBoost = CHANNEL_BOOST[channel] ?? 1.0;
  const recency = recencyFactor(daysAgo);
  const reciprocity = isReciprocal ? 1.2 : 1.0;
  const raw = baseWeight * channelBoost * recency * reciprocity;
  return Math.round(Math.min(raw, 2.0) * 1000) / 1000;
}

export function computeDecay(
  currentScore: number,
  daysSinceLastInteraction: number,
): number {
  if (currentScore <= 1.0) return currentScore;
  if (daysSinceLastInteraction <= 7) return currentScore;
  const decayDays = daysSinceLastInteraction - 7;
  const decayed = currentScore * Math.pow(0.98, decayDays);
  return Math.round(Math.max(decayed, 0.5) * 100) / 100;
}

export function normalizeScore(rawScore: number, maxPossible = 20.0): number {
  if (rawScore <= 0) return 0.0;
  const normalized = (Math.log1p(rawScore) / Math.log1p(maxPossible)) * 10;
  return Math.round(Math.min(normalized, 10.0) * 100) / 100;
}

export function channelToSignalType(channel: string): string {
  // Conservative mapping: default channels map to LOWER-signal types
  // (groups/CCs) rather than DMs. Real connectors emit specific
  // "whatsapp_dm" / "email_personal" signal types when they detect a true
  // 1:1 interaction. Anything that just says "whatsapp" was likely bulk-
  // ingested group/co-presence data.
  switch (channel) {
    case "meeting":
    case "calendar":
      return "calendar_small";
    case "whatsapp_dm":
    case "telegram":
    case "imessage":
      return "whatsapp_dm";
    case "whatsapp":
    case "whatsapp_group":
      return "whatsapp_group";
    case "email_personal":
      return "email_personal";
    case "email":
    case "email_cc":
      return "email_cc";
    case "slack_dm":
      return "slack_dm";
    case "slack":
    case "slack_channel":
      return "slack_channel";
    case "linear":
      return "linear";
    default:
      return "email_cc";
  }
}

export function deriveKnowsStrength(
  evidenceCount: number,
  isMultiSource: boolean,
): number {
  const base = Math.min(evidenceCount * 0.15, 0.7);
  const diversity = isMultiSource ? 0.2 : 0;
  return Math.min(base + diversity, 1.0);
}

export function scorePersonFromEdges(
  interactions: { channel: string; timestamp: string }[],
  knowsCount: number,
): number {
  const now = Date.now();
  let total = 0;

  for (const interaction of interactions) {
    const signalType = channelToSignalType(interaction.channel);
    const ts = new Date(interaction.timestamp).getTime();
    const daysAgo = (now - ts) / (1000 * 60 * 60 * 24);
    total += computeSignalScore(signalType, interaction.channel, daysAgo);
  }

  const channels = new Set(interactions.map((i) => i.channel));
  const isMultiSource = channels.size > 1;
  total += deriveKnowsStrength(knowsCount, isMultiSource);

  return normalizeScore(total);
}
