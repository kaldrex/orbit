"use client";

import { useEffect, useState } from "react";
import { CATEGORY_META } from "@/lib/graph-transforms";
import { Button } from "@/components/ui/button";

interface PersonProfile {
  id: string;
  name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  score: number;
  category: string | null;
  lastInteractionAt: string | null;
}

interface Interaction {
  channel: string | null;
  timestamp: string | null;
  direction: string | null;
  summary: string | null;
  topic_summary: string | null;
}

interface SharedConnection {
  id: string;
  name: string;
}

interface PersonData {
  profile: PersonProfile;
  interactions: Interaction[];
  sharedConnections: SharedConnection[];
}

export default function PersonPanel({
  personId,
  onClose,
  onSelectPerson,
}: {
  personId: string;
  onClose: () => void;
  onSelectPerson?: (id: string) => void;
}) {
  const [data, setData] = useState<PersonData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    fetch(`/api/person/${encodeURIComponent(personId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [personId]);

  const meta = data?.profile.category
    ? CATEGORY_META[data.profile.category] ?? CATEGORY_META.other
    : CATEGORY_META.other;

  return (
    <div className="h-full w-[380px] flex flex-col border-l border-zinc-800/40 bg-[#0c0c10]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/40">
        <span className="text-[13px] font-medium text-zinc-400">Person</span>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
        </div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-zinc-600">Person not found</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Profile */}
          <div className="px-4 py-5 border-b border-zinc-800/40">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium text-black"
                style={{ backgroundColor: meta.color }}
              >
                {(data.profile.name || "?")[0]?.toUpperCase()}
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-zinc-100">
                  {data.profile.name || personId}
                </h3>
                {data.profile.company && (
                  <p className="text-[12px] text-zinc-500">{data.profile.company}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                {meta.label}
              </span>
              <span>Score: {data.profile.score.toFixed(1)}</span>
              {data.profile.email && <span>{data.profile.email}</span>}
            </div>
          </div>

          {/* Timeline */}
          <div className="px-4 py-4 border-b border-zinc-800/40">
            <h4 className="text-[12px] font-medium text-zinc-400 uppercase tracking-wide mb-3">
              Interactions ({data.interactions.length})
            </h4>
            {data.interactions.length === 0 ? (
              <p className="text-[12px] text-zinc-600">No interactions recorded</p>
            ) : (
              <div className="space-y-2.5 max-h-[240px] overflow-y-auto">
                {data.interactions.slice(0, 20).map((ix, i) => (
                  <div key={i} className="flex gap-2">
                    <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-zinc-700 shrink-0" />
                    <div>
                      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                        {ix.channel && <span className="capitalize">{ix.channel}</span>}
                        {ix.timestamp && (
                          <span>{new Date(ix.timestamp).toLocaleDateString()}</span>
                        )}
                        {ix.direction && <span className="text-zinc-600">{ix.direction}</span>}
                      </div>
                      {ix.summary && (
                        <p className="text-[12px] text-zinc-400 mt-0.5 leading-relaxed">
                          {ix.summary}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Shared connections */}
          {data.sharedConnections.length > 0 && (
            <div className="px-4 py-4">
              <h4 className="text-[12px] font-medium text-zinc-400 uppercase tracking-wide mb-3">
                Shared Connections ({data.sharedConnections.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {data.sharedConnections.map((c) => (
                  <Button
                    key={c.id}
                    variant="outline"
                    className="h-7 text-[11px] px-2.5 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                    onClick={() => onSelectPerson?.(c.id)}
                  >
                    {c.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
