"use client";

import { useEffect, useRef, useState } from "react";
import {
  matchByPrefix,
  type GraphPathResponse,
  type PersonLite,
} from "@/lib/graph-intelligence";
import { Input } from "@/components/ui/input";

interface EnrichedPersonsResponse {
  persons: Array<{
    id: string;
    name: string | null;
    company: string | null;
    category: string | null;
  }>;
}

export type PathState =
  | { kind: "idle" }
  | { kind: "loading"; target: string }
  | { kind: "hit"; data: GraphPathResponse }
  | { kind: "miss"; message: string };

interface IntroPathSearchProps {
  selfId: string;
  isDark: boolean;
  /** Called whenever the path state changes — Dashboard owns the strip UI
   *  so it can anchor it above the footer, not inside the header. */
  onStateChange: (s: PathState) => void;
}

/**
 * Type-ahead input that drives intro-path lookup. Visual: a small input
 * next to the filter pills. The path strip itself lives in Dashboard.
 *
 * Flow:
 *   1. Mount → fetch up to 2000 enriched persons, cache in a ref.
 *   2. Keystroke → 150ms debounce → prefix match against the cache.
 *   3. ArrowUp/Down moves the highlight; Enter selects; Esc clears.
 *   4. Selection → GET /api/v1/graph/path/:self/:target.
 *   5. On 200: state = hit. On 404: state = miss for 3s then idle.
 */
export default function IntroPathSearch({
  selfId,
  isDark,
  onStateChange,
}: IntroPathSearchProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PersonLite[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);

  const cacheRef = useRef<PersonLite[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch enriched persons once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/persons/enriched?limit=2000")
      .then((r) => (r.ok ? (r.json() as Promise<EnrichedPersonsResponse>) : null))
      .then((j) => {
        if (cancelled || !j?.persons) return;
        cacheRef.current = j.persons
          .filter((p) => p.name && p.id !== selfId)
          .map((p) => ({
            id: p.id,
            name: p.name,
            company: p.company,
            category: p.category,
          }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (missTimerRef.current) clearTimeout(missTimerRef.current);
    };
  }, [selfId]);

  // Debounced prefix match.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const hits = matchByPrefix(query, cacheRef.current ?? [], 8);
      setSuggestions(hits);
      setOpen(hits.length > 0);
      setHighlight(0);
    }, 150);
  }, [query]);

  function announceMiss(message: string) {
    onStateChange({ kind: "miss", message });
    if (missTimerRef.current) clearTimeout(missTimerRef.current);
    missTimerRef.current = setTimeout(() => {
      onStateChange({ kind: "idle" });
    }, 3000);
  }

  async function selectPerson(p: PersonLite) {
    setOpen(false);
    setQuery(p.name ?? "");
    onStateChange({ kind: "loading", target: p.name ?? "contact" });

    try {
      const r = await fetch(
        `/api/v1/graph/path/${encodeURIComponent(selfId)}/${encodeURIComponent(p.id)}`,
      );
      if (r.status === 404) {
        announceMiss(`No intro path to ${p.name} within 4 hops.`);
        return;
      }
      if (!r.ok) {
        // Neo4j 503 / anything else — treat as miss, explain.
        announceMiss("Graph intelligence unavailable.");
        return;
      }
      const data = (await r.json()) as GraphPathResponse;
      onStateChange({ kind: "hit", data });
    } catch {
      announceMiss("Path lookup failed.");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      onStateChange({ kind: "idle" });
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = suggestions[highlight];
      if (p) void selectPerson(p);
    }
  }

  const listBg = isDark ? "bg-[#09090b] border-zinc-800" : "bg-white border-zinc-200";
  const itemIdleText = isDark ? "text-zinc-300" : "text-zinc-700";
  const itemActiveBg = isDark ? "bg-zinc-800" : "bg-zinc-100";
  const itemSubText = isDark ? "text-zinc-500" : "text-zinc-400";

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder="Intro path to..."
        aria-label="Search for an intro path to a contact"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="intro-path-suggestions"
        className={`h-7 w-44 text-[11px] ${
          isDark
            ? "bg-zinc-900 border-zinc-800 text-zinc-200 placeholder:text-zinc-600"
            : "bg-white border-zinc-300 text-zinc-800 placeholder:text-zinc-400"
        }`}
      />
      {open && suggestions.length > 0 && (
        <ul
          id="intro-path-suggestions"
          role="listbox"
          className={`absolute left-0 top-8 z-40 w-64 rounded-md border shadow-lg overflow-hidden ${listBg}`}
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); void selectPerson(s); }}
              className={`px-3 py-1.5 text-[11px] cursor-pointer flex items-center justify-between gap-2 ${
                i === highlight ? itemActiveBg : ""
              } ${itemIdleText}`}
            >
              <span className="truncate">{s.name}</span>
              {s.company && (
                <span className={`truncate text-[10px] ${itemSubText}`}>{s.company}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
