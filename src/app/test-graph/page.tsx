"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { orbitDarkTheme } from "@/lib/reagraph-theme";
import {
  toReagraphNodes,
  toReagraphEdges,
  filterEdgesByNodes,
  type ApiGraphData,
} from "@/lib/graph-transforms";

const GraphCanvas = dynamic(
  () => import("reagraph").then((m) => ({ default: m.GraphCanvas })),
  { ssr: false }
);

const UseSelectionWrapper = dynamic(
  () =>
    import("reagraph").then((m) => {
      // Wrapper that uses useSelection and renders GraphCanvas with it
      const Wrapper = ({
        nodes,
        edges,
        theme,
        graphRef,
      }: {
        nodes: any[];
        edges: any[];
        theme: any;
        graphRef: any;
      }) => {
        const {
          selections,
          actives,
          onNodeClick,
          onCanvasClick,
          onNodePointerOver,
          onNodePointerOut,
        } = m.useSelection({
          ref: graphRef,
          nodes,
          edges,
          type: "multiModifier",
          pathSelectionType: "out",
          pathHoverType: "out",
          focusOnSelect: false,
        });

        return (
          <m.GraphCanvas
            ref={graphRef}
            nodes={nodes}
            edges={edges}
            layoutType="forceDirected2d"
            animated
            cameraMode="pan"
            draggable
            theme={theme}
            sizingType="attribute"
            sizingAttribute="score"
            labelType="nodes"
            minNodeSize={4}
            maxNodeSize={28}
            defaultNodeSize={8}
            selections={selections}
            actives={actives}
            onNodeClick={onNodeClick}
            onCanvasClick={onCanvasClick}
            onNodePointerOver={onNodePointerOver}
            onNodePointerOut={onNodePointerOut}
          />
        );
      };
      return { default: Wrapper };
    }),
  { ssr: false }
);

const MAX_NODES = 100;

export default function TestGraph() {
  const [step, setStep] = useState(3);
  const [apiData, setApiData] = useState<ApiGraphData | null>(null);
  const graphRef = useRef(null);

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d: ApiGraphData) => {
        d.nodes = d.nodes.map((n) => ({
          ...n,
          category: n.category || "other",
        }));
        setApiData(d);
      });
  }, []);

  const selfNodeId = "user_728032c5";
  const allNodes = apiData
    ? toReagraphNodes(apiData.nodes, selfNodeId)
    : [];
  // Top N by score
  const capped = allNodes.length > MAX_NODES
    ? [
        ...allNodes.filter((n) => n.id === selfNodeId),
        ...allNodes
          .filter((n) => n.id !== selfNodeId)
          .sort((a, b) => b.data.score - a.data.score)
          .slice(0, MAX_NODES - 1),
      ]
    : allNodes;
  const keep = new Set(capped.map((n) => n.id));
  const allEdges = apiData
    ? filterEdgesByNodes(
        toReagraphEdges(
          apiData.links.filter(
            (l) => l.type === "knows" || (l.weight ?? 0) >= 1
          )
        ),
        keep
      )
    : [];

  const steps = [
    { label: "Step 3: Dark theme (working)", step: 3 },
    { label: "Step 4: + sizingType", step: 4 },
    { label: "Step 5: + useSelection (dashboard)", step: 5 },
  ];

  const bg = "#09090b";
  const theme = orbitDarkTheme;

  // Step 3: Simple — just data + dark theme (known working)
  if (step === 3) {
    return (
      <Shell step={step} steps={steps} setStep={setStep} nodeCount={capped.length} edgeCount={allEdges.length} bg={bg}>
        <GraphCanvas
          nodes={capped}
          edges={allEdges}
          layoutType="forceDirected2d"
          animated
          cameraMode="pan"
          draggable
          theme={theme}
        />
      </Shell>
    );
  }

  // Step 4: Add sizingType + label config (no selection)
  if (step === 4) {
    return (
      <Shell step={step} steps={steps} setStep={setStep} nodeCount={capped.length} edgeCount={allEdges.length} bg={bg}>
        <GraphCanvas
          nodes={capped}
          edges={allEdges}
          layoutType="forceDirected2d"
          animated
          cameraMode="pan"
          draggable
          theme={theme}
          sizingType="attribute"
          sizingAttribute="score"
          labelType="nodes"
          minNodeSize={4}
          maxNodeSize={28}
          defaultNodeSize={8}
        />
      </Shell>
    );
  }

  // Step 5: Full dashboard config with useSelection
  return (
    <Shell step={step} steps={steps} setStep={setStep} nodeCount={capped.length} edgeCount={allEdges.length} bg={bg}>
      <UseSelectionWrapper
        nodes={capped}
        edges={allEdges}
        theme={theme}
        graphRef={graphRef}
      />
    </Shell>
  );
}

function Shell({
  step,
  steps,
  setStep,
  nodeCount,
  edgeCount,
  bg,
  children,
}: {
  step: number;
  steps: { label: string; step: number }[];
  setStep: (s: number) => void;
  nodeCount: number;
  edgeCount: number;
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ width: "100vw", height: "100vh", background: bg }}>
      <div
        style={{
          position: "fixed",
          top: 10,
          left: 10,
          zIndex: 50,
          display: "flex",
          gap: 8,
        }}
      >
        {steps.map((s) => (
          <button
            key={s.step}
            onClick={() => setStep(s.step)}
            style={{
              padding: "6px 12px",
              background: step === s.step ? "#3B82F6" : "#333",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        style={{
          position: "fixed",
          top: 50,
          left: 10,
          zIndex: 50,
          color: "#fff",
          fontSize: 13,
        }}
      >
        Nodes: {nodeCount} | Edges: {edgeCount}
      </div>
      {children}
    </div>
  );
}
