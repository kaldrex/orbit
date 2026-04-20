#!/usr/bin/env node
// Builds a self-contained HTML file visualizing the top-N humans in the network.
// Nodes = humans (size by thread_count, color by channel source).
// Edges = pairs of humans sharing ≥1 WhatsApp group.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MANIFEST = path.join(ROOT, 'outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson');
const OUTPUT_DIR = path.join(ROOT, 'outputs/visualization');
const TOP_N = 200;

const lines = fs.readFileSync(MANIFEST, 'utf-8').split('\n').filter(Boolean);
const humans = lines.map((l) => JSON.parse(l));
const totalHumans = humans.length;

humans.sort((a, b) => (b.thread_count ?? 0) - (a.thread_count ?? 0));
const top = humans.slice(0, TOP_N);

const edges = [];
for (let i = 0; i < top.length; i++) {
  const a = top[i];
  const aGroups = new Set(a.groups ?? []);
  if (aGroups.size === 0) continue;
  for (let j = i + 1; j < top.length; j++) {
    const b = top[j];
    const bGroups = b.groups ?? [];
    const shared = bGroups.filter((g) => aGroups.has(g));
    if (shared.length > 0) {
      edges.push({
        from: a.id,
        to: b.id,
        value: shared.length,
        title: `Shared groups: ${shared.join(', ')}`,
      });
    }
  }
}

function colorFor(sp) {
  sp = sp ?? {};
  const count = [sp.wa_dm, sp.wa_contact, sp.wa_group, sp.gmail_from, sp.google_contact].filter(Boolean).length;
  if (count >= 4) return '#8b5cf6';
  if (sp.gmail_from && !sp.wa_dm && !sp.wa_contact && !sp.wa_group) return '#3b82f6';
  if (sp.wa_dm || sp.wa_contact || sp.wa_group) return '#10b981';
  return '#6b7280';
}

// Pick a human-readable group name to use as "via" context when there's no person-name.
// Skips raw JIDs (like 120363...@g.us) and returns the most usable group label.
function pickViaGroup(groups) {
  if (!groups || !groups.length) return null;
  const named = groups.filter((g) => typeof g === 'string' && !/@g\.us$/.test(g) && !/@s\.whatsapp\.net$/.test(g) && !/@lid$/.test(g));
  if (!named.length) return null;
  // Prefer shorter, more distinctive names over long ones; truncate safely.
  const best = named.sort((a, b) => a.length - b.length)[0];
  return best.length > 28 ? best.slice(0, 26) + '…' : best;
}

const nodes = top.map((h) => {
  const sources = Object.keys(h.source_provenance ?? {}).filter((k) => h.source_provenance[k]);
  const hasName = Boolean(h.name && h.name.trim());
  const fallbackId = h.phones?.[0] || h.emails?.[0] || '?';
  const via = hasName ? null : pickViaGroup(h.groups);
  const label = hasName ? h.name : via ? `${fallbackId} · ${via}` : fallbackId;
  return {
    id: h.id,
    label,
    value: Math.max(1, h.thread_count ?? 1),
    color: { background: colorFor(h.source_provenance), border: '#1f2937' },
    title: [
      `<b>${h.name ?? '(no name saved)'}</b>`,
      via ? `<i>via ${via}</i>` : null,
      `phones: ${(h.phones ?? []).join(', ') || '—'}`,
      `emails: ${(h.emails ?? []).join(', ') || '—'}`,
      `thread_count: ${h.thread_count ?? 0}`,
      `groups (${(h.groups ?? []).length}): ${(h.groups ?? []).filter((g) => !/@(g\.us|s\.whatsapp\.net|lid)$/.test(g)).slice(0, 3).join(', ') || '—'}`,
      `sources: ${sources.join(', ')}`,
    ].filter(Boolean).join('<br/>'),
  };
});

