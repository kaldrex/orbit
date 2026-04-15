"use client";

import { useEffect, useState } from "react";
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
  "All", "Investors", "Sponsors", "Fellows", "Team", "Media",
  "Community", "Gov", "Founders", "Friends", "Press", "Going Cold",
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
  const [selfNodeId, setSelfNodeId] = useState(user.selfNodeId);
  const [stats, setStats] = useState({ totalPeople: 0, goingCold: 0 });

  // Init self-node if needed
  useEffect(() => {
    if (selfNodeId) return;
    fetch("/api/init", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.selfNodeId) setSelfNodeId(d.selfNodeId);
      })
      .catch(() => {});
  }, [selfNodeId]);

  // Fetch stats
  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => {
        if (d.stats) setStats({ totalPeople: d.stats.totalPeople ?? 0, goingCold: d.stats.goingCold ?? 0 });
      })
      .catch(() => {});
  }, []);

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
    <div className="h-screen bg-[#09090b] text-zinc-100 flex flex-col overflow-hidden">
      {/* TopBar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/40 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center text-[9px] font-bold text-black">O</div>
            <span className="text-[14px] font-semibold tracking-[-0.03em] text-zinc-200">Orbit</span>
          </div>

          {/* Filter pills */}
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  activeFilter === f
                    ? "bg-white text-black"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

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
            <DropdownMenuItem onClick={handleSignOut} className="text-zinc-400 focus:text-zinc-100 focus:bg-zinc-800/50 cursor-pointer text-[13px]">
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Main area */}
      <div className="flex-1 flex min-h-0">
        {/* Graph */}
        <div className="flex-1 relative">
          {selfNodeId ? (
            <GraphCanvas
              onSelectPerson={(id) => setSelectedPerson(id)}
              activeFilter={activeFilter}
              selfNodeId={selfNodeId}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
              Initializing...
            </div>
          )}
        </div>

        {/* PersonPanel */}
        {selectedPerson && (
          <PersonPanel
            personId={selectedPerson}
            onClose={() => setSelectedPerson(null)}
            onSelectPerson={(id) => setSelectedPerson(id)}
          />
        )}
      </div>

      {/* BottomBar */}
      <footer className="flex items-center justify-between px-4 py-1.5 border-t border-zinc-800/40 text-[11px] text-zinc-600 shrink-0">
        <div className="flex items-center gap-4">
          <span>{stats.totalPeople} People</span>
          <span>{stats.goingCold} Going Cold</span>
        </div>
        <span>Orbit</span>
      </footer>
    </div>
  );
}
