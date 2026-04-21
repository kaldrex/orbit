"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Matches PERSON_CATEGORIES in src/lib/observations-schema.ts.
const CATEGORIES = [
  "team", "investor", "sponsor", "fellow", "media",
  "community", "founder", "friend", "press", "other",
];

// RFC4122 v4 uuid using the browser's crypto API. Falls back to a
// constructed one if crypto.randomUUID isn't available (very old browsers).
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  (typeof crypto !== "undefined" ? crypto : { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } })
    .getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

function makePersonObservation(input: {
  name: string;
  company?: string;
  email?: string;
  category?: string;
}) {
  const now = new Date().toISOString();
  const emails = input.email?.trim() ? [input.email.trim().toLowerCase()] : [];
  return {
    kind: "person" as const,
    observed_at: now,
    observer: "wazowski" as const,
    evidence_pointer: `manual://dashboard/add-contact/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    confidence: 1.0,
    reasoning: "Manual entry via Dashboard Add Contact dialog.",
    payload: {
      name: input.name.trim(),
      company: input.company?.trim() || null,
      category: (input.category || "other"),
      title: null,
      relationship_to_me: "",
      phones: [],
      emails,
    },
  };
}

function makeSingleSourceMergeObservation(input: {
  personId: string;
  sourceObservationId: string;
}) {
  const now = new Date().toISOString();
  return {
    kind: "merge" as const,
    observed_at: now,
    observer: "wazowski" as const,
    evidence_pointer: `manual://dashboard/add-contact/merge/${input.personId}`,
    confidence: 1.0,
    reasoning: "Single-source merge: materialize person from one manual-entry observation.",
    payload: {
      person_id: input.personId,
      merged_observation_ids: [input.sourceObservationId],
      deterministic_bridges: [] as string[],
    },
  };
}

interface AddContactDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export default function AddContactDialog({ open, onClose, onAdded }: AddContactDialogProps) {
  const [mode, setMode] = useState<"single" | "csv">("single");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("other");
  const [csvText, setCsvText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!open) return null;

  async function handleAddSingle(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setResult(null);

    // Step 1: write the person observation.
    const personObs = makePersonObservation({ name, company, email, category });
    const personRes = await fetch("/api/v1/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([personObs]),
    });

    if (!personRes.ok) {
      const d = await personRes.json().catch(() => ({}));
      setResult(d?.error?.message || d?.error || "Failed");
      setLoading(false);
      return;
    }

    const personBody = await personRes.json().catch(() => ({}));
    const sourceObsId: string | undefined = personBody?.inserted_ids?.[0];
    if (!sourceObsId) {
      // Dedupe hit or empty response — no new obs, nothing to merge.
      setName(""); setCompany(""); setEmail(""); setCategory("other");
      setResult("Contact already on file");
      onAdded();
      setTimeout(() => { setResult(null); onClose(); }, 800);
      setLoading(false);
      return;
    }

