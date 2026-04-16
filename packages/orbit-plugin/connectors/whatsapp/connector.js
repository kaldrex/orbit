// connector.js — WhatsApp real-time connector for Orbit.
//
// Processes GOWA webhook events, filters spam and business messages,
// resolves identities, and emits interaction signals.

import { existsSync } from "node:fs";
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

    // Truncate detail for summary
    const detail = text.length > 100 ? text.slice(0, 97) + "..." : text;

    this.stats.processed++;
    return {
      contactName,
      channel: "whatsapp",
      timestamp,
      detail: detail || undefined,
      isGroup,
    };
  }
}
