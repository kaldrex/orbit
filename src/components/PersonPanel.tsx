"use client";

import { useEffect, useState } from "react";
import { CATEGORY_META } from "@/lib/graph-transforms";
import { topicChipStyle } from "@/lib/topic-chip";

interface PersonProfile {
  id: string;
  name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
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

interface TopicChip {
  topic: string;
  weight: number;
}

interface PersonData {
  profile: PersonProfile;
  interactions: Interaction[];
  relationship: string;
}

// Narrow to the fields actually rendered. The card envelope returns
// more (phones, recent_corrections, total, …) but PersonPanel only
// consumes these — everything else is intentionally dropped.
interface CardEnvelope {
  card: {
    person_id: string;
    name: string | null;
    company: string | null;
    title: string | null;
    category: string | null;
    emails: string[];
    relationship_to_me: string;
    last_touch: string | null;
    observations: {
      interactions: Array<{
        channel?: string | null;
        observed_at?: string | null;
        summary?: string | null;
        topic?: string | null;
      }>;
    };
  };
}

export default function PersonPanel({
  personId,
  onClose,
}: {
  personId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<PersonData | null>(null);
  const [topics, setTopics] = useState<TopicChip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setTopics([]);

    const cardP = fetch(`/api/v1/person/${encodeURIComponent(personId)}/card`)
      .then((r) => (r.ok ? (r.json() as Promise<CardEnvelope>) : null))
      .catch(() => null);

    // Topic Resonance. Fire in parallel with the card fetch — if the
    // endpoint is missing or auth fails we just hide the row.
    const topicsP = fetch(`/api/v1/person/${encodeURIComponent(personId)}/topics?limit=10`)
      .then((r) => (r.ok ? (r.json() as Promise<{ topics: TopicChip[] }>) : null))
      .catch(() => null);

    Promise.all([cardP, topicsP]).then(([env, tEnv]) => {
      if (cancelled) return;
      if (env?.card) {
        const c = env.card;
        setData({
          profile: {
            id: c.person_id,
            name: c.name,
            company: c.company,
            title: c.title,
            email: c.emails[0] ?? null,
            category: c.category,
            lastInteractionAt: c.last_touch,
          },
          interactions: (c.observations.interactions ?? []).map((i) => ({
            channel: i.channel ?? null,
            timestamp: i.observed_at ?? null,
            direction: null,
            summary: i.summary ?? null,
            topic_summary: i.topic ?? null,
          })),
          relationship: c.relationship_to_me ?? "",
        });
      }
      if (Array.isArray(tEnv?.topics)) {
        setTopics(tEnv.topics.slice(0, 10));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [personId]);

  const meta = data?.profile.category
    ? CATEGORY_META[data.profile.category] ?? CATEGORY_META.other
    : CATEGORY_META.other;

  // Days-since-last-touch — shown next to the category pill whenever
  // `last_touch` is populated. Amber when days_since > 14, mirroring
  // the Going Cold graph filter so the founder spots stale
  // relationships at a glance. The canonical cold flag lives in the
  // graph payload; this is the panel-local surfacing.
  let daysSince: number | null = null;
  if (data?.profile.lastInteractionAt) {
    const ts = Date.parse(data.profile.lastInteractionAt);
    if (Number.isFinite(ts)) {
      daysSince = Math.max(
        0,
        Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24)),
      );
    }
  }
  const isGoingCold = daysSince !== null && daysSince > 14;

  return (
    <div className="h-full w-[380px] flex flex-col border-l border-zinc-800/40 bg-[#0c0c10]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/40">
        <span className="text-[13px] font-medium text-zinc-400">Person</span>
        <button
          onClick={onClose}
          aria-label="Close person panel"
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
              {daysSince !== null && (
                <span
                  data-testid="days-since-badge"
                  className={
                    isGoingCold
                      ? "inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                      : "text-[11px] text-zinc-500"
                  }
                  title={
                    isGoingCold
                      ? `Going cold — ${daysSince} days since last touch`
                      : `${daysSince} days since last touch`
                  }
                >
                  {daysSince}d
                </span>
              )}
              {data.profile.email && <span>{data.profile.email}</span>}
            </div>

            {data.relationship && (
              <p
                className="mt-3 text-[12px] text-zinc-300 leading-relaxed"
                data-testid="person-relationship"
              >
                {data.relationship}
              </p>
            )}

            {topics.length > 0 && (
              <div className="mt-3" data-testid="person-topics">
                <div className="flex flex-wrap gap-1.5">
                  {topics.map((t, i) => {
                    const style = topicChipStyle(t.weight, topics[0]?.weight ?? 1);
                    return (
                      <span
                        key={`${t.topic}-${i}`}
                        className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-zinc-200"
                        style={style}
                        title={`weight ${t.weight.toFixed(2)}`}
                        data-testid="topic-chip"
                      >
                        {t.topic}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
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
        </div>
      )}
    </div>
  );
}
