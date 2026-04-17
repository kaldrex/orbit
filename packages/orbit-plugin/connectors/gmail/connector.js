// connector.js — Gmail batch connector for Orbit.
//
// Polls recent emails via the gws CLI, filters newsletters and automated
// messages, resolves sender/recipient identities, and emits interaction
// signals for real human correspondence.

import { execFileSync } from "node:child_process";
import { BaseConnector } from "../base-connector.js";
import { isNewsletter, parseEmailAddress } from "./rules.js";

const SELF_EMAILS = new Set([
  "sanchaythalnerkar@gmail.com",
  "sanchay.thalnerkar@localhosthq.com",
  "sanchay@localhosthq.com",
]);

export default class GmailConnector extends BaseConnector {
  constructor(identityCache) {
    super("gmail", "batch", identityCache);
  }

  /**
   * Check if the gws CLI is installed.
   */
  isAvailable() {
    try {
      execFileSync("which", ["gws"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch recent emails, filter newsletters, resolve contacts,
   * and return interaction signals.
   * @param {Date} since
   * @returns {Promise<Array<Object>>}
   */
  async poll(since) {
    // Get message IDs
    let listRaw;
    try {
      listRaw = execFileSync(
        "gws",
        [
          "gmail", "users", "messages", "list",
          "--params",
          JSON.stringify({
            userId: "me",
            maxResults: 100,
            q: `after:${Math.floor(since.getTime() / 1000)}`,
          }),
        ],
        { encoding: "utf8" }
      );
    } catch {
      return [];
    }

    let listData;
    try {
      listData = JSON.parse(listRaw);
    } catch {
      return [];
    }

    const messages = listData.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const signals = [];

    for (const msg of messages) {
      const messageId = msg.id;
      if (!messageId) continue;

      // Fetch message metadata
      let metaRaw;
      try {
        metaRaw = execFileSync(
          "gws",
          [
            "gmail", "users", "messages", "get",
            "--params",
            JSON.stringify({
              userId: "me",
              id: messageId,
              format: "metadata",
              metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
            }),
          ],
          { encoding: "utf8" }
        );
      } catch {
        this.stats.filtered++;
        continue;
      }

      let meta;
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        this.stats.filtered++;
        continue;
      }

      const headers = this._extractHeaders(meta);
      const labels = meta.labelIds || [];

      const from = parseEmailAddress(headers.from || "");
      const to = (headers.to || "")
        .split(",")
        .map((r) => parseEmailAddress(r.trim()));
      const cc = (headers.cc || "")
        .split(",")
        .map((r) => parseEmailAddress(r.trim()))
        .filter((r) => r.email);

      // Filter newsletters
      if (isNewsletter(from.email, labels)) {
        this.stats.filtered++;
        continue;
      }

      // Determine if this is a self-sent email
      const isSelfSent = SELF_EMAILS.has(from.email.toLowerCase());

      let contacts;
      if (isSelfSent) {
        // Self-sent: recipients are the contacts
        contacts = [...to, ...cc].filter(
          (r) => r.email && !SELF_EMAILS.has(r.email.toLowerCase())
        );
      } else {
        // Incoming: sender is the contact
        contacts = [from].filter(
          (r) => r.email && !SELF_EMAILS.has(r.email.toLowerCase())
        );
      }

      if (contacts.length === 0) {
        this.stats.filtered++;
        continue;
      }

      // Register email→name mappings
      for (const c of contacts) {
        if (c.email && c.name) {
          this.identityCache.addEmail(c.email, c.name);
        }
      }

      const timestamp =
        headers.date ? new Date(headers.date).toISOString() : new Date().toISOString();
      const subject = headers.subject || undefined;

      // Emit one signal per contact
      for (const contact of contacts) {
        const contactName =
          contact.name ||
          this.identityCache.resolveEmail(contact.email) ||
          contact.email;

        signals.push({
          contactName,
          channel: "email",
          timestamp,
          detail: subject,
        });
      }
    }

    return signals;
  }

  /**
   * Extract headers from Gmail message metadata into a flat object.
   */
  _extractHeaders(meta) {
    const headers = {};
    const payload = meta.payload || meta;
    const headerList = payload.headers || [];

    for (const h of headerList) {
      const key = (h.name || "").toLowerCase();
      headers[key] = h.value || "";
    }

    return headers;
  }
}
