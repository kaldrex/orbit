import test from "node:test";
import assert from "node:assert/strict";

import WhatsAppConnector from "../connectors/whatsapp/connector.js";
import {
  buildEmailDetail,
  extractMessageBody,
  isAutomatedContent,
  isHumanContact,
} from "../connectors/gmail/rules.js";

test("WhatsApp connector skips group messages by default", () => {
  const connector = new WhatsAppConnector({
    resolveJid(jid) {
      return jid ? "Resolved Person" : null;
    },
  });

  const signal = connector.processEvent({
    message: {
      key: {
        remoteJID: "120363424008156177@g.us",
        participant: "244224742170754:36@lid",
        fromMe: false,
      },
      message: {
        conversation: "group noise",
      },
      messageTimestamp: 1770449369,
    },
  });

  assert.equal(signal, null);
});

test("WhatsApp connector still emits DM signals", () => {
  const connector = new WhatsAppConnector({
    resolveJid() {
      return "Ramon Berrios";
    },
  });

  const signal = connector.processEvent({
    message: {
      key: {
        remoteJID: "919999999999@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        conversation: "lets sync tomorrow",
      },
      messageTimestamp: 1770449369,
    },
  });

  assert.ok(signal);
  assert.equal(signal.channel, "whatsapp_dm");
  assert.equal(signal.contactName, "Ramon Berrios");
});

test("extractMessageBody prefers decoded text/plain parts", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Hello from plain text", "utf8").toString("base64url"),
        },
      },
      {
        mimeType: "text/html",
        body: {
          data: Buffer.from("<p>Hello from html</p>", "utf8").toString("base64url"),
        },
      },
    ],
  };

  const body = extractMessageBody(payload);
  assert.equal(body.textPlain, "Hello from plain text");
  assert.equal(body.text, "Hello from plain text");
});

test("isAutomatedContent catches GitHub notification bodies", () => {
  assert.equal(
    isAutomatedContent(
      "Re: PR update",
      "@Stephen-Kimoi pushed 2 commits.",
      "View it on GitHub. You are receiving this because you are subscribed to this thread."
    ),
    true
  );
});

test("isHumanContact rejects obvious system mailboxes", () => {
  assert.equal(isHumanContact("notifications@github.com", [], "Steve Kimoi"), false);
  assert.equal(isHumanContact("ramon@castmagic.io", [], "Ramon Berrios"), true);
});

test("buildEmailDetail prefers snippet over subject", () => {
  const detail = buildEmailDetail({
    subject: "Re: follow-up",
    snippet: "Would love to sync next week on creator workflows.",
    bodyText: "",
  });

  assert.equal(detail, "Would love to sync next week on creator workflows.");
});
