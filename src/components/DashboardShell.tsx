"use client";

import { useEffect } from "react";
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

interface DashboardShellProps {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
}

export function DashboardShell({ user }: DashboardShellProps) {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    fetch("/api/init", { method: "POST" }).catch(() => {});
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
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col">
      {/* TopBar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800/40">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center text-[9px] font-bold text-black">
            O
          </div>
          <span className="text-[14px] font-semibold tracking-[-0.03em] text-zinc-200">
            Orbit
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="relative h-8 w-8 rounded-full focus:outline-none cursor-pointer hover:ring-1 hover:ring-zinc-600 transition-all">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-zinc-800 text-zinc-300 text-[11px] font-medium border border-zinc-700/50">
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
              onClick={handleSignOut}
              className="text-zinc-400 focus:text-zinc-100 focus:bg-zinc-800/50 cursor-pointer text-[13px]"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Main — empty state */}
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-sm px-6">
          {/* Minimal orbital indicator */}
          <div className="relative w-16 h-16 mx-auto mb-8">
            <div className="absolute inset-0 rounded-full border border-zinc-800 animate-spin" style={{ animationDuration: "10s" }}>
              <div className="absolute -top-[3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-zinc-500" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.2)]" />
            </div>
          </div>

          <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-zinc-200 mb-1.5">
            Your constellation awaits
          </h2>
          <p className="text-[13px] text-zinc-500 mb-7 leading-relaxed">
            Add contacts or connect a data source to see your relationship graph.
          </p>
          <Button
            variant="outline"
            className="border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 text-[13px] h-9"
            disabled
          >
            Coming soon
          </Button>
        </div>
      </main>

      {/* BottomBar */}
      <footer className="flex items-center justify-between px-5 py-2 border-t border-zinc-800/40 text-[11px] text-zinc-600">
        <div className="flex items-center gap-4">
          <span>0 People</span>
          <span>0 Connections</span>
          <span>0 Going Cold</span>
        </div>
        <span>Orbit</span>
      </footer>
    </div>
  );
}
