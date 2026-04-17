export const VALID_CATEGORIES = new Set([
  "self", "team", "investor", "sponsor", "fellow", "media",
  "community", "gov", "founder", "friend", "press", "other",
]);

const CATEGORY_ALIASES: Record<string, string> = {
  whatsapp: "other",
  whatsapp_contact: "other",
  "whatsapp-india": "other",
  contact: "other",
  "calendar-meeting": "other",
  network: "fellow",
  professional: "fellow",
};

export function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return "other";
  const lower = raw.toLowerCase().trim();
  if (VALID_CATEGORIES.has(lower)) return lower;
  return CATEGORY_ALIASES[lower] || "other";
}
