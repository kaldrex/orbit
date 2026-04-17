import { buildEmailDetail, extractMessageBody, isAutomatedContent, isHumanContact, parseEmailAddress } from "../connectors/gmail/rules.js";

export function isDirectMessageChat(chat) {
  const jid = chat?.JID || chat?.jid || chat?.ChatJID || "";
  if (!jid) return false;
  if (jid.endsWith("@g.us")) return false;
  if (jid.includes("@broadcast")) return false;
  if (jid.endsWith("@newsletter")) return false;
  if (jid === "status@broadcast") return false;
  return true;
}

export function derivePhoneFromJid(jid) {
  if (!jid || typeof jid !== "string") return null;
  const digits = jid.split("@")[0].replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
}

export function parseIso(value) {
  const time = Date.parse(value || "");
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function sortMessagesAscending(messages) {
  return [...messages].sort((a, b) => {
    const ta = Date.parse(a.timestamp || a.Timestamp || "") || 0;
    const tb = Date.parse(b.timestamp || b.Timestamp || "") || 0;
    return ta - tb;
  });
}

export function canonicalWhatsappMessage(message) {
  return {
    message_id: message.MsgID || message.message_id || "",
    timestamp: parseIso(message.Timestamp || message.timestamp || ""),
    from_me: Boolean(message.FromMe ?? message.from_me),
    sender_jid: message.SenderJID || message.sender_jid || "",
    text: message.Text || message.text || "",
    display_text: message.DisplayText || message.display_text || "",
    media_type: message.MediaType || message.media_type || "",
    snippet: message.Snippet || message.snippet || "",
  };
}

export function buildWhatsappCanonicalRow({ chat, contact, messages, backfill }) {
  const ordered = sortMessagesAscending(messages.map(canonicalWhatsappMessage));
  const first = ordered[0]?.timestamp || null;
  const last = ordered[ordered.length - 1]?.timestamp || null;

  return {
    source: "whatsapp",
    source_key: chat.JID,
    person_name: contact?.Name || chat.Name || "",
    person_phone: contact?.Phone || derivePhoneFromJid(contact?.JID || chat.JID),
    chat_jid: chat.JID,
    chat_label: chat.Name || "",
    message_count: ordered.length,
    first_message_at: first,
    last_message_at: last,
    recent_messages: ordered.slice(-10),
    older_messages_present: Boolean(first && last && first !== last),
    backfill_rounds: backfill.rounds,
    completion_state: backfill.completion_state,
    completion_reason: backfill.completion_reason,
    messages: ordered,
  };
}

export function canonicalWhatsappExportMessage({ chat, contact, message, backfill }) {
  const row = canonicalWhatsappMessage(message);
  return {
    source: "whatsapp",
    source_key: row.message_id || `${chat.JID}:${row.timestamp || ""}`,
    person_name: contact?.Name || chat.Name || "",
    person_phone: contact?.Phone || derivePhoneFromJid(contact?.JID || chat.JID),
    chat_jid: chat.JID,
    chat_label: chat.Name || "",
    chat_kind: chat.Kind || "",
    backfill_rounds: backfill.rounds,
    completion_state: backfill.completion_state,
    completion_reason: backfill.completion_reason,
    older_messages_present: backfill.older_messages_present,
    first_message_at: backfill.first_message_at,
    last_message_at: backfill.last_message_at,
    message_count_for_chat: backfill.message_count_for_chat,
    ...row,
  };
}

export function classifyGmailMessage(message) {
  const payload = message.payload || message;
  const headers = {};
  for (const h of payload.headers || []) {
    headers[(h.name || "").toLowerCase()] = h.value || "";
  }

  const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
  const snippet = message.snippet || "";
  const { text } = extractMessageBody(payload);
  const from = parseEmailAddress(headers.from || "");
  const to = String(headers.to || "")
    .split(",")
    .map((r) => parseEmailAddress(r.trim()))
    .filter((r) => r.email);
  const cc = String(headers.cc || "")
    .split(",")
    .map((r) => parseEmailAddress(r.trim()))
    .filter((r) => r.email);

  const selfEmails = new Set([
    "sanchaythalnerkar@gmail.com",
    "sanchay.thalnerkar@localhosthq.com",
    "sanchay@localhosthq.com",
  ]);

  const fromIsSelf = selfEmails.has(from.email.toLowerCase());
  const personCandidates = fromIsSelf
    ? [...to, ...cc].filter((r) => !selfEmails.has(r.email.toLowerCase()) && isHumanContact(r.email, labels, r.name))
    : [from].filter((r) => !selfEmails.has(r.email.toLowerCase()) && isHumanContact(r.email, labels, r.name));

  let decision = "relationship_signal";
  let reason = "human-looking email thread";

  if (!isHumanContact(from.email, labels, from.name)) {
    decision = "drop";
    reason = "non-human or system sender";
  } else if (isAutomatedContent(headers.subject || "", snippet, text)) {
    decision = "drop";
    reason = "automated or operational content";
  } else if (personCandidates.length === 0) {
    decision = "drop";
    reason = "no human counterparty";
  } else if (!(snippet || text).trim()) {
    decision = "raw_only";
    reason = "missing usable content";
  }

  return {
    source: "gmail",
    source_key: message.id || "",
    person_candidates: personCandidates.map((p) => ({
      name: p.name || null,
      email: p.email,
    })),
    thread_id: message.threadId || "",
    from_email: from.email || "",
    from_name: from.name || "",
    to_emails: to.map((r) => r.email),
    subject: headers.subject || "",
    date: parseIso(headers.date || ""),
    snippet,
    body_text: text,
    decision,
    decision_reason: reason,
    completion_state: "complete",
    detail: buildEmailDetail({
      subject: headers.subject || "",
      snippet,
      bodyText: text,
    }),
  };
}

export function canonicalGmailExportMessage(message) {
  const payload = message.payload || message;
  const headers = {};
  for (const h of payload.headers || []) {
    headers[(h.name || "").toLowerCase()] = h.value || "";
  }

  const snippet = message.snippet || "";
  const { text } = extractMessageBody(payload);
  const from = parseEmailAddress(headers.from || "");
  const to = String(headers.to || "")
    .split(",")
    .map((r) => parseEmailAddress(r.trim()))
    .filter((r) => r.email);
  const cc = String(headers.cc || "")
    .split(",")
    .map((r) => parseEmailAddress(r.trim()))
    .filter((r) => r.email);

  return {
    source: "gmail",
    source_key: message.id || "",
    message_id: message.id || "",
    thread_id: message.threadId || "",
    label_ids: Array.isArray(message.labelIds) ? message.labelIds : [],
    from_email: from.email || "",
    from_name: from.name || "",
    to_emails: to.map((r) => r.email),
    cc_emails: cc.map((r) => r.email),
    subject: headers.subject || "",
    date: parseIso(headers.date || ""),
    snippet,
    body_text: text,
    detail: buildEmailDetail({
      subject: headers.subject || "",
      snippet,
      bodyText: text,
    }),
    completion_state: "complete",
  };
}
