# Frontend Surface Audit — 2026-04-21

Static analysis. No code modified, no server hit.

Scope: `src/app/**`, `src/components/**`, all `fetch()` call sites, all hooks.

---

## 1. Page inventory (7 pages)

| # | Route | File | Auth | Renders | Health |
|---|---|---|---|---|---|
| 1 | `/` | `src/app/page.tsx` | public | Landing page. Mounts `ConstellationScene` (3D, dynamic), `GrainOverlay`, `GlassCard`/`GlassSurface`, `OrbitLogo`, 8 effect UI components, 6 FEATURE cards, 3 NumberTicker stats (hardcoded 112/6/2). | OK. Stats are static props, not live data. No fetch. |
| 2 | `/login` | `src/app/login/page.tsx` | public (redirects auth'd) | Supabase `signInWithPassword`. | OK. Labels have `htmlFor`. |
| 3 | `/signup` | `src/app/signup/page.tsx` | public (redirects auth'd) | Supabase `signUp`. | OK. Labels have `htmlFor`. |
| 4 | `/auth/callback` | `src/app/auth/callback/route.ts` | public (route handler) | OAuth code exchange → `/dashboard`. | OK. |
| 5 | `/onboarding` | `src/app/onboarding/page.tsx` + `OnboardingClient.tsx` | authenticated (SSR redirect) | API-key generator + 15-s capability poll (`/api/v1/capabilities`). | OK. `/api/v1/keys` + `/api/v1/capabilities` both exist. |
| 6 | `/dashboard` | `src/app/dashboard/page.tsx` → `Dashboard.tsx` | authenticated (SSR + middleware) | Full constellation app: `GraphCanvas`, `PersonPanel`, `AddContactDialog`, `IntroPathSearch`, `PathStrip`, `CommunityToggle`. | Partial — see issue #2 (Neo4j empty → graph always blank). |
| 7 | `/dashboard/settings` | `src/app/dashboard/settings/page.tsx` → `IntegrationsPage.tsx` | authenticated | List of connectors (Google/WhatsApp/CSV/Slack/LinkedIn) with upload button. | Broken — see issue #1. `/api/connectors/*` routes do not exist. |
| 8 | `/test-graph` | `src/app/test-graph/page.tsx` | public!! | Reagraph sandbox with 3 "step" variants. | Broken — hits `/api/graph` (no such route). Dead dev page, still publicly accessible. |

Dashboard layout: `src/app/dashboard/layout.tsx` re-runs the session check server-side.

---

## 2. Component inventory (36 files, not counting hooks)

### Alive (imported by at least one page/component)

| File | Used by |
|---|---|
| `Dashboard.tsx` | `app/dashboard/page.tsx` |
| `PersonPanel.tsx` | `Dashboard.tsx` |
| `AddContactDialog.tsx` | `Dashboard.tsx` |
| `IntegrationsPage.tsx` | `app/dashboard/settings/page.tsx` |
| `OrbitLogo.tsx` | `app/page.tsx` (landing) |
| `graph/GraphCanvas.tsx` | `Dashboard.tsx` (dynamic import) |
| `graph/GraphControls.tsx` | `graph/GraphCanvas.tsx` |
| `graph/CategoryLegend.tsx` | `graph/GraphCanvas.tsx` |
| `graph/HoverCard.tsx` | `graph/GraphCanvas.tsx` |
| `graph/IntroPathSearch.tsx` | `Dashboard.tsx` |
| `graph/PathStrip.tsx` | `Dashboard.tsx` |
| `graph/CommunityToggle.tsx` | `Dashboard.tsx` |
| `landing/ConstellationScene.tsx` | `app/page.tsx` |
| `landing/GlassCard.tsx` (exports `GlassCard`, `GlassSurface`) | `app/page.tsx` |
| `landing/GrainOverlay.tsx` | `app/page.tsx` |
| `ui/button.tsx` | many (Dashboard, IntegrationsPage, AddContactDialog, PersonPanel, GraphControls, login, signup, page, dialog) |
| `ui/input.tsx` | AddContactDialog, IntroPathSearch, login, signup |
| `ui/label.tsx` | AddContactDialog, login, signup |
| `ui/textarea.tsx` | AddContactDialog |
| `ui/avatar.tsx` | Dashboard |
| `ui/dropdown-menu.tsx` | Dashboard |
| `ui/particles.tsx` | page, login, signup |
| `ui/border-beam.tsx` | page |
| `ui/shimmer-button.tsx` | page |
| `ui/animated-gradient-text.tsx` | page |
| `ui/animated-grid-pattern.tsx` | page |
| `ui/number-ticker.tsx` | page |
| `ui/word-rotate.tsx` | page |
| `ui/text-animate.tsx` | page |

### Dead (not imported anywhere outside itself)

| File | Notes |
|---|---|
| **`MeetingsStrip.tsx`** | Imports `meetings-format`. Fetches `/api/v1/meetings/upcoming`. **Not imported by Dashboard or any page.** Per Phase 5.2 it should NOT be wired — confirmed unwired, but the component + its API route + its lib/meetings-format helper are all still on disk. |
| `ui/card.tsx` | Zero imports. |
| `ui/badge.tsx` | Zero imports. |
| `ui/dialog.tsx` | Zero imports. (AddContactDialog rolls its own modal.) |
| `ui/select.tsx` | Zero imports. |
| `ui/separator.tsx` | Zero imports. |
| `ui/dot-pattern.tsx` | Zero imports. |
| `ui/morphing-text.tsx` | Zero imports. |
| `ui/text-3d-flip.tsx` | Zero imports. |

9 dead components total.

---

## 3. Fetch call inventory

| # | Site | Target | Route exists? | Notes |
|---|---|---|---|---|
| 1 | `Dashboard.tsx:65` | `GET /api/v1/graph` | alive | Degrades to `{stats:{totalPeople:0,goingCold:0}}` when Neo4j empty (route returns `EMPTY_PAYLOAD`). |
| 2 | `Dashboard.tsx:80` | `POST /api/v1/self/init` | alive | One-shot self-init when `selfNodeId` missing. |
| 3 | `PersonPanel.tsx:88` | `GET /api/v1/person/:id/card` | alive | |
| 4 | `PersonPanel.tsx:94` | `GET /api/v1/person/:id/topics?limit=10` | alive | Degrades silently on miss. |
| 5 | `AddContactDialog.tsx:103,134,190,216` | `POST /api/v1/observations` | alive | Two-step person + merge observation flow. |
| 6 | `useGraphData.ts:44` | `GET /api/v1/graph` | alive | Same route as (1) but fetched a second time by the canvas hook (see issue #3 — duplicate fetch). |
| 7 | `useGraphIntelligence.ts:46` | `GET /api/v1/graph/communities` | alive | |
| 8 | `useGraphIntelligence.ts:58` | `GET /api/v1/graph/centrality` | alive | |
| 9 | `IntroPathSearch.tsx:63` | `GET /api/v1/persons/enriched?limit=2000` | alive | |
| 10 | `IntroPathSearch.tsx:114` | `GET /api/v1/graph/path/:from/:to` | alive | |
| 11 | `OnboardingClient.tsx:53` | `GET /api/v1/capabilities` | alive | 15-sec poll. |
| 12 | `OnboardingClient.tsx:62` | `POST /api/v1/keys` | alive | |
| 13 | `MeetingsStrip.tsx:51` | `GET /api/v1/meetings/upcoming?horizon_hours=…` | alive-but-dead-component | Fetch never fires because the component is never mounted. |
| 14 | **`IntegrationsPage.tsx:109`** | `POST /api/connectors/whatsapp` | **DEAD** | No such route under `src/app/api/connectors/*`. WhatsApp upload button is broken. |
| 15 | **`IntegrationsPage.tsx:203`** | `GET /api/connectors/google/callback` (via `window.location.href`) | **DEAD** | Google "Connect" button navigates to a 404. |
| 16 | **`test-graph/page.tsx:88`** | `GET /api/graph` | **DEAD** | No such route (the real one is `/api/v1/graph`). |

### Backend routes with no frontend caller

| Route | Consumer |
|---|---|
| `POST /api/v1/raw_events` | agent (orbit-cli or bulk script), not UI |
| `GET /api/v1/observations` | agent, not UI |
| `POST /api/v1/person/:id/correct` | agent — no UI surface yet |
| `GET /api/v1/persons/going-cold` | not called from UI (Dashboard uses `/api/v1/graph` stats) |
| `POST /api/v1/lid_bridge/upsert` | agent |
| `POST /api/v1/jobs/claim`, `POST /api/v1/jobs/report` | agent worker loop |
| `POST /api/v1/graph/populate` | manual / cron |
| `GET /api/v1/graph/neighbors/:id` | not called from UI |

These are intentionally agent-only per the "API is the only writer" rule — not dead, just not frontend-used.

---

## 4. Hook inventory (2 custom hooks)

| Hook | File | Purpose | Used by |
|---|---|---|---|
| `useGraphData` | `src/components/graph/useGraphData.ts` | Mount-time `GET /api/v1/graph`, post-processes + applies dim-not-remove filter, caps at 200 connected nodes. Returns `{nodes, edges, loading, error, rawStats}`. | `GraphCanvas.tsx` |
| `useGraphIntelligence` | `src/components/graph/useGraphIntelligence.ts` | Parallel fetch of `/graph/communities` + `/graph/centrality`. Builds `communityColor` map + `hubScore` map. | `Dashboard.tsx` |

React hooks from the core library (`useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`, `useRouter`) are used throughout — not listed.

---

## 5. Layout / wiring audit

### Dashboard renders

1. Header: OrbitLogo, 9 filter pills (`All/Sponsors/Fellows/Team/Media/Community/Founders/Friends/Going Cold`), `CommunityToggle`, `IntroPathSearch` (gated on `selfNodeId`), theme toggle, `+ Add` button, `DropdownMenu` with Integrations link + Sign out.
2. Main: `GraphCanvas` (dynamic, WebGL) OR "Initializing..." placeholder when `selfNodeId` is null.
3. Side panel: `PersonPanel` when `selectedPerson` set.
4. Path strip: `PathStrip` absolute-positioned above footer.
5. Footer: `{totalPeople}` / `{goingCold}` from `/api/v1/graph` stats.
6. Modal: `AddContactDialog`.

### PersonPanel renders

Profile block (avatar, name, company, category, days-since badge, score, email, relationship), topics chips (from `/topics` endpoint), Interactions timeline (max 20), Shared connections block — **always empty** (hardcoded to `[]` on line 120; the `CardEnvelope` type has no shared connections field and the route doesn't populate one).

### Conditional-render branches that never fire with current data

- **`data.sharedConnections.map(...)`** — the `sharedConnections: []` assignment is unconditional; the rendered block is pure dead UI.
- **`GraphCanvas` empty state** (`nodes.length <= 1`) — currently the default state in prod (Neo4j not populated). Empty-state block is the ONLY thing the founder sees on `/dashboard` today.
- **`PathStrip kind:"hit"`** — requires `/graph/path` to return 200, which requires Neo4j; currently the path search always lands in `kind:"miss"`.
- **`CommunityToggle` active state** — `unavailable=true` whenever `/communities` 503s; button is disabled by default.
- **`HoverCard`** — only fires on Reagraph pointerOver; if the graph is empty it never shows.
- **`MeetingsStrip`** — not mounted anywhere; entire component branches are unreachable.

### Known empty-state trap

With an empty Neo4j, `Dashboard` renders: empty graph ("No contacts yet"), `0 People / 0 Going Cold` footer, disabled Community toggle, disabled Intro path (cache empty), no selection possible. The UI is in its "waiting for data" state — by design per `useGraphData.ts` comment — but a user landing there today sees nothing actionable.

---

## 6. Accessibility quick check

Keyboard / label coverage is **uneven**:

- **Login / signup:** `<Label htmlFor="…">` correctly paired with `<Input id="…">`. ✓
- **AddContactDialog:** 4 `<Label>` elements at lines 268, 276, 283, 295 have **no `htmlFor`** and the paired `<Input>`/`<select>` elements have **no `id`**. Screen-reader association is missing.
- **IntroPathSearch:** has `aria-label`, `aria-autocomplete`, `aria-expanded`, `aria-controls`, `role="listbox"/option"`. ✓ Good.
- **PathStrip dismiss button:** has `aria-label="Clear intro path"`. ✓
- **MeetingsStrip:** has `aria-label="Upcoming meetings"`, `aria-expanded` on toggles. ✓ (But dead.)
- **Dashboard filter pills (9 buttons):** plain `<button>` with visible text labels. OK for sighted, keyboard-navigable by default. No `aria-pressed` for the active state.
- **Dashboard theme-toggle button:** uses emoji glyphs (`☀`/`☾`) with a `title=` but no `aria-label`. Screen readers will announce "sun" / "crescent moon" from Unicode, not "Switch to dark mode".
- **Dashboard `+ Add` button:** plain text, OK.
- **PersonPanel close button:** `&times;` only, no `aria-label`.
- **GraphCanvas controls (`GraphControls`):** two raw `<select>` without `<Label>` association, buttons have text.
- **CommunityToggle:** has `aria-pressed` and `aria-disabled`. ✓
- **AddContactDialog close button:** `&times;` only, no `aria-label`.
- **test-graph page:** inline-styled buttons. (Dead, but publicly reachable.)

---

## 7. Unused type / interface audit

### `PersonPanel` local types

```
interface PersonProfile { id; name; company; title; email; score; category; lastInteractionAt; }
interface Interaction { channel; timestamp; direction; summary; topic_summary; }
interface SharedConnection { id; name; }
interface TopicChip { topic; weight; }
interface PersonData { profile; interactions; sharedConnections; relationship; }
interface CardEnvelope { card: PersonCard-shape }
```

vs. actual `/api/v1/person/:id/card` response (`src/lib/card-assembler.ts:36` `PersonCard`):

```
person_id, name, company, title, category, phones[], emails[],
relationship_to_me, last_touch, one_paragraph_summary,
observations: { interactions: ObservationRef[], recent_corrections: [], total }
```

Drift:
- `PersonProfile.score: number` — server never returns a score in the card. Hardcoded to `5` in `PersonPanel.tsx:109`. The `score` field from card routes was removed; `PersonPanel.profile.score` is a **stale shape** kept alive by a magic-number assignment.
- `PersonProfile.lastInteractionAt` → mapped from `card.last_touch`. Naming mismatch but functional.
- `PersonProfile.email: string | null` only keeps the first email; `card.emails` is a list. Multiple emails are silently dropped.
- `Interaction.direction: string | null` — not in the card payload (always mapped to `null` in line 116). Dead field.
- `Interaction.topic_summary` — comes from `i.topic`, fine.
- `SharedConnection` — **interface used only for an always-empty array** (line 120: `sharedConnections: []`). No server data, no UI surface. Entire concept is aspirational.
- `one_paragraph_summary` from the card is completely ignored (never read into the component state). Dead card field on the UI side.
- `observations.total` and `observations.recent_corrections` — ignored by the panel.

### `Dashboard` stats type

```
useState({ totalPeople: 0, goingCold: 0 })
```

matches `GraphStats` in `/api/v1/graph/route.ts:25`. ✓

### `IntroPathSearch.EnrichedPersonsResponse`

```
persons: Array<{ id; name; company; category }>
```

matches `/api/v1/persons/enriched` response. ✓

### `MeetingsStrip.ApiResponse`

Matches but the component is dead.

---

## 8. "Known-shipped but wired-badly" audit

| Item | Current state |
|---|---|
| `/api/init` no longer called | ✓ Confirmed — zero references in `src/`. Route also does not exist. |
| `/api/person/:id` (non-v1) no longer called | ✓ Confirmed — zero references. Only `/api/v1/person/...` variants used. |
| `/api/contacts` no longer called | ✓ Confirmed — zero references. |
| `MeetingsStrip` imported anywhere | ✓ Correctly unwired. But: the component file, its `/api/v1/meetings/upcoming` backend route, and its `src/lib/meetings-format.ts` helper are all still in the tree. Dead weight. |

---

## 9. Top issues

1. **IntegrationsPage has two dead backend targets.** `POST /api/connectors/whatsapp` (line 109) and `GET /api/connectors/google/callback` (line 203) have no matching routes in `src/app/api/`. The "Upload Export" and "Connect" buttons will 404 when clicked. Per the current architecture ("agent is the only writer" memory entry + `project_openclaw_role` — WhatsApp/Gmail live on OpenClaw, Orbit never reads channels directly), these buttons are architecturally stale — the whole Settings page is premised on Orbit-side connectors that were deliberately deprecated.

2. **`/test-graph` is a public dev page that hits a dead route.** `/api/graph` (no `/v1/`) does not exist. The page is under `src/app/test-graph/page.tsx` with no auth guard — anyone reaching that URL gets a broken sandbox. Should be deleted.

3. **Duplicate `/api/v1/graph` fetch on Dashboard mount.** `Dashboard.tsx:65` fetches for stats; `useGraphData.ts:44` fetches again for nodes+edges. The route returns the full payload both times. Single fetch + shared state would halve the round-trip.

4. **`PersonPanel` has a drifted data model.** `score` hardcoded to `5` because the card no longer ships it; `sharedConnections` always empty (entire block dead UI); `direction` always null; `one_paragraph_summary`, `observations.total`, `observations.recent_corrections` received but never rendered. The internal `PersonProfile`/`Interaction`/`SharedConnection` shapes don't reflect the actual `PersonCard` contract in `src/lib/card-assembler.ts`.

5. **MeetingsStrip is scaffolding in the tree without a mount point.** Component + API route + lib helper are all present and coherent, but `Dashboard` does not render it and no other surface does. Per task prompt this is expected (Phase 5.2 says don't wire it) — but the zombie dead-weight should either be wired or deleted; letting it rot invites future drift with the card contract.

Additional-but-smaller:
- AddContactDialog `<Label>` elements lack `htmlFor`/`id` pairing (a11y).
- Dashboard theme toggle + close buttons use only text glyphs for icons (a11y).
- Empty-Neo4j default renders a blank dashboard with `0 / 0` footer — intentional but user-hostile as a landing state.
