# Orbit — Competitive Landscape (2026-04-20)

> Research brief for positioning Orbit: a single-founder cross-channel relationship memory, owned by an on-machine agent (OpenClaw), aimed at the long-tail 400–800 humans a founder has forgotten.

---

## 1. Executive summary

- **The space is crowded at the top, empty at the bottom.** ~15 credible personal CRMs exist (Clay/Mesh, Folk, Dex, Monica, Nat, Covve, UpHabit, Mogul, Relatable, Clay-VC/Attio, Affinity, Mesh, Dossy, Claryti, Saner). None are built around *long-tail discovery* — every one of them optimizes the known top-30 relationships.
- **Privacy is marketed everywhere, delivered almost nowhere.** Only Monica (self-hostable) and Mogul (E2E encrypted) truly put data under the user's control. Clay/Folk/Dex are multi-tenant SaaS blobs. The "agent-on-my-machine" posture is uncontested.
- **Cross-channel unification is the hot keyword but WhatsApp is the hole.** Dex, Folk, and Clay/Mesh cover Gmail/Calendar/LinkedIn well. Only Folk natively integrates WhatsApp — and even Folk's WhatsApp is thin (Chrome extension, not historical ingest). WhatsApp-first cross-channel is a *genuine wedge*.
- **The device category collapsed.** Humane AI pin is dead, Rewind was acquired and shut down, Limitless stopped new sales, Rabbit R1 is nearly insolvent. "Ambient memory" as a category failed — the winners pivoted to conversation transcription (Plaud, Bee, Fireflies). Wearable-memory is no longer a competitive threat to a software-first relationship memory.
- **Clay.earth rebranded to Mesh (me.sh) — the single most important signal.** The category leader in "personal CRM as relationship intelligence" did not find enough traction as "Clay for people" and had to rebrand. That's a signal the "personal CRM" framing itself may be broken — not just the products.

---

## 2. Direct competitors

### Comparison table

| Product | Positioning | Price (personal) | WhatsApp | Gmail | LinkedIn | Privacy posture | Target user |
|---|---|---|---|---|---|---|---|
| **Mesh (ex-Clay.earth)** | AI-enriched contact database | Free / $10/mo Pro | No | Yes | Yes | SaaS multi-tenant | Consultants, networkers |
| **Folk** | Team/solo CRM w/ network sync | $24–$48/user/mo | Chrome ext only | Yes | Yes (folkX) | SaaS multi-tenant | SMB sales, agencies |
| **Dex** | Personal CRM, mobile-first | $12 / $20 /mo | Yes (integ.) | Yes | Yes | SaaS multi-tenant | Solo pros, founders |
| **Monica** | Open-source PRM | Free self-host / $9 mo | No | No | No | Self-hostable (best) | Privacy-first hobbyists |
| **Mogul** | E2E-encrypted personal CRM | Subscription (undisclosed tiered) | No | No | No | End-to-end encrypted | Founders, lawyers |
| **Nat.app** | "Who you're losing touch with" | ~$9/mo | No | Yes | Yes | SaaS multi-tenant | Consultants |
| **Covve** | Business card scanner + intel | Freemium + subscription | No | No | Via enrichment | SaaS multi-tenant | In-person networkers |
| **Attio** | Flexible B2B CRM, AI attributes | $29–$119/user/mo | No | Yes | Via enrichment | SaaS multi-tenant | Startup GTM |
| **Affinity** | VC relationship intelligence | $85–100/user/mo | No | Yes | Yes | SaaS multi-tenant | VC/PE firms |
| **Relatable** | AI personal CRM w/ "Whiz" assistant | Subscription | Limited | Yes | Yes | SaaS multi-tenant | Realtors, agents |
| **UpHabit** | Solo/team personal CRM | Free / $19.99/mo | No | Yes | Yes | SaaS multi-tenant | SMB professionals |
| **Claryti** | Meeting-centric relationship context | $15/mo | No | Yes | No | SaaS multi-tenant | Meeting-heavy PMs |
| **Dossy** | Relationship AI summaries | Unverified | No | Yes | No | SaaS multi-tenant | Networkers |

### Per-product dossiers

