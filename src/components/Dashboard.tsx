"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import PersonPanel from "@/components/PersonPanel";
import AddContactDialog from "@/components/AddContactDialog";
import IntroPathSearch, { type PathState } from "@/components/graph/IntroPathSearch";
import PathStrip from "@/components/graph/PathStrip";

// Reagraph uses WebGL — must be client-only, no SSR
const GraphCanvas = dynamic(() => import("@/components/graph/GraphCanvas"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center bg-[#09090b] text-zinc-500 text-sm">
      Loading constellation...
    </div>
  ),
});

const FILTERS = [
  "All", "Sponsors", "Fellows", "Team", "Media",
  "Community", "Founders", "Friends", "Going Cold",
];

interface DashboardProps {
  user: {
    id: string;
    email: string;
    displayName: string;
    selfNodeId: string | null;
  };
}

export function Dashboard({ user }: DashboardProps) {
  const router = useRouter();
  const supabase = createClient();
  const [activeFilter, setActiveFilter] = useState("All");
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const selfNodeId = user.selfNodeId;
  const [stats, setStats] = useState({ totalPeople: 0, goingCold: 0 });
  const [showAddContact, setShowAddContact] = useState(false);
  const [graphKey, setGraphKey] = useState(0);
  const [isDark, setIsDark] = useState(true);
  const [pathState, setPathState] = useState<PathState>({ kind: "idle" });

  // Stats flow up from GraphCanvas via onStats — the graph already
  // fetches /api/v1/graph through useGraphData, so a second fetch here
  // would be redundant. /api/v1/graph still degrades gracefully to
  // HTTP 200 with zero stats until Neo4j is populated.
  const handleStats = useCallback(
    (s: { totalPeople: number; goingCold: number }) => setStats(s),
    [],
  );

  // One-shot self-init: close the onboarding gap where profiles.self_node_id
  // hasn't been resolved yet. POSTs /api/v1/self/init (idempotent on the
  // server), then refreshes so the server component re-reads the profile
  // and `user.selfNodeId` is populated on the next render.
  useEffect(() => {
    if (selfNodeId) return;
    let cancelled = false;
    fetch("/api/v1/self/init", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d?.self_node_id) router.refresh();
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selfNodeId, router]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = user.displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={`h-screen flex flex-col overflow-hidden ${isDark ? "bg-[#09090b] text-zinc-100" : "bg-[#fafafa] text-zinc-900"}`}>
      {/* TopBar */}
      <header className={`flex items-center justify-between px-4 py-2 border-b shrink-0 ${isDark ? "border-zinc-800/40" : "border-zinc-200"}`}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ${isDark ? "bg-white text-black" : "bg-zinc-900 text-white"}`}>O</div>
            <span className={`text-[14px] font-semibold tracking-[-0.03em] ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>Orbit</span>
          </div>

          {/* Filter pills */}
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  activeFilter === f
                    ? isDark ? "bg-white text-black" : "bg-zinc-900 text-white"
                    : isDark ? "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50" : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Intro-path type-ahead — relies on /graph/path. */}
          {selfNodeId && (
            <IntroPathSearch
              selfId={selfNodeId}
              isDark={isDark}
              onStateChange={setPathState}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsDark((d) => !d)}
            className={`h-7 w-7 rounded-md flex items-center justify-center text-[13px] transition-colors ${isDark ? "text-zinc-400 hover:bg-zinc-800" : "text-zinc-500 hover:bg-zinc-200"}`}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? "☀" : "☾"}
          </button>
          <Button
            onClick={() => setShowAddContact(true)}
            className={`text-[12px] font-medium h-7 px-3 rounded-md ${isDark ? "bg-white text-black hover:bg-zinc-200" : "bg-zinc-900 text-white hover:bg-zinc-800"}`}
          >
            + Add
          </Button>

          <DropdownMenu>
          <DropdownMenuTrigger className="relative h-7 w-7 rounded-full focus:outline-none cursor-pointer hover:ring-1 hover:ring-zinc-600 transition-all">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="bg-zinc-800 text-zinc-300 text-[10px] font-medium border border-zinc-700/50">
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 bg-zinc-900 border-zinc-800">
            <div className="px-3 py-2">
              <p className="text-[13px] font-medium text-zinc-200">{user.displayName}</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">{user.email}</p>
            </div>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem
              onClick={() => router.push("/dashboard/settings")}
              className="text-zinc-400 focus:text-zinc-100 focus:bg-zinc-800/50 cursor-pointer text-[13px]"
            >
              Integrations
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleSignOut} className="text-zinc-400 focus:text-zinc-100 focus:bg-zinc-800/50 cursor-pointer text-[13px]">
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </header>

      {/* Main area */}
      <div className="flex-1 flex min-h-0">
        {/* Graph */}
        <div className="flex-1 relative">
          <GraphCanvas
            key={`${graphKey}-${isDark}`}
            onSelectPerson={(id) => setSelectedPerson(id)}
            activeFilter={activeFilter}
            selfNodeId={selfNodeId || ""}
            isDark={isDark}
            onStats={handleStats}
          />
          {!selfNodeId && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[11px] text-zinc-500 bg-zinc-900/70 border border-zinc-800 rounded-full px-3 py-1 z-10">
              self-node not yet resolved — graph may not center on you
            </div>
          )}

          <PathStrip
            state={pathState}
            isDark={isDark}
            onDismiss={() => setPathState({ kind: "idle" })}
          />
        </div>

        {/* PersonPanel */}
        {selectedPerson && (
          <PersonPanel
            personId={selectedPerson}
            onClose={() => setSelectedPerson(null)}
          />
        )}
      </div>

      {/* BottomBar */}
      <footer className={`flex items-center justify-between px-4 py-1.5 border-t text-[11px] shrink-0 ${isDark ? "border-zinc-800/40 text-zinc-600" : "border-zinc-200 text-zinc-400"}`}>
        <div className="flex items-center gap-4">
          <span>{stats.totalPeople} People</span>
          <span>{stats.goingCold} Going Cold</span>
        </div>
        <span>Orbit</span>
      </footer>

      <AddContactDialog
        open={showAddContact}
        onClose={() => setShowAddContact(false)}
        onAdded={() => setGraphKey((k) => k + 1)}
      />
    </div>
  );
}
