// connector.js — WhatsApp real-time connector for Orbit.
//
// Processes GOWA webhook events, filters spam and business messages,
// resolves identities, and emits interaction signals.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BaseConnector } from "../base-connector.js";
import { isSpamMessage, isBusinessJid, isGroupJid } from "./rules.js";

export default class WhatsAppConnector extends BaseConnector {
  constructor(identityCache) {
    super("whatsapp", "realtime", identityCache);
    this._home = homedir();
  }

  /**
   * Check if WhatsApp data sources exist on this machine.
   * Looks for GOWA storage dir or wacli database.
   */
  isAvailable() {
    const gowaPath = join(this._home, "gowa", "storages");
    const wacliPath = join(this._home, ".wacli", "wacli.db");
    return existsSync(gowaPath) || existsSync(wacliPath);
  }

  /**
   * First-run historical scan of GOWA storages.
   * Reads all history-*-RECENT.json files, iterates messages, applies the
   * same filters as processEvent, and emits signals.
   *
   * This can process tens of thousands of messages. Runs in bounded
   * batches internally to avoid blocking the event loop.
   */
  async bootstrap() {
    const storagesDir = join(this._home, "gowa", "storages");
    if (!existsSync(storagesDir)) {
      return [];
    }

    let files;
    try {
      files = readdirSync(storagesDir)
        .filter((f) => /history-.*-RECENT\.json$/.test(f));
    } catch {
      return [];
    }

    const signals = [];
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(readFileSync(join(storagesDir, file), "utf8"));
      } catch {
        this.stats.errors++;
        continue;
      }

      const conversations = data.conversations || [];
      for (const conv of conversations) {
        const chatJid = conv.ID;
        if (!chatJid || isBusinessJid(chatJid)) continue;

        const isGroup = isGroupJid(chatJid);
        const messages = conv.messages || [];

        for (const wrapper of messages) {
          // GOWA format wraps every message in a `message` envelope:
          // { message: { key, message: { conversation }, messageTimestamp } }
          const msg = wrapper.message || wrapper;
          const senderJid =
            msg.participant || msg.key?.participant || chatJid;
          const fromMe = msg.key?.fromMe;
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";

          if (isSpamMessage(text)) {
            this.stats.filtered++;
            continue;
          }
          if (isGroup && fromMe) {
            this.stats.filtered++;
            continue;
          }

          const resolveTarget = isGroup ? senderJid : chatJid;
          const contactName = this.identityCache.resolveJid(resolveTarget);
          if (!contactName) {
            this.stats.filtered++;
            continue;
          }

          const epochSec = msg.messageTimestamp;
          const timestamp = epochSec
            ? new Date(Number(epochSec) * 1000).toISOString()
            : new Date().toISOString();

          const detail = text.length > 100 ? text.slice(0, 97) + "..." : text;

          signals.push({
            contactName,
            channel: isGroup ? "whatsapp_group" : "whatsapp_dm",
            timestamp,
            detail: detail || undefined,
            isGroup,
          });
        }
      }

      // Yield back to event loop between files so we don't block
      await new Promise((r) => setImmediate(r));
    }

    return signals;
  }

  /**
   * Process a single WhatsApp webhook event.
   * Handles both GOWA nested format and simplified format.
   *
   * @param {Object} event — raw webhook payload
   * @returns {Object|null} signal or null if filtered
   */
  processEvent(event) {
    if (!event) return null;

    let chatJid, senderJid, text, timestamp, fromMe, isGroup;

    if (event.message?.key) {
      // GOWA nested format
      const msg = event.message;
      chatJid = msg.key.remoteJID;
      senderJid = msg.key.participant || chatJid;
      fromMe = msg.key.fromMe;
      text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      isGroup = isGroupJid(chatJid);

      // messageTimestamp is epoch seconds
      const epochSec = msg.messageTimestamp;
      timestamp = epochSec
        ? new Date(Number(epochSec) * 1000).toISOString()
        : new Date().toISOString();
    } else if (event.from) {
      // Simplified format
      chatJid = event.from;
      senderJid = event.participant || chatJid;
      text = event.text || "";
      fromMe = event.fromMe || false;
      isGroup = event.isGroup || isGroupJid(chatJid);
      timestamp = event.timestamp
        ? new Date(
            typeof event.timestamp === "number" && event.timestamp < 1e12
              ? event.timestamp * 1000
              : event.timestamp
          ).toISOString()
        : new Date().toISOString();
    } else {
      this.stats.filtered++;
      return null;
    }

    // Filter business JIDs
    if (isBusinessJid(chatJid)) {
      this.stats.filtered++;
      return null;
    }

    // Filter spam messages
    if (isSpamMessage(text)) {
      this.stats.filtered++;
      return null;
    }

    // Skip own messages in groups
    if (isGroup && fromMe) {
      this.stats.filtered++;
      return null;
    }

    // Resolve identity
    // In groups: resolve the sender. In DMs: resolve the chat partner.
    const resolveTarget = isGroup ? senderJid : chatJid;
    const contactName = this.identityCache.resolveJid(resolveTarget);

    if (!contactName) {
      this.stats.filtered++;
      return null;
    }

    // Extract phone from the JID ("15555551212@s.whatsapp.net" → "15555551212").
    // Group participant JIDs take the form "15551234@lid" or similar; we take
    // the leading digits. LID identifiers that resolve via identity-cache will
    // already have been mapped to a phone upstream; others we keep raw so the
    // server can at least match exact JID → phone on next tick.
    const jidToPhone = (jid) => {
      if (!jid || typeof jid !== "string") return undefined;
      const head = jid.split("@")[0] || "";
      const digits = head.replace(/\D/g, "");
      return digits.length >= 7 ? digits : undefined;
    };
    const contactPhone = jidToPhone(resolveTarget);

    // Truncate detail for summary
    const detail = text.length > 100 ? text.slice(0, 97) + "..." : text;

    this.stats.processed++;
    return {
      contactName,
      contactPhone,
      channel: "whatsapp",
      timestamp,
      detail: detail || undefined,
      isGroup,
    };
  }
}
