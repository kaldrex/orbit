import type { Theme } from "reagraph";

// Monochrome dark theme — matches the new Orbit SaaS palette.
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
      color: "#71717A",
      stroke: "#09090b",
      activeColor: "#ffffff",
    },
  },
  edge: {
    fill: "#3f3f46",
    activeFill: "#ffffff",
    opacity: 0.7,
    selectedOpacity: 1,
    inactiveOpacity: 0.15,
    label: {
      color: "#71717A",
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
    fill: "#18181b",
    activeFill: "#ffffff",
  },
  lasso: {
    border: "1px solid #FAFAFA",
    background: "rgba(255, 255, 255, 0.05)",
  },
  cluster: {
    stroke: "#3f3f46",
    fill: undefined as unknown as string,
    opacity: 0.5,
    label: {
      color: "transparent", // Hide cluster labels — use CategoryLegend instead
      stroke: "#09090b",
    },
  },
};
