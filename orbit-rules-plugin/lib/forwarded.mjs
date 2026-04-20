// Strip Gmail forwarded-chain display-name artifacts.
//
// When a user forwards an email (e.g. "billing@digitalocean.com" sends an
// invoice to "shamlata@cyphersol.co.in" who then forwards it to
// "sanchay@..."), Gmail's message headers sometimes preserve the ORIGINAL
// sender's display name ("DigitalOcean") on the downstream From header
// even though the technical From-address is the intermediate human's
// (`shamlata@cyphersol.co.in`). The display name gets attached to the
// wrong email and pollutes the person record.
//
// Heuristic: if the display name matches a well-known SaaS vendor AND the
// email domain is NOT that vendor's, the display name is a forwarded-chain
// artifact and should be dropped. Also strip bracket-only names, "X via Y",
// "X on behalf of Y" wrappers.
//
// Returns the cleaned name, or `null` if the name should be treated as
// absent (so the caller falls back to email localpart or alternate
// signal).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(path.join(HERE, "..", "data", "domains.json"), "utf8"),
);

const VENDOR_NAMES = new Set(
  (CORPUS.saas_vendor_names ?? []).map((s) => s.toLowerCase()),
);
const VENDOR_DOMAINS = CORPUS.saas_vendor_domains ?? {};

// Normalize: lowercase, collapse whitespace, strip trailing/leading
// punctuation but keep dots inside (booking.com).
function norm(s) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function emailDomain(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

function domainMatchesVendor(domain, vendorKey) {
  if (!domain) return false;
  const entries = VENDOR_DOMAINS[vendorKey] || [];
  for (const vd of entries) {
    const v = vd.toLowerCase();
    if (domain === v) return true;
    if (domain.endsWith("." + v)) return true;
  }
  return false;
}

export function stripForwardedChainName({ from_name, from_email, subject }) {
  const raw = from_name;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;

  let name = raw.trim();
  if (!name) return null;

  // bracket-only: "<foo@bar>", "<...>" → not a human name
  if (/^<.*>$/.test(name)) return null;

  // Strip common forwarding wrappers: "Name via Vendor", "Name on behalf of Vendor",
  // "Name through Vendor", "Name for Vendor". Keep the leading Name part.
  const wrapMatch = name.match(
    /^(.+?)\s+(?:via|on behalf of|through|for)\s+.+$/i,
  );
  if (wrapMatch) {
    name = wrapMatch[1].trim();
    if (!name) return null;
  }

  // Strip trailing parenthetical vendor: "Jane Doe (Stripe)" → "Jane Doe"
  const parenMatch = name.match(/^(.+?)\s*\([^)]+\)\s*$/);
  if (parenMatch) {
    const stripped = parenMatch[1].trim();
    // Only strip if the parenthetical looks like a vendor or brand — otherwise
    // keep. Being conservative: if what's inside parens matches a vendor, drop.
    const inside = norm(name.match(/\(([^)]+)\)/)[1]);
    if (VENDOR_NAMES.has(inside)) {
      name = stripped;
    }
  }

  if (!name) return null;

  // After wrapper-strip, check whether what's left IS itself a SaaS vendor
  // name mismatched with the sender domain. Use normalized comparison.
  const nname = norm(name);
  if (VENDOR_NAMES.has(nname)) {
    const domain = emailDomain(from_email);
    // Try every vendor-key that matches this name text.
    const candidateKeys = [nname];
    // also allow near variants (e.g. "digitalocean" vs "digital ocean")
    const compact = nname.replace(/\s+/g, "");
    if (compact !== nname && VENDOR_NAMES.has(compact)) candidateKeys.push(compact);
    const spaced = nname.match(/^([a-z]+)\s+([a-z]+)$/);
    if (spaced) candidateKeys.push(nname.replace(/\s+/g, ""));

    let matchedVendorDomain = false;
    for (const k of candidateKeys) {
      if (domainMatchesVendor(domain, k)) {
        matchedVendorDomain = true;
        break;
      }
    }
    // Fall back: scan every known vendor key for a domain match (e.g. name is
    // "digital ocean" but VENDOR_DOMAINS key is "digital ocean" — already in
    // candidateKeys; this is just belt+suspenders).
    if (!matchedVendorDomain) {
      for (const k of Object.keys(VENDOR_DOMAINS)) {
        if (norm(k) === nname && domainMatchesVendor(domain, k)) {
          matchedVendorDomain = true;
          break;
        }
      }
    }
    if (!matchedVendorDomain) {
      return null;
    }
  }

  return name;
}
