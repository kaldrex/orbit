"use client";

export const dynamic = "force-dynamic";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Particles } from "@/components/ui/particles";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
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
          {success ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-zinc-100 mb-2">Check your email</h2>
              <p className="text-[13px] text-zinc-500 mb-6">
                Confirmation link sent to <span className="text-zinc-300">{email}</span>
              </p>
              <Link href="/login">
                <Button variant="outline" className="border-zinc-800 text-zinc-300 hover:bg-zinc-900">Back to login</Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="text-center mb-6">
                <h1 className="text-lg font-semibold tracking-[-0.02em] text-zinc-100 mb-1">Create your account</h1>
                <p className="text-[13px] text-zinc-500">Start mapping your relationship universe</p>
              </div>

              <form onSubmit={handleSignup} className="space-y-4">
                {error && (
                  <div className="text-[13px] text-red-400 bg-red-500/5 border border-red-500/10 rounded-lg p-3">{error}</div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-[12px] text-zinc-400 font-medium">Name</Label>
                  <Input id="name" type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required
                    className="h-10 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-zinc-700/30 rounded-lg" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-[12px] text-zinc-400 font-medium">Email</Label>
                  <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required
                    className="h-10 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-zinc-700/30 rounded-lg" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-[12px] text-zinc-400 font-medium">Password</Label>
                  <Input id="password" type="password" placeholder="Min 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                    className="h-10 bg-zinc-900/50 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-zinc-700/30 rounded-lg" />
                </div>
                <Button type="submit" className="w-full h-10 bg-white text-black hover:bg-zinc-200 font-medium text-[13px] rounded-lg mt-2" disabled={loading}>
                  {loading ? "Creating account..." : "Create account"}
                </Button>
              </form>

              <p className="text-center text-[13px] text-zinc-500 mt-6">
                Already have an account?{" "}
                <Link href="/login" className="text-zinc-300 hover:text-white transition-colors">Sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
