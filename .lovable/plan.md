# Making Aegis feel like a commercial-grade AI trading product

The engine is far ahead of the interface. There are 32 routes, ~200 components, a 2,300-line portfolio page and a 455-line home page, and the answer to "where do I put this?" has usually been another collapsible grey row. The navigation shell (rail, tab bar, More sheet, Cmd-K palette) already exists and works — the problem now is *inside* the pages: no consistent page template, no consistent card, no consistent chart, and no rule about what appears at each level of detail.

Direction: **modern fintech** — calm surfaces, generous spacing, one big honest number per screen, everything else earned by a click. Desktop and mobile treated as equal first-class layouts. Curated fixed pages, not a pin-your-own dashboard. Full restructure of presentation only; no trading logic, no data fetching, no schema changes.

## What's wrong today

1. **No page grammar.** Every route invents its own header, spacing, back link and section rhythm. Nothing tells you where you are or what this page is for.
2. **Cards are all the same weight.** A £7,800 equity figure and a broker-charge coverage diagnostic look equally important. Nothing draws the eye to what changed.
3. **Detail is binary.** Simple / Standard / Everything plus `AdvancedSection` gives you either a tidy stub or a wall. There is no middle: "show me the summary, let me open the one thing I care about".
4. **Charts don't share a language.** Different heights, axis styles, tooltips, colour choices and legends per chart, so nothing is comparable at a glance.
5. **Two of the biggest surfaces are monoliths.** `portfolio.$id.tsx` (2,303 lines) and `market.$symbol.tsx` (1,204) hold layout, data and formatting in one file; sections can't be reordered or reused.
6. **Alerts have no home.** Halt banners, cost-sync warnings, coverage alerts, mirror alerts and drift notices each render wherever they were written, stacking above content.

## The redesign

### 1. Visual system (foundation for everything else)

- Retune the palette to a low-chroma slate base with a single confident accent, plus the existing semantic success / warning / info / destructive tokens. Keep everything in `src/styles.css` — no hard-coded colours anywhere.
- Numeric type: tabular-lining figures everywhere money appears, so columns line up and digits stop jittering on refresh. Three sizes only: **headline** (the one number that matters), **metric** (card figures), **body**.
- Four surface tiers, used consistently: page, card, raised, sunken. Cards lose their borders in favour of tier contrast — that alone removes most of the visual noise.
- Spacing scale reduced to a 4-step rhythm; every page uses the same column width and gutter at each breakpoint.

### 2. One page template

A single `PageShell` used by all 32 routes: page title, one-line purpose, a right-hand action slot, an optional context strip (portfolio selector, live/sim badge, last run time), then content. Long pages keep the existing sticky section index; sub-pages keep the existing tab strip. Result: every page announces what it is and offers the same controls in the same place.

### 3. Three levels of detail, applied properly

Replace the Simple/Standard/Everything toggle's all-or-nothing behaviour with a per-card rule:

- **Level 1 — the answer.** One sentence and one number. Always visible.
- **Level 2 — the evidence.** The chart or table behind it. Visible at Standard, one tap at Simple.
- **Level 3 — the workings.** Diagnostics, parameters, raw rows. Always behind an explicit "Show workings", remembered per card.

Every card declares its level once; the density setting only changes which level is open by default. Nothing is ever removed, so a page can't hide something you need.

### 4. Information architecture refinements

The five areas stay (Home, Markets, Research, Trades, System) but their contents get sharpened:

```text
Home      one screen: total equity, today's change, what the AI did,
          what it will do next, portfolio cards. Nothing else.
Markets   pulse, trend, per-symbol chart, compare, spillover
Research  scanners, backtests, walk-forward, simulation reports
Trades    orders, fills, explanations, reconciliation, daily report
System    broker status, blocks, hedges, admin, settings
Portfolio Overview | Summary | Trade | Composition | Risk (new, absorbs
          FX risk + concentration + stress) | Attribution | Analytics |
          Optimizer | Reports
```

Two structural changes: **FX risk, concentration and stress merge into one "Risk" tab** rather than being scattered; **the daily AI report becomes the front door to Trades**, since it's the narrative that explains everything else.

Findability gets three additions on top of the existing palette: the Cmd-K palette indexes *cards and charts*, not just pages ("where's the drawdown chart?" jumps straight to it); each page's section index is keyboard-navigable; and every card gets a stable anchor id so links between pages can point at a specific panel.

### 5. Chart system

One `Chart` wrapper: fixed aspect ratios per size class, shared axis/grid/tooltip/crosshair style, shared empty and loading states, a consistent legend that collapses on mobile, and a mobile preset (fewer ticks, no axis titles, larger touch targets) driven from one place instead of per-chart `isMobile` branching. Series colours come only from the Saxo chart tokens already defined.

### 6. Decompose the monoliths

Split `portfolio.$id.tsx` into section components (`overview`, `composition`, `holdings`, `actions`, `risk`, `diagnostics`) under `src/components/portfolio-detail/sections/`, each lazily mounted. Same treatment for `market.$symbol.tsx` and `compare.tsx`. Presentational extraction only — data fetching, valuation and formatting behaviour unchanged, guarded by the existing snapshot and parity tests.

### 7. Alerts inbox

All banner-style warnings (risk halt, cost sync, coverage trend, mirror alert, drift, stale prices, snapshot mismatch) route through one registry rendered as: a single severity-ranked strip under the page header showing only the highest-priority item, plus a bell in the header opening the full list with timestamps and dismiss. Critical trading halts still block the page as they do now.

### 8. States, motion and mobile

- Real skeletons matching the final layout for every card (several exist; make it universal), plus honest empty states that say what to do next, and error states with a retry rather than a blank card.
- Motion budget: 150ms ease-out for state changes, no entrance animations on data, number transitions only when a value actually changes.
- Mobile: every tap target ≥44px, tables become stacked rows below `sm`, sticky action bars for Trade, and the header collapses to title + palette + bell on scroll.

## Technical notes

- New: `src/components/layout/page-shell.tsx`, `card-shell.tsx` (with level prop), `metric.tsx`, `src/components/charts/chart.tsx`, `src/lib/alerts/registry.ts`, `src/components/alerts/alert-strip.tsx`, `src/lib/card-catalog.ts` (feeds the palette's card search).
- Changed: `src/styles.css` tokens; `use-experience-level` gains the level-to-default-open mapping; `advanced-section.tsx` becomes the level-3 "Show workings" primitive; every route adopts `PageShell`.
- Unchanged: all server functions, `src/lib/*.server.ts`, trading engine, migrations, query keys and polling tiers.
- Tests: existing visual snapshots (`home-mobile-layout`, `related-pages-mobile-stacking`, `trading-mode-responsive`, portfolio card snapshots) will be re-baselined deliberately, not blindly. New contract tests for the card-level model, the alert registry ordering, and the chart wrapper's mobile preset. Playwright screenshots at 390 / 834 / 1440 before and after each stage.
- Head metadata reviewed per route as part of the sweep.

## Order of work

1. Visual system + `PageShell` + `CardShell` + `Chart` wrapper (nothing user-visible moves yet, but everything after it gets cheaper)
2. Home reduced to one screen; Markets and Research re-laid out
3. Portfolio detail decomposition + Risk tab consolidation
4. Trades area with the daily report as the front door
5. Alerts inbox
6. Card-level detail model applied across all cards
7. Mobile sweep, states and motion, snapshot re-baseline, screenshot verification

Stages 1–3 give most of the perceived change; each stage ships independently and the app stays working in between.
