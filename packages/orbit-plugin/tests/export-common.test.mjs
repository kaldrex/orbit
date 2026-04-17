import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalGmailExportMessage,
  canonicalWhatsappExportMessage,
  classifyGmailMessage,
  derivePhoneFromJid,
  isDirectMessageChat,
} from "../lib/export-common.js";

test("isDirectMessageChat excludes groups, broadcasts, status, newsletters", () => {
  assert.equal(isDirectMessageChat({ JID: "120363424008156177@g.us" }), false);
  assert.equal(isDirectMessageChat({ JID: "status@broadcast" }), false);
  assert.equal(isDirectMessageChat({ JID: "abc@broadcast" }), false);
  assert.equal(isDirectMessageChat({ JID: "123@newsletter" }), false);
  assert.equal(isDirectMessageChat({ JID: "54425859174518@lid" }), true);
  assert.equal(isDirectMessageChat({ JID: "919999999999@s.whatsapp.net" }), true);
});

test("derivePhoneFromJid keeps numeric heads", () => {
  assert.equal(derivePhoneFromJid("919999999999@s.whatsapp.net"), "919999999999");
  assert.equal(derivePhoneFromJid("244224742170754:36@lid"), "24422474217075436");
});

test("canonicalWhatsappExportMessage creates one canonical message row", () => {
  const row = canonicalWhatsappExportMessage({
    chat: { JID: "54425859174518@lid", Name: "Pv", Kind: "unknown" },
    contact: { JID: "54425859174518@lid", Phone: "54425859174518", Name: "Pv" },
    message: {
      ChatJID: "54425859174518@lid",
      ChatName: "Pv",
      MsgID: "m1",
      SenderJID: "me@lid",
      Timestamp: "2026-04-16T08:24:13Z",
      FromMe: true,
      Text: "kal milte",
      DisplayText: "kal milte",
    },
    backfill: {
      rounds: 2,
      completion_state: "saturated",
      completion_reason: "no older history or count increase",
      older_messages_present: true,
      first_message_at: "2026-04-16T08:24:13.000Z",
      last_message_at: "2026-04-16T09:17:42.000Z",
      message_count_for_chat: 2,
    },
  });

  assert.equal(row.source, "whatsapp");
  assert.equal(row.source_key, "m1");
  assert.equal(row.person_name, "Pv");
  assert.equal(row.message_count_for_chat, 2);
  assert.equal(row.first_message_at, "2026-04-16T08:24:13.000Z");
  assert.equal(row.last_message_at, "2026-04-16T09:17:42.000Z");
  assert.equal(row.message_id, "m1");
  assert.equal(row.text, "kal milte");
});

test("classifyGmailMessage drops obvious github notifications", () => {
  const row = classifyGmailMessage({
    id: "msg1",
    threadId: "thread1",
    labelIds: ["INBOX"],
    snippet: "@Stephen-Kimoi pushed 2 commits.",
    payload: {
      headers: [
        { name: "From", value: "steve kimoi <notifications@github.com>" },
        { name: "To", value: "\"repo\" <community-content@noreply.github.com>" },
        { name: "Subject", value: "Re: PR update" },
        { name: "Date", value: "Fri, 17 Apr 2026 04:02:29 -0700" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "View it on GitHub. You are receiving this because you are subscribed to this thread.",
              "utf8"
            ).toString("base64url"),
          },
        },
      ],
    },
  });

  assert.equal(row.decision, "drop");
  assert.match(row.decision_reason, /automated|system|operational/i);
});

test("classifyGmailMessage keeps a human-looking email thread", () => {
  const row = classifyGmailMessage({
    id: "msg2",
    threadId: "thread2",
    labelIds: ["INBOX"],
    snippet: "Would love to sync next week on creator workflows.",
    payload: {
      headers: [
        { name: "From", value: "Ramon Berrios <ramon@castmagic.io>" },
        { name: "To", value: "sanchaythalnerkar@gmail.com" },
        { name: "Subject", value: "Quick sync next week" },
        { name: "Date", value: "Fri, 17 Apr 2026 04:02:29 -0700" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "Would love to sync next week on creator workflows. Are you free Thursday?",
              "utf8"
            ).toString("base64url"),
          },
        },
      ],
    },
  });

  assert.equal(row.decision, "relationship_signal");
  assert.equal(row.person_candidates.length, 1);
  assert.equal(row.person_candidates[0].email, "ramon@castmagic.io");
});

test("canonicalGmailExportMessage preserves full-message fields without decisions", () => {
  const row = canonicalGmailExportMessage({
    id: "msg2",
    threadId: "thread2",
    labelIds: ["INBOX"],
    snippet: "Would love to sync next week on creator workflows.",
    payload: {
      headers: [
        { name: "From", value: "Ramon Berrios <ramon@castmagic.io>" },
        { name: "To", value: "sanchaythalnerkar@gmail.com" },
        { name: "Cc", value: "friend@example.com" },
        { name: "Subject", value: "Quick sync next week" },
        { name: "Date", value: "Fri, 17 Apr 2026 04:02:29 -0700" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(
              "Would love to sync next week on creator workflows. Are you free Thursday?",
              "utf8"
            ).toString("base64url"),
          },
        },
      ],
    },
  });

  assert.equal(row.source, "gmail");
  assert.equal(row.source_key, "msg2");
  assert.equal(row.from_email, "ramon@castmagic.io");
  assert.equal(row.to_emails.length, 1);
  assert.equal(row.cc_emails.length, 1);
  assert.ok(!("decision" in row));
  assert.match(row.body_text, /creator workflows/i);
});
