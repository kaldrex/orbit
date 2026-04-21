"use client";

import { useState } from "react";

interface CommunityToggleProps {
  on: boolean;
  onToggle: () => void;
  componentCount: number;
  unavailable: boolean;
  isDark: boolean;
}

/**
 * Filter-pill-styled button that flips category colour → community colour.
 * Disabled (with a hover tooltip) when the graph has only one connected
 * component, or when /graph/communities returned 503.
 */
export default function CommunityToggle({
  on,
  onToggle,
  componentCount,
  unavailable,
  isDark,
}: CommunityToggleProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const disabled = unavailable || componentCount <= 1;
  const tooltip = unavailable
    ? "Graph intelligence unavailable (Neo4j not populated)"
    : componentCount <= 1
    ? "Network has 1 connected component — colouring would be a no-op."
    : null;

  const activeClass = isDark ? "bg-white text-black" : "bg-zinc-900 text-white";
  const idleClass = isDark
    ? "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
    : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100";
  const disabledClass = isDark
    ? "text-zinc-700 cursor-not-allowed"
    : "text-zinc-300 cursor-not-allowed";

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && onToggle()}
        onMouseEnter={() => disabled && setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        disabled={disabled}
        aria-pressed={on}
        aria-disabled={disabled}
        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
          disabled ? disabledClass : on ? activeClass : idleClass
        }`}
      >
        Community view
      </button>
      {showTooltip && tooltip && (
        <div
          role="tooltip"
          className={`absolute top-8 left-0 z-40 whitespace-nowrap rounded-md border px-2.5 py-1 text-[10px] ${
            isDark
              ? "bg-zinc-900 border-zinc-800 text-zinc-300"
              : "bg-white border-zinc-200 text-zinc-700"
          }`}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}
