import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold">
            O
          </div>
          <span className="text-lg font-semibold">Orbit</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login">
            <Button variant="ghost" className="text-zinc-400 hover:text-zinc-50">
              Sign in
            </Button>
          </Link>
          <Link href="/signup">
            <Button className="bg-violet-600 hover:bg-violet-700 text-white">
              Get started
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex flex-col items-center justify-center text-center px-6 pt-32 pb-20 max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 rounded-full bg-violet-950/50 border border-violet-800/50 px-4 py-1.5 text-sm text-violet-300 mb-8">
          Relationship Intelligence Platform
        </div>

        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-tight mb-6">
          Your network is your
          <br />
          <span className="text-violet-400">net worth</span>
        </h1>

        <p className="text-lg text-zinc-400 max-w-2xl mb-10 leading-relaxed">
          Orbit maps your relationships into a living constellation. See who matters,
          discover warm intro paths, and never let a key relationship go cold.
        </p>

        <div className="flex gap-4">
          <Link href="/signup">
            <Button
              size="lg"
              className="bg-violet-600 hover:bg-violet-700 text-white px-8"
            >
              Start for free
            </Button>
          </Link>
        </div>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-3 mt-16">
          {[
            "Relationship Graph",
            "Intro Path Finder",
            "Going Cold Alerts",
            "Network Intelligence",
            "Topic Resonance",
            "Meeting Briefs",
          ].map((f) => (
            <span
              key={f}
              className="rounded-full bg-zinc-900 border border-zinc-800 px-4 py-2 text-sm text-zinc-400"
            >
              {f}
            </span>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="text-center py-8 text-sm text-zinc-600">
        Built with Orbit
      </footer>
    </div>
  );
}
