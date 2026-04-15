"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Particles } from "@/components/ui/particles";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090b] px-4 relative overflow-hidden">
      <Particles className="absolute inset-0 z-0" quantity={30} color="#ffffff" size={0.3} staticity={60} />

      <div className="relative z-10 w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-10">
          <div className="w-7 h-7 rounded-full bg-white flex items-center justify-center text-[11px] font-bold text-black">O</div>
          <span className="text-[16px] font-semibold tracking-[-0.03em]">Orbit</span>
        </div>

        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm p-8">
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold tracking-[-0.02em] text-zinc-100 mb-1">Welcome back</h1>
            <p className="text-[13px] text-zinc-500">Sign in to your account</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="text-[13px] text-red-400 bg-red-500/5 border border-red-500/10 rounded-lg p-3">{error}</div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[12px] text-zinc-400 font-medium">Email</Label>
              <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required
                className="h-10 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-zinc-700/30 rounded-lg" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[12px] text-zinc-400 font-medium">Password</Label>
              <Input id="password" type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} required
                className="h-10 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-zinc-700/30 rounded-lg" />
            </div>
            <Button type="submit" className="w-full h-10 bg-white text-black hover:bg-zinc-200 font-medium text-[13px] rounded-lg mt-2" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <p className="text-center text-[13px] text-zinc-500 mt-6">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-zinc-300 hover:text-white transition-colors">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
