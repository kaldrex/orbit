// connector.js — Google Calendar batch connector for Orbit.
//
// Polls calendar events via the gws CLI, filters auto-generated events,
// collapses recurring series, and emits interaction signals for meetings
// with identifiable contacts.

import { execFileSync } from "node:child_process";
import { BaseConnector } from "../base-connector.js";
import {
  isAutoEvent,
  isTooFarFuture,
  isTooLarge,
  collapseRecurring,
} from "./rules.js";

const SELF_NAMES = ["sanchay", "sanchay thalnerkar"];

export default class CalendarConnector extends BaseConnector {
  constructor(identityCache) {
    super("calendar", "batch", identityCache);
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
   * Fetch calendar events since the given timestamp, filter and collapse,
   * then return interaction signals.
   * @param {Date} since
   * @returns {Promise<Array<Object>>}
   */
  async poll(since) {
    let raw;
    try {
      raw = execFileSync(
        "gws",
        [
          "calendar", "events", "list",
          "--params",
          JSON.stringify({
            calendarId: "primary",
            maxResults: 2500,
            singleEvents: true,
            timeMin: since.toISOString(),
            orderBy: "startTime",
          }),
        ],
        { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (err) {
      this.stats.errors++;
      console.warn(`[calendar] gws call failed: ${err.code || err.message}`);
      return [];
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      this.stats.errors++;
      console.warn(`[calendar] JSON parse failed: ${err.message}`);
      return [];
    }

    const items = data.items || data || [];
    if (!Array.isArray(items)) return [];

    // Enrich events with non-self attendee info
    const enriched = [];
    for (const ev of items) {
      const attendees = (ev.attendees || []).filter(
        (a) => !a.self && !a.resource
      );
      ev._attendeeEmails = attendees.map((a) => a.email);
      ev._attendeeCount = attendees.length;
      enriched.push(ev);
    }

    // Filter pipeline
    let events = enriched;

    // 1. Remove auto-generated events
    events = events.filter((ev) => {
      if (isAutoEvent(ev.summary, ev._attendeeCount)) {
        this.stats.filtered++;
        return false;
      }
      return true;
    });

    // 2. Remove events too far in the future
    events = events.filter((ev) => {
      const startTime = ev.start?.dateTime || ev.start?.date;
      if (isTooFarFuture(startTime)) {
        this.stats.filtered++;
        return false;
      }
      return true;
    });

    // 3. Remove oversized meetings
    events = events.filter((ev) => {
      if (isTooLarge(ev._attendeeCount)) {
        this.stats.filtered++;
        return false;
      }
      return true;
    });

    // 4. Collapse recurring events
    events = collapseRecurring(events);

    // Build signals
    const signals = [];
    for (const ev of events) {
      const contactName = this._extractContactName(ev);
      if (!contactName) {
        this.stats.filtered++;
        continue;
      }

      // Register email→name mappings from attendees
      for (const attendee of ev.attendees || []) {
        if (!attendee.self && attendee.email && attendee.displayName) {
          this.identityCache.addEmail(attendee.email, attendee.displayName);
        }
      }

      const startTime = ev.start?.dateTime || ev.start?.date;
      let detail = ev.summary || undefined;
      if (ev._recurring) {
        detail = `${detail || "Recurring"} (${ev._cadence}, ${ev._occurrences} occurrences)`;
      }

      signals.push({
        contactName,
        channel: "calendar",
        timestamp: startTime || new Date().toISOString(),
        detail,
      });
    }

    return signals;
  }

  /**
   * Extract the contact name from the event title or attendee list.
   * Splits title on common separators, takes the part that doesn't
   * contain "sanchay".
   */
  _extractContactName(ev) {
    // First try attendee list
    const attendees = (ev.attendees || []).filter(
      (a) => !a.self && !a.resource
    );
    if (attendees.length === 1) {
      const a = attendees[0];
      return a.displayName || a.email;
    }

    // Try parsing from title
    const title = ev.summary || "";
    const separators = [" / ", "/", " x ", "<>"];

    for (const sep of separators) {
      if (title.includes(sep)) {
        const parts = title.split(sep).map((p) => p.trim());
        const other = parts.find(
          (p) => !SELF_NAMES.some((s) => p.toLowerCase().includes(s))
        );
        if (other) return other;
      }
    }

    // If we have multiple attendees, return the first one's name
    if (attendees.length > 1) {
      return attendees[0].displayName || attendees[0].email;
    }

    return null;
  }
}
