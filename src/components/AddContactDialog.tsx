"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const CATEGORIES = [
  "team", "investor", "sponsor", "fellow", "media",
  "community", "gov", "founder", "friend", "press", "other",
];

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

    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, company, email, category, score: 3 }),
    });

    if (res.ok) {
      setName("");
      setCompany("");
      setEmail("");
      setCategory("other");
      setResult("Contact added");
      onAdded();
      setTimeout(() => { setResult(null); onClose(); }, 800);
    } else {
      const d = await res.json();
      setResult(d.error || "Failed");
    }
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

    const res = await fetch("/api/contacts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts }),
    });

    if (res.ok) {
      const d = await res.json();
      setResult(`${d.created} contacts imported`);
      setCsvText("");
      onAdded();
      setTimeout(() => { setResult(null); onClose(); }, 1200);
    } else {
      const d = await res.json();
      setResult(d.error || "Import failed");
    }
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