    // Step 2: materialize the person via a single-source merge.
    const personId = uuid();
    const mergeObs = makeSingleSourceMergeObservation({
      personId,
      sourceObservationId: sourceObsId,
    });
    const mergeRes = await fetch("/api/v1/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([mergeObs]),
    });

    if (!mergeRes.ok) {
      const d = await mergeRes.json().catch(() => ({}));
      setResult(d?.error?.message || d?.error || "Materialize failed");
      setLoading(false);
      return;
    }

    setName(""); setCompany(""); setEmail(""); setCategory("other");
    setResult("Contact added");
    onAdded();
    setTimeout(() => { setResult(null); onClose(); }, 800);
    setLoading(false);
  }

  async function handleCSVImport() {
    if (!csvText.trim()) return;
    setLoading(true);
    setResult(null);

    const lines = csvText.trim().split("\n").filter(Boolean);
    const contacts: { name: string; company?: string; email?: string; category?: string }[] = [];

    for (const line of lines) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts[0]) {
        contacts.push({
          name: parts[0],
          company: parts[1] || undefined,
          email: parts[2] || undefined,
          category: parts[3] || "other",
        });
      }
    }

    if (contacts.length === 0) {
      setResult("No valid contacts found");
      setLoading(false);
      return;
    }

    // /api/v1/observations caps the batch at 100 per POST. Batch person
    // obs by 100, then chase each person_id with a single-source merge.
    const observations = contacts.map(makePersonObservation);
    const chunks: typeof observations[] = [];
    for (let i = 0; i < observations.length; i += 100) {
      chunks.push(observations.slice(i, i + 100));
    }

    const allPersonObsIds: string[] = [];
    for (const batch of chunks) {
      const res = await fetch("/api/v1/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResult(d?.error?.message || d?.error || "Import failed");
        setLoading(false);
        return;
      }
      const body = await res.json().catch(() => ({}));
      const ids: string[] = Array.isArray(body?.inserted_ids) ? body.inserted_ids : [];
      allPersonObsIds.push(...ids);
    }

    // Materialize each new person with a single-source merge. One merge
    // per person obs (can't share a person_id across distinct contacts).
    const merges = allPersonObsIds.map((obsId) =>
      makeSingleSourceMergeObservation({ personId: uuid(), sourceObservationId: obsId })
    );
    const mergeChunks: typeof merges[] = [];
    for (let i = 0; i < merges.length; i += 100) {
      mergeChunks.push(merges.slice(i, i + 100));
    }
    for (const batch of mergeChunks) {
      const res = await fetch("/api/v1/observations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResult(d?.error?.message || d?.error || "Materialize failed");
        setLoading(false);
        return;
      }
    }

    setResult(`${allPersonObsIds.length} contacts added`);
    setCsvText("");
    onAdded();
    setTimeout(() => { setResult(null); onClose(); }, 1200);
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-zinc-800/60 bg-[#0c0c10] p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-zinc-100">Add Contacts</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg">&times;</button>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 mb-5 p-0.5 bg-zinc-900 rounded-lg">
          <button
            onClick={() => setMode("single")}
            className={`flex-1 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
              mode === "single" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500"
            }`}
          >
            Single
          </button>
          <button
            onClick={() => setMode("csv")}
            className={`flex-1 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
              mode === "csv" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500"
            }`}
          >
            CSV Import
          </button>
        </div>

        {mode === "single" ? (
          <form onSubmit={handleAddSingle} className="space-y-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-zinc-400">Name *</Label>
              <Input
                value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Doe"
                className="h-9 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 text-[13px] rounded-lg"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[11px] text-zinc-400">Company</Label>
                <Input
                  value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc"
                  className="h-9 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 text-[13px] rounded-lg"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-zinc-400">Category</Label>
                <select
                  value={category} onChange={(e) => setCategory(e.target.value)}
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 text-[13px] text-zinc-100"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-zinc-400">Email</Label>
              <Input
                value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="jane@acme.com"
                className="h-9 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 text-[13px] rounded-lg"
              />
            </div>
            <Button type="submit" className="w-full h-9 bg-white text-black hover:bg-zinc-200 text-[13px] font-medium rounded-lg mt-1" disabled={loading}>
              {loading ? "Adding..." : "Add Contact"}
            </Button>
          </form>
        ) : (
          <div className="space-y-3">
            <p className="text-[12px] text-zinc-500">
              Paste CSV: <span className="text-zinc-400">Name, Company, Email, Category</span> (one per line)
            </p>
            <Textarea
              value={csvText} onChange={(e) => setCsvText(e.target.value)}
              placeholder={"Jane Doe, Acme Inc, jane@acme.com, investor\nJohn Smith, BigCo, john@bigco.com, founder"}
              rows={8}
              className="bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 text-[12px] font-mono rounded-lg"
            />
            <Button onClick={handleCSVImport} className="w-full h-9 bg-white text-black hover:bg-zinc-200 text-[13px] font-medium rounded-lg" disabled={loading || !csvText.trim()}>
              {loading ? "Importing..." : "Import Contacts"}
            </Button>
          </div>
        )}

        {result && (
          <p className="mt-3 text-center text-[12px] text-zinc-400">{result}</p>
        )}
      </div>
    </div>
  );
}
