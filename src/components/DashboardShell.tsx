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

  // Initialize self-node on first visit
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
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      {/* TopBar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800/50">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-xs font-bold">
            O
          </div>
          <span className="font-semibold text-zinc-200">Orbit</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="relative h-9 w-9 rounded-full focus:outline-none cursor-pointer">
            <Avatar className="h-9 w-9">
              <AvatarFallback className="bg-violet-600 text-white text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 bg-zinc-900 border-zinc-800"
          >
            <div className="px-3 py-2">
              <p className="text-sm font-medium text-zinc-200">
                {user.displayName}
              </p>
              <p className="text-xs text-zinc-500">{user.email}</p>
            </div>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-zinc-400 focus:text-zinc-50 cursor-pointer"
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Main content — empty state */}
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto mb-6">
            <svg
              className="w-8 h-8 text-zinc-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-zinc-200 mb-2">
            Your constellation awaits
          </h2>
          <p className="text-sm text-zinc-500 mb-6">
            Add contacts or connect a data source to see your relationship graph come to life.
          </p>
          <Button
            variant="outline"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            disabled
          >
            Coming soon: Add contacts
          </Button>
        </div>
      </main>

      {/* BottomBar */}
      <footer className="flex items-center justify-between px-6 py-2 border-t border-zinc-800/50 text-xs text-zinc-600">
        <div className="flex items-center gap-4">
          <span>0 People</span>
          <span>0 Connections</span>
          <span>0 Going Cold</span>
        </div>
        <span>Powered by Orbit</span>
      </footer>
    </div>
  );
}