// Add self node — Sanchay at the center, connected to every other node.
// Every edge in this graph is implicitly "both these humans share a group WITH you",
// so making that anchor visible makes the map read honestly.
const SELF_ID = 'self-sanchay';
nodes.push({
  id: SELF_ID,
  label: 'You',
  value: Math.max(80, top[0]?.thread_count ?? 1) + 50,
  color: { background: '#fbbf24', border: '#f59e0b', highlight: { background: '#fcd34d', border: '#f59e0b' } },
  shape: 'star',
  font: { color: '#fff8dc', size: 20, face: 'system-ui', bold: true, strokeWidth: 4, strokeColor: '#1a1a1a' },
  title: '<b>You (Sanchay)</b><br/>Every edge below is a human you share at least one WhatsApp group with.',
  mass: 4,
});
for (const h of top) {
  edges.push({
    from: SELF_ID,
    to: h.id,
    color: { color: '#fbbf24', opacity: 0.15, highlight: '#fcd34d' },
    width: 0.25,
    dashes: [2, 4],
    title: `You → ${h.name || h.phones?.[0] || h.emails?.[0] || '?'}`,
  });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Orbit — Sanchay's Network (Top ${TOP_N} of ${totalHumans})</title>
<script src="https://cdn.jsdelivr.net/npm/vis-network@9.1.9/dist/vis-network.min.js"></script>
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e5e7eb; }
  #header { padding: 16px 24px; background: #1e293b; border-bottom: 1px solid #334155; }
  #header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  #header p { margin: 0 0 10px; color: #94a3b8; font-size: 13px; }
  #network { width: 100vw; height: calc(100vh - 128px); }
  .legend { display: flex; gap: 20px; flex-wrap: wrap; font-size: 13px; color: #cbd5e1; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .vis-tooltip { background: #1e293b !important; color: #e5e7eb !important; border: 1px solid #475569 !important; border-radius: 6px !important; font-size: 13px !important; line-height: 1.5 !important; padding: 10px 12px !important; }
</style>
</head>
<body>
<div id="header">
  <h1>Sanchay's Network — top ${TOP_N} of ${totalHumans.toLocaleString()} humans</h1>
  <p>Node size = thread_count · Color = primary channel · Edge = shared WhatsApp group · Hover for details</p>
  <div class="legend">
    <span><span class="dot" style="background:#10b981"></span> WhatsApp-dominant</span>
    <span><span class="dot" style="background:#3b82f6"></span> Gmail-only</span>
    <span><span class="dot" style="background:#8b5cf6"></span> Multi-source (4+ channels)</span>
    <span><span class="dot" style="background:#6b7280"></span> Other</span>
  </div>
</div>
<div id="network"></div>
<script>
const nodes = ${JSON.stringify(nodes)};
const edges = ${JSON.stringify(edges)};

const container = document.getElementById('network');
const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
const options = {
  nodes: {
    shape: 'dot',
    scaling: { min: 6, max: 48, label: { enabled: true, min: 10, max: 22, drawThreshold: 10 } },
    font: { color: '#e5e7eb', size: 11, face: 'system-ui', strokeWidth: 3, strokeColor: '#0f172a' },
    borderWidth: 1,
  },
  edges: { color: { color: '#334155', opacity: 0.35 }, smooth: false, width: 0.5, hoverWidth: 2 },
  physics: {
    barnesHut: { gravitationalConstant: -9000, springLength: 140, springConstant: 0.03, damping: 0.2, avoidOverlap: 0.4 },
    stabilization: { iterations: 300 }
  },
  interaction: { hover: true, tooltipDelay: 120, navigationButtons: true, keyboard: true },
};

const network = new vis.Network(container, data, options);
network.once('stabilizationIterationsDone', () => network.setOptions({ physics: { enabled: false } }));
</script>
</body>
</html>`;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const outPath = path.join(OUTPUT_DIR, `network-top${TOP_N}.html`);
fs.writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
console.log(`Total humans in manifest: ${totalHumans}`);
console.log(`Rendered: top ${TOP_N} nodes, ${edges.length} edges (shared-group pairs)`);
console.log('');
console.log('Top 10 by thread_count:');
top.slice(0, 10).forEach((h, i) => {
  const name = h.name ?? h.phones?.[0] ?? h.emails?.[0] ?? '?';
  const sources = Object.keys(h.source_provenance ?? {}).filter((k) => h.source_provenance[k]).length;
  console.log(`  ${String(i + 1).padStart(2)}. ${name.padEnd(26)} threads:${String(h.thread_count).padStart(3)} groups:${String((h.groups ?? []).length).padStart(2)} sources:${sources}`);
});
