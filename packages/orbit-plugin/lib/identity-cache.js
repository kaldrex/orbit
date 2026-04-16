// identity-cache.js — Cross-platform identity resolution for Orbit connectors.
//
// Resolves the same person across WhatsApp JIDs, emails, and display names
// using wacli's SQLite contacts DB and WhatsApp LID-to-phone mapping files.

import { homedir } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class IdentityCache {
  constructor(opts = {}) {
    this._home = opts.homedir || homedir();
    this._wacliDb = opts.wacliDb || join(this._home, ".wacli", "wacli.db");
    this._gowaDir = opts.gowaDir || join(this._home, "gowa", "storages");

    // JID → { phone, pushName, fullName, firstName, businessName }
    this._jidContacts = new Map();

    // LID JID → phone-number JID (e.g. "123:45@lid" → "919136820958@s.whatsapp.net")
    this._lidToPhone = new Map();

    // email → name (manually registered or from other connectors)
    this._emailToName = new Map();

    this._loaded = false;
  }

  /**
   * Load contacts from wacli SQLite DB and LID mapping files.
   * Safe to call multiple times — only loads once.
   */
  async load() {
    if (this._loaded) return;
    this._loaded = true;

    this._loadLidMappings();
    await this._loadWacliContacts();
  }

  // ─── Public API ──────────────────────────────────────────

  /**
   * Resolve a WhatsApp JID to a display name.
   * Handles both phone-number JIDs and LID JIDs.
   * @param {string} jid — e.g. "919136820958@s.whatsapp.net" or "123:45@lid"
   * @returns {string|null} display name or null
   */
  resolveJid(jid) {
    if (!jid) return null;

    // Direct lookup
    const contact = this._jidContacts.get(jid);
    if (contact) return this._pickName(contact);

    // LID → phone JID → contact
    const phoneJid = this._lidToPhone.get(jid);
    if (phoneJid) {
      const c = this._jidContacts.get(phoneJid);
      if (c) return this._pickName(c);
    }

    // Strip @s.whatsapp.net and format as phone number fallback
    if (jid.endsWith("@s.whatsapp.net")) {
      return "+" + jid.replace("@s.whatsapp.net", "");
    }

    return null;
  }

  /**
   * Resolve an email address to a display name.
   * @param {string} email
   * @returns {string|null}
   */
  resolveEmail(email) {
    if (!email) return null;
    return this._emailToName.get(email.toLowerCase()) || null;
  }

  /**
   * Best-effort name resolution for any identifier.
   * Tries JID resolution, then email, then returns the raw identifier.
   * @param {string} identifier — JID, email, or raw name
   * @returns {string}
   */
  displayName(identifier) {
    if (!identifier) return "Unknown";

    // WhatsApp JID
    if (identifier.includes("@s.whatsapp.net") || identifier.includes("@lid")) {
      return this.resolveJid(identifier) || identifier;
    }

    // Email
    if (identifier.includes("@") && identifier.includes(".")) {
      return this.resolveEmail(identifier) || identifier;
    }

    // Already a name
    return identifier;
  }

  /**
   * Register an email → name mapping (from Calendar, Gmail, etc.)
   * @param {string} email
   * @param {string} name
   */
  addEmail(email, name) {
    if (email && name) {
      this._emailToName.set(email.toLowerCase(), name);
    }
  }

  /**
   * Stats for logging/debugging.
   */
  get stats() {
    return {
      contacts: this._jidContacts.size,
      lidMappings: this._lidToPhone.size,
      emails: this._emailToName.size,
    };
  }

  // ─── Internal ────────────────────────────────────────────

  /**
   * Pick the best name from a contact record.
   * Priority: fullName > pushName > businessName > firstName
   */
  _pickName(contact) {
    return (
      contact.fullName ||
      contact.pushName ||
      contact.businessName ||
      contact.firstName ||
      null
    );
  }

  /**
   * Load wacli contacts from SQLite. Uses dynamic import so the plugin
   * still works if better-sqlite3 isn't installed.
   */
  async _loadWacliContacts() {
    let Database;
    try {
      const mod = await import("better-sqlite3");
      Database = mod.default || mod;
    } catch {
      // better-sqlite3 not installed — skip wacli contacts
      return;
    }

    let db;
    try {
      db = new Database(this._wacliDb, { readonly: true });
    } catch {
      // DB file doesn't exist or is locked — skip
      return;
    }

    try {
      const rows = db
        .prepare(
          "SELECT jid, phone, push_name, full_name, first_name, business_name FROM contacts"
        )
        .all();

      for (const row of rows) {
        this._jidContacts.set(row.jid, {
          phone: row.phone,
          pushName: row.push_name,
          fullName: row.full_name,
          firstName: row.first_name,
          businessName: row.business_name,
        });
      }
    } catch {
      // Table doesn't exist or schema mismatch — skip
    } finally {
      db.close();
    }
  }

  /**
   * Load LID-to-phone mappings from INITIAL_BOOTSTRAP JSON files.
   * These files live at ~/gowa/storages/history-*-INITIAL_BOOTSTRAP.json.
   */
  _loadLidMappings() {
    let files;
    try {
      files = readdirSync(this._gowaDir).filter((f) =>
        f.startsWith("history-") && f.endsWith("-INITIAL_BOOTSTRAP.json")
      );
    } catch {
      // Directory doesn't exist — skip
      return;
    }

    for (const file of files) {
      try {
        const data = JSON.parse(
          readFileSync(join(this._gowaDir, file), "utf8")
        );
        const mappings = data.phoneNumberToLidMappings;
        if (!Array.isArray(mappings)) continue;

        for (const entry of mappings) {
          if (entry.lidJID && entry.pnJID) {
            this._lidToPhone.set(entry.lidJID, entry.pnJID);
          }
        }
      } catch {
        // Malformed JSON or read error — skip this file
      }
    }
  }
}
