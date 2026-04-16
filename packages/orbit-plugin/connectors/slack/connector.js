// connector.js — Slack real-time connector for Orbit.
//
// Processes Slack webhook events, filters bot messages and known agents,
// and emits interaction signals for real human conversations.

import { BaseConnector } from "../base-connector.js";
import { isBot } from "./rules.js";

export default class SlackConnector extends BaseConnector {
  constructor(identityCache) {
    super("slack", "realtime", identityCache);
  }

  /**
   * Check if Slack bot token is configured.
   */
  isAvailable() {
    return !!process.env.SLACK_BOT_TOKEN;
  }

  /**
   * Process a single Slack webhook event.
   * @param {Object} event — webhook payload with user, text, channel, ts
   * @returns {Object|null} signal or null if filtered
   */
  processEvent(event) {
    if (!event) return null;

    // Filter bot messages
    if (
      isBot({
        is_bot: event.bot_id != null || event.subtype === "bot_message",
        id: event.user,
        name: event.username || "",
      })
    ) {
      this.stats.filtered++;
      return null;
    }

    const userName =
      event.user_name ||
      event.username ||
      event.user_profile?.real_name ||
      event.user;

    if (!userName) {
      this.stats.filtered++;
      return null;
    }

    const text = event.text || "";
    const detail = text.length > 100 ? text.slice(0, 97) + "..." : text;

    const timestamp = event.ts
      ? new Date(parseFloat(event.ts) * 1000).toISOString()
      : new Date().toISOString();

    this.stats.processed++;
    return {
      contactName: userName,
      channel: "slack",
      timestamp,
      detail: detail || undefined,
    };
  }
}
