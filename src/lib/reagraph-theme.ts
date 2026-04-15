import type { Theme } from "reagraph";

export const orbitDarkTheme: Theme = {
  canvas: {
    background: "#09090b",
    fog: "#09090b",
  },
  node: {
    fill: "#3A3A3C",
    activeFill: "#ffffff",
    opacity: 0.95,
    selectedOpacity: 1,
    inactiveOpacity: 0.08,
    label: {
      color: "#FAFAFA",
      stroke: "#09090b",
      activeColor: "#ffffff",
    },
    subLabel: {
      color: "#a1a1aa",
      stroke: "#09090b",
      activeColor: "#ffffff",
    },
  },
  edge: {
    fill: "#d4d4d8",       // zinc-300 — visible white-ish lines on dark bg
    activeFill: "#ffffff",
    opacity: 0.45,
    selectedOpacity: 1,
    inactiveOpacity: 0.12,
    label: {
      color: "#a1a1aa",
      stroke: "#09090b",
      activeColor: "#ffffff",
      fontSize: 6,
    },
  },
  ring: {
    fill: "#27272a",
    activeFill: "#ffffff",
  },
  arrow: {
    fill: "#a1a1aa",
    activeFill: "#ffffff",
  },
  lasso: {
    border: "1px solid #FAFAFA",
    background: "rgba(255, 255, 255, 0.05)",
  },
  cluster: {
    stroke: "#18181b",
    fill: undefined as unknown as string,
    opacity: 0.2,
    label: {
      color: "#09090b",
      stroke: "#09090b",
    },
  },
};

export const orbitLightTheme: Theme = {
  canvas: {
    background: "#fafafa",
    fog: "#fafafa",
  },
  node: {
    fill: "#a1a1aa",
    activeFill: "#18181b",
    opacity: 1,
    selectedOpacity: 1,
    inactiveOpacity: 0.15,
    label: {
      color: "#18181b",
      stroke: "#fafafa",
      activeColor: "#09090b",
    },
    subLabel: {
      color: "#71717a",
      stroke: "#fafafa",
      activeColor: "#09090b",
    },
  },
  edge: {
    fill: "#71717a",       // zinc-500 — visible gray lines on light bg
    activeFill: "#18181b",
    opacity: 0.4,
    selectedOpacity: 1,
    inactiveOpacity: 0.08,
    label: {
      color: "#71717a",
      stroke: "#fafafa",
      activeColor: "#18181b",
      fontSize: 6,
    },
  },
  ring: {
    fill: "#d4d4d8",
    activeFill: "#18181b",
  },
  arrow: {
    fill: "#71717a",
    activeFill: "#18181b",
  },
  lasso: {
    border: "1px solid #18181b",
    background: "rgba(0, 0, 0, 0.05)",
  },
  cluster: {
    stroke: "#e4e4e7",
    fill: undefined as unknown as string,
    opacity: 0.2,
    label: {
      color: "#fafafa",
      stroke: "#fafafa",
    },
  },
};