#### Mesh (ex-Clay.earth) — the bellwether
- **URL:** `https://me.sh` (old clay.earth redirects)
- **Positioning:** *Be more thoughtful with the people in your network* — auto-enriched living contact database.
- **Pricing (2026):** Free Personal (1000 contacts); Pro $10/mo unlimited contacts; Team $40/seat/mo; Enterprise custom.
- **Features:** Email/calendar/Twitter/LinkedIn/iMessage import, life-update notifications (job/location/news), reconnect prompts, groups, birthdays.
- **Platform:** Web + iOS.
- **SWOT:**
  - **S:** Beautiful UX, known brand, real-time enrichment from public web.
  - **W:** Forced rebrand to Mesh — category positioning didn't stick. Users complain LinkedIn scraping is stale. Uses personal Gmail OAuth scopes many find intrusive. Ghosting support on Trustpilot.
  - **O:** Meta/AI wave gives them tailwind.
  - **T:** Clay (the B2B sales enrichment tool `clay.com`, different company) eclipses them in mindshare.
- **Source:** [Mesh pricing](https://me.sh/pricing), [TrustPilot](https://www.trustpilot.com/review/clay.earth), [TechCrunch 2023 AI helper launch](https://techcrunch.com/2023/05/16/personal-crm-app-clay-introduces-an-ai-helper-to-help-you-navigate-your-relationships/).

#### Folk — the SMB sales CRM
- **URL:** `https://www.folk.app`
- **Pricing (2026):** Standard $24/user/mo (annual) or $30 monthly; Premium $48/user/mo; Custom $80+/user/mo. 14-day trial.
- **Features:** Gmail/Outlook sync, folkX LinkedIn Chrome ext, WhatsApp integration, pipelines, AI email sequences, team workspaces.
- **Platform:** Web only — **no mobile app** (most-cited gripe).
- **SWOT:**
  - **S:** Clean UX, fast setup (~20 min), native WhatsApp + LinkedIn, team primitive.
  - **W:** No mobile, weak dupe detection (needs exact name + email match), dashboards "in beta," patchy Outlook sync.
  - **O:** Obvious expand path into AI-native CRM territory before Attio.
  - **T:** Attio for anyone needing flexibility; Clay/Mesh for lightweight solo.
- **Source:** [Folk pricing](https://www.folk.app/pricing), [Capterra reviews](https://www.capterra.com/p/251534/folk/reviews/).

#### Dex — the mobile-first personal CRM
- **URL:** `https://getdex.com`
- **Pricing (2026):** Premium $12/mo, Professional $20/mo. 7-day trial.
- **Features:** Mobile + desktop + Chrome ext; LinkedIn sync (2.5k–9k connections); WhatsApp/SMS/Gmail/Outlook integration; timeline view; AI pre-meeting briefings; auto-grouping; map view.
- **SWOT:**
  - **S:** Only competitor with true mobile-first and WhatsApp presence; ~30k active users; 2026 AI features genuinely useful (message suggestions, auto-groups).
  - **W:** Performance issues (users report slow sync, stale cached pages); VoiceOver broken on iOS; subscription priced high vs. competitors for what it delivers.
  - **O:** Their 2026 AI roadmap is correct direction — pre-meeting briefings are Orbit territory.
  - **T:** Mesh undercuts them on price at $10/mo; Folk wins on team use.
- **Source:** [Dex pricing](https://getdex.com/pricing/), [Dex on SoftwareAdvice](https://www.softwareadvice.com/crm/dex-profile/).

#### Monica — the open-source benchmark
- **URL:** `https://www.monicahq.com` / `https://github.com/monicahq/monica`
- **Pricing:** Free self-host, $9/mo cloud. Same features both ways.
- **Features:** Contacts, interactions, journals, reminders, debts, relationships-between-contacts, API, multi-user.
- **Platform:** Web (Laravel).
- **SWOT:**
  - **S:** Most credible privacy story in the space (truly self-hostable); API-first; never been ad-supported.
  - **W:** *Not built for professional networking.* No fast capture, no LinkedIn/Gmail integration, dated UI. Feels like family-tree software.
  - **O:** OSS brand could be leveraged by another product.
  - **T:** The next SaaS entrant with real privacy + modern UX.
- **Source:** [Monica GitHub](https://github.com/monicahq/monica), [Dex's review of Monica](https://getdex.com/blog/monica-review/).

#### Mogul — the encrypted niche play
- **URL:** `https://www.mogulnetworking.com`
- **Pricing:** Subscription (tiers undisclosed on landing).
- **Features:** End-to-end encryption, data export any time, web + iOS.
- **SWOT:**
  - **S:** Only E2E-encrypted personal CRM in market; founder (Chris Raroque) has YouTube following.
  - **W:** Small. Niche. No cross-channel ingest — users manually enter contacts. E2E means no server-side AI enrichment.
  - **O:** Privacy-first buyer is under-served.
  - **T:** E2E is architecturally incompatible with the LLM enrichment everyone wants.
- **Source:** [Mogul home](https://www.mogulnetworking.com/), [Mogul for founders](https://www.mogulnetworking.com/startup-founders).

#### Nat.app — part-time zombie
- **URL:** `https://www.nat.app`
- **Status:** Alive but "small distributed part-time team" per their own site. Last major HN push was 2022 ("who you're losing touch with"). Reviews in Feb 2026 confirm it runs.
- **Positioning:** Loss-of-touch detection for consultants.
- **Takeaway:** The *concept* is close to Orbit's long-tail thesis, but execution is dormant. **Orbit should study their HN post for the messaging that resonated.**
- **Source:** [Nat Show HN](https://news.ycombinator.com/item?id=30836418), [Crunchbase](https://www.crunchbase.com/organization/nat-app).

#### Covve — the scanner
- **URL:** `https://covve.com`
- **Positioning:** 96% accurate business card scanner + AI contact enrichment.
- **Features:** Card/QR/badge/voice capture, digital business card, enrichment, 60-lang, Zoho/Pipedrive/HubSpot integrations.
- **Takeaway:** Adjacent, not direct. They win in-person events; Orbit wins post-event (what you do with the 400 cards three months later).
- **Source:** [Covve home](https://covve.com/home).

#### Attio — the "what to steal"
- **URL:** `https://attio.com`
- **Pricing (2026):** Free (50k records); Plus $29/user/mo; Pro $69/user/mo; Enterprise ~$119+/user/mo.
- **Features worth stealing:** AI Attributes (custom fields that auto-fill via LLM); Ask Attio conversational UI; flexible data model (people, companies, deals, custom objects); real-time collaboration.
- **Takeaway:** Attio's "AI Attributes" is essentially what Orbit's LLM enrichment layer will be. Their data model (objects + attributes + references) is a good mental model for Orbit's packet schema.
- **Source:** [Attio pricing](https://attio.com/pricing).

#### Superhuman — email-centric, "people" is secondary
- **URL:** `https://superhuman.com`
- **Pricing (2026):** Starter $30/mo; Business $40/mo; Enterprise custom.
- **People features:** Share Availability, Shared Conversations, Team Comments. *No real relationship memory* — it's an email client that happens to know who you email.
- **Takeaway:** Not a direct competitor. Users pay $30/mo for keyboard speed, not people intelligence. Useful as a pricing anchor: founders *will* pay $30+/mo for a daily tool.
- **Source:** [Superhuman plans](https://superhuman.com/plans).

#### Shortwave — AI email, no people model
- **URL:** `https://www.shortwave.com`
- **Pricing:** Free; Personal Pro $9/mo ($7 annual); Business $24/seat; Premier $36/seat; Max $100/seat.
- **Features:** Ghostwriter (learns your voice), AI search ("what did Sarah say about Q3"), Tasklet automations, thread summaries.
- **Gmail-only.** Not a people tool — an email tool. Same takeaway as Superhuman.
- **Source:** [Shortwave pricing](https://www.shortwave.com/pricing/).

#### Affinity — the VC ceiling
- **URL:** `https://www.affinity.co`
- **Pricing (2026):** $85–$100/user/mo. Essential / Advanced tiers.
- **Features:** Auto-mapped relationship intelligence, intro-path scoring, firmographic enrichment, Gmail/Outlook extensions.
- **Takeaway:** Shows what the relationship-intelligence category looks like when you can charge $1200/user/year. **Orbit's long-term monetization ceiling for founders/angels.** Not a direct competitor (team-only, VC-specific); a pricing reference.
- **Source:** [Affinity pricing](https://www.affinity.co/product/affinity-pricing).

#### Relatable, UpHabit, Claryti, Dossy — second-tier
- **Relatable:** AI personal CRM with "Whiz" assistant; realtor-heavy user base. Good for proving AI-as-copilot in the space is mainstream ([link](https://try.relatable.one/)).
- **UpHabit:** Free personal / $19.99 business; Chrome ext + mobile + API. Competent but undifferentiated ([link](https://uphabit.com/)).
- **Claryti:** $15/mo; meeting-intelligence-first; Gmail/Cal/Slack/Meet/Zoom/Teams. "Context cards before every meeting" — a feature Orbit should consider ([link](https://www.claryti.ai/)).
- **Dossy:** "Relationship intelligence" framing; limited public pricing info; "contacts you've forgotten" language is closest to Orbit's thesis ([link](https://dossy.ai/)).

#### Dead / abandoned — skip
- **Contactually:** Acquired by Compass 2019 for realtors, effectively dead as a general product.
- **Tactyc:** Acquired by Carta 2024, not a personal CRM.
- **Humane AI pin:** Bricked Feb 28, 2025 after HP acquisition.
- **Rewind.ai:** Acquired by Limitless 2025, Mac app shut down.
- **Pi (Inflection):** Absorbed into Microsoft via $650M licensing deal, 2024.

---

## 3. Adjacent / inspirational products

### Table

| Product | Category | People/Relationship handling | Relevance to Orbit |
|---|---|---|---|
| **Limitless (ex-Pendant)** | Voice wearable + recall | Speaker diarization; "who said what" with 20-sec voiceprints | Acquired by Meta Dec 2025, stopped sales. Low threat. |
| **Rewind.ai** | Screen capture memory | Search by person's name surfaces screen moments | Dead — shut down 2025. |
| **Plaud / Bee AI** | Voice recorders | Transcription, speaker labels | Source of conversation text; could feed Orbit. |
| **Mem.ai** | AI-native notes | Entity extraction, contact backlinks | Inspiration for automatic-organization UX; not a relationship tool. |
| **Notion AI** | Docs + DB | Manual "person" properties | Not competition — a data collection surface Orbit could *ingest*. |
| **Saner.ai** | ADHD-aware second brain | Slack/Drive/Email centralization | Mirrors the "prosthetic memory" framing Orbit should use. |
| **Reflect** | Daily-notes + AI | Linked notes, no people model | Not competition. |
| **Pi (Inflection)** | Personal AI companion | Remembered chat context, no real people model | Dead as a consumer product. |
| **Rabbit R1** | Agent device | No relationship memory | Near-bankrupt; not a threat. |

### Takeaways from the adjacent category

- **The ambient-memory device category collapsed in 2025.** Every wearable-first bet (Humane, Rabbit, Limitless) either failed or got acquired. The thesis that "capture everything passively" wins retail was wrong. What survived: narrow conversation transcribers (Plaud, Bee, Granola, Fathom).
- **"Memory" has shifted back to software.** Mem.ai, Saner, Claryti all frame themselves as *prosthetic memory*. Orbit can claim this language honestly — it's literally a founder's relationship memory.
- **None of them model humans as first-class entities.** Mem, Notion, Reflect all treat people as tags or backlinks. A proper *person-record* is still mostly the personal-CRM category's domain.

---

## 4. Gap analysis — what nobody does well

This is where Orbit's opportunity concentrates.

### Gap 1 — Long-tail discovery is uncontested

- Every competitor optimizes the **known top 30**: reminders for investors you already know you should follow up with, birthday prompts for 50 stars.
- **Nobody surfaces "you shared 3 meetings with this person in 2023 and haven't spoken since."** Dossy gets closest (their messaging literally mentions "forgotten contacts") but their product is thin.
- Nat.app's 2022 HN title was *"personal CRM that knows who you're losing touch with"* — they tapped the thesis but never delivered.
- **This is Orbit's sharpest wedge.** 400–800-person scale + co-presence signals + cross-channel merge is uniquely hard, uniquely valuable, and nobody's building it.

### Gap 2 — WhatsApp ingest is a single-product market

- Folk and Dex "support WhatsApp" but via Chrome extension or manual message forwarding. **Nobody ingests WhatsApp history at depth.**
- Yet for most founders outside the US (and increasingly inside), WhatsApp is the primary relationship channel.
- Orbit's WhatsApp-first ingest (33k messages in 10 sec from wacli) is technically a year ahead of anything in the category.

### Gap 3 — Privacy is theater for everyone except Monica

Consistent user complaints across Clay/Mesh, Folk, Dex:
- OAuth scope asks for full Gmail read — "feels intrusive."
- Data is stored multi-tenant with no customer-owned encryption key.
- "GDPR compliant" is stamped on every site; none of them let the user actually own the DB.

Orbit's posture — "the agent writes to *your* Postgres, on *your* Vercel or on your Mac" — is uncontested. **Monica has the architecture; Orbit has the UX.** That's a winnable middle.

### Gap 4 — No one closes the feedback loop

Every competitor is **write-only**: the product captures contacts, maybe prompts you to reach out, but reaching out happens in Gmail/WhatsApp/Superhuman. The action never writes back.

Orbit + OpenClaw is the only architecture where:
1. The agent sees the founder write a WhatsApp reply
2. The agent logs that as an observation on the person record
3. The packet updates, and the next prompt knows the state changed

That feedback loop is the moat. **Name it in the positioning.**

### Gap 5 — "Agent on my machine" is positionally open

There's one competitor framing itself this way: **DenchClaw** (`dench.com`) — local-first, DuckDB, Anthropic API calls only for LLM enrichment. Worth a closer look as the closest architectural cousin. But they're CRM-shaped (HubSpot-import target), not relationship-memory-shaped.

- **Where the "agent on my machine" positioning wins:**
  - Founders who've been burned by a SaaS shutting down (cf. Humane, Rewind, Pi).
  - Lawyers/doctors/therapists with compliance pressure.
  - Non-US users who can't legally send client contact lists to US SaaS.
- **Where it loses:**
  - The user doesn't want to run a process. Orbit's OpenClaw + Mac dependency is friction Mesh doesn't have.
  - Mobile. If you're running on the founder's Mac, there's no iOS presence. Dex wins here forever.
  - No network effects — no "share with team."

### Consistent complaint themes across the category

Pulled from G2, Trustpilot, Capterra, HN, and review aggregators:

1. **Price for value.** Clay/Mesh users say "I'm paying $10/mo for LinkedIn scraping that's months stale." Dex users say "too expensive for what it does."
2. **Imports are janky.** Clay took 20 hours to sync one user's Gmail. Folk's dupe detection fails on name variants. Nobody gets contact merging right.
3. **Mobile is either missing or a glitch-fest.** Folk has no app. Dex's is buggy and breaks VoiceOver. Monica is web-only.
4. **AI features feel bolted-on.** Attio's "AI Attributes" is the only implementation reviewers call genuinely useful; the rest get "nice toy, not daily-driver" reviews.

---

## 5. Pricing map

### What personal-CRM users actually pay

| Tier | Typical price | Products in tier | What you get |
|---|---|---|---|
| **Free / hobby** | $0 | Monica (self-host), Mesh Personal, Attio Free, Shortwave Free | Limited contacts, basic enrichment, no AI |
| **Solo prosumer** | $9–$15/mo | Monica Cloud ($9), Shortwave Pro ($9), Mesh Pro ($10), Dex Premium ($12), Claryti ($15) | Unlimited contacts, basic AI, single-user |
| **Solo pro** | $19–$30/mo | UpHabit Business ($19.99), Dex Professional ($20), Folk Standard ($24–30), Superhuman ($30) | Full AI features, integrations, daily-driver ergonomics |
| **Team** | $40–$80/user/mo | Mesh Team ($40), Folk Premium ($48), Attio Pro ($69), Folk Custom ($80+) | Collaboration, admin, pipelines |
| **VC/enterprise** | $85–$120+/user/mo | Affinity ($85–100), Attio Enterprise ($119+) | White-glove relationship intelligence, SSO, SOC2 |

### Pricing models observed
- **Seat-based (dominant):** Folk, Attio, Mesh Team, Affinity, Superhuman.
- **Per-contact:** Mesh Personal (1000-contact free tier).
- **Usage credits:** Attio (automation credits), Clay (enrichment credits — the B2B Clay, not Mesh).
- **Lifetime:** Only Covve Scan appears on AppSumo; nobody else does lifetime.
- **Self-host free:** Monica (alone in this slot).

### Founder/VC-premium tier?
Only **Affinity** ($85+/user/mo) explicitly targets investor/founder pricing. Attio Enterprise gets there via custom contract. **No product targets the single founder at $50–$100/mo** — there's a clear white-space between $30 (Superhuman) and $85 (Affinity).

### What Orbit can charge
- **Self-host free** — required to compete on privacy story and match Monica.
- **Managed/cloud $20–$30/mo** — sits between Dex Professional and Superhuman. Credible.
- **Founder concierge $75–$100/mo** — includes hand-tuned imports, priority enrichment, support. Anchors on Affinity without competing with it.

---

## 6. Orbit's positioning recommendation

### Core USP (one sentence)

> **Orbit is the founder's cross-channel memory — an agent on your own machine merges your WhatsApp, Gmail, and calendar into one record per human, then surfaces the 400 people you've forgotten but shouldn't have.**

Three load-bearing claims in that sentence, each defensible against the field:
1. **Cross-channel** (nobody unifies WhatsApp depth + Gmail + Calendar — Folk/Dex are thin on WA, Mesh has no WA).
2. **Agent on your own machine** (only DenchClaw + Monica share this posture; neither is relationship-shaped).
3. **Long-tail discovery** (Nat and Dossy gestured at this; no one delivered).

### Who to study closely (direct)

1. **Dex** — closest execution competitor. Their mobile, their WhatsApp integration, their 2026 AI roadmap. Read their changelog monthly.
2. **Nat.app** — closest thesis competitor. Read their original HN post + all top comments for the language that resonated.
3. **Mesh (ex-Clay.earth)** — the category bellwether. Their rebrand is a cautionary tale: "personal CRM" as a category may be broken. Pick different language.

### Who to watch (indirect)

1. **Attio** — their "AI Attributes" and data model are the right shape. If they ship a personal-tier product, they're dangerous.
2. **Affinity** — the monetization ceiling. Learn how they justify $1200/user/year.
3. **Mogul** + **Monica** — privacy-native pair. If either adds modern cross-channel ingest, they're direct.

### What NOT to compete on

- **Mobile-first.** Dex owns this lane and Orbit's OpenClaw-on-Mac architecture loses structurally. Ship mobile only as read-only companion, late.
- **Team CRM / sales pipelines.** That's Folk and Attio. Orbit's single-founder premise breaks the moment you add seats — don't chase it.
- **AI email-writing.** Shortwave, Superhuman, Folk all do this already. Orbit should *feed* those products (via observations on who to contact), not replace them.
- **Business-card scanning.** Covve is good enough. Build an integration, not a competitor.
- **Ambient recording.** The category just died. Don't resurrect it.
- **Enterprise / VC.** Affinity owns that market. Stay under the ceiling.

### Narrative recommendations

- **Stop saying "personal CRM."** Clay had to rebrand away from that phrase. Say *relationship memory* or *network memory*.
- **Lead with WhatsApp.** It's the biggest genuine wedge in the comparison table.
- **Name the feedback loop.** "The agent sees what you do, remembers for you." This is the *real* product, and nobody else can claim it.
- **Be loud about the long tail.** Screenshots of "30 people you haven't messaged in 6 months" are more powerful than another pipeline view.

---

## 7. Sources

### Direct competitors
- [Mesh pricing (ex-Clay.earth)](https://me.sh/pricing)
- [Clay/Mesh G2 reviews](https://www.g2.com/products/clay-clay/reviews)
- [Clay/Mesh Trustpilot](https://www.trustpilot.com/review/clay.earth)
- [Clay AI helper launch — TechCrunch 2023](https://techcrunch.com/2023/05/16/personal-crm-app-clay-introduces-an-ai-helper-to-help-you-navigate-your-relationships/)
- [Personal CRMs Aren't What I Need — Danny Smith](https://danny.is/writing/personal-crms-clay-earth-is-not-what-i-need/)
- [Folk pricing](https://www.folk.app/pricing)
- [Folk full review 2026](https://www.folk.app/articles/folk-reviews-what-do-people-really-think-of-our-crm-and-the-alternatives)
- [Folk Capterra reviews](https://www.capterra.com/p/251534/folk/reviews/)
- [Dex pricing](https://getdex.com/pricing/)
- [Dex on SoftwareAdvice](https://www.softwareadvice.com/crm/dex-profile/)
- [Atomic review: Dex — Paolo Belcastro](https://paolo.blog/blog/atomic-review-dex-personal-crm/)
- [Monica homepage](https://www.monicahq.com/)
- [Monica GitHub](https://github.com/monicahq/monica)
- [Monica pricing](https://www.monicahq.com/pricing)
- [Dex's Monica review](https://getdex.com/blog/monica-review/)
- [Nat.app Show HN (2022)](https://news.ycombinator.com/item?id=30836418)
- [Nat.app Crunchbase](https://www.crunchbase.com/organization/nat-app)
- [Nat.app SoftwareWorld 2026 review](https://www.softwareworld.co/software/natapp-reviews/)
- [Covve home](https://covve.com/home)
- [Covve business card scanner](https://covve.com/business-card-scanner)
- [Attio pricing](https://attio.com/pricing)
- [Attio CRM 2026 review — Stacksync](https://www.stacksync.com/blog/attio-crm-2025-review-features-pros-cons-pricing)
- [Affinity home](https://www.affinity.co/)
- [Affinity pricing](https://www.affinity.co/product/affinity-pricing)
- [Affinity on Vendr](https://www.vendr.com/marketplace/affinity)
- [Superhuman plans](https://superhuman.com/plans)
- [Superhuman review 2026](https://efficient.app/apps/superhuman)
- [Shortwave pricing](https://www.shortwave.com/pricing/)
- [Shortwave vs Superhuman — Zapier](https://zapier.com/blog/shortwave-vs-superhuman/)
- [UpHabit home](https://uphabit.com/)
- [Mogul home](https://www.mogulnetworking.com/)
- [Mogul for startup founders](https://www.mogulnetworking.com/startup-founders)
- [Relatable](https://try.relatable.one/)
- [Claryti — relationship intelligence](https://www.claryti.ai/features/relationship-intelligence)
- [Dossy](https://dossy.ai/)

### Adjacent / inspirational
- [Limitless Pi — help center pricing](https://help.limitless.ai/en/articles/9129649-pricing-plans)
- [Limitless acquisition coverage](https://www.toolify.ai/ai-news/limitless-ai-pendant-revolutionizing-productivity-and-recall-3475946)
- [Rewind → Limitless transition](https://ucstrategies.com/news/rewind-ai-mac-memory-search-tool-specs-privacy-pricing-2026/)
- [Humane AI Pin death — AppleInsider](https://forums.appleinsider.com/discussion/239305/humanes-ai-pin-is-no-more-and-owners-are-left-with-nothing)
- [Rabbit R1 status 2026 — TechRadar](https://www.techradar.com/computing/artificial-intelligence/with-the-humane-ai-pin-now-dead-what-does-the-rabbit-r1-need-to-do-to-survive)
- [AI product failures 2026](https://www.digitalapplied.com/blog/ai-product-failures-2026-sora-humane-rabbit-lessons)
- [Inflection AI / Pi — Microsoft deal, TechCrunch](https://techcrunch.com/2024/03/19/after-raising-1-3b-inflection-got-eaten-alive-by-its-biggest-investor-microsoft/)
- [Mem.ai review 2026](https://www.fahimai.com/mem-ai)
- [Saner.AI ADHD-friendly Reflect alternative](https://saner.ai/adhd-friendly-reflect-alternative/)

### Market / gap context
- [Relationship intelligence — Introhive](https://www.introhive.com/relationship-intelligence/)
- [Dench blog — CRM privacy comparison (local-first CRM)](https://www.dench.com/blog/crm-privacy-comparison)
- [BigIdeasDB — CRM problems from 1000+ users](https://bigideasdb.com/problems/crm-problems)
- [How founders build powerful networks — ContactBook](https://www.contactbook.app/blog/how-founders-build-powerful-networks-without-losing-track)

---

*Research window: ~90 min, 2026-04-20. Every non-trivial claim linked. Where a product's status is ambiguous (Dossy pricing, Mogul tier detail), marked unverified or noted as "undisclosed." No invented data.*
