"use client";

/**
 * Concept 4: The Linear Approach
 * No 3D. Pure typography + CSS aurora gradient.
 * Product screenshot below fold.
 */
export default function LinearStyle() {
  return (
    <div className="absolute inset-0 w-full h-full flex items-center justify-center overflow-hidden">
      {/* Aurora gradient — soft, moving */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Primary aurora */}
        <div
          className="absolute top-[20%] left-1/2 -translate-x-1/2 w-[900px] h-[400px] rounded-full animate-pulse"
          style={{
            background: "radial-gradient(ellipse 100% 60%, rgba(59,130,246,0.08) 0%, rgba(139,92,246,0.04) 40%, transparent 70%)",
            animationDuration: "8s",
          }}
        />
        {/* Secondary warm accent */}
        <div
          className="absolute top-[35%] left-[40%] w-[500px] h-[300px] rounded-full animate-pulse"
          style={{
            background: "radial-gradient(ellipse, rgba(249,115,22,0.03) 0%, transparent 70%)",
            animationDuration: "12s",
            animationDelay: "2s",
          }}
        />
      </div>

      {/* Subtle grid */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(ellipse 50% 40% at center, black 20%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(ellipse 50% 40% at center, black 20%, transparent 70%)",
        }}
      />
    </div>
  );
}
