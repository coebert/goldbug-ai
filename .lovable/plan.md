# Layout & ergonomics re-optimisation

The app has grown far faster than its navigation. Home is now a single 487-line scroll (hero, next action, market pulse, SMA trend, portfolios, then eight collapsible "Look deeper" panels), the portfolio page is a 2,478-line monolith, and 26 routes are reachable through a bottom bar whose "More" button silently goes to `/compare`. This plan reorganises where things live and how they're reached, without changing any trading logic.

## The core problems

1. **No real navigation map.** Half the routes (`/market/$symbol`, `/spillover`, `/saxo-status`, `/admin`, `/broker-blocks`, `/hedge-fallbacks`, `/simulation-report`, the five `portfolio.$id.*` sub-pages) are only reachable via in-card links you have to already know about.
2. **Home is doing four jobs**: my money, market conditions, research tooling (reclaim scanner, setup backtest), and diagnostics. Research and diagnostics don't belong on the first screen.
3. **"More" is a lie.** The mobile tab bar's More button routes straight to `/compare` instead of opening a destination sheet. The raised "+" spends a prime tap target on portfolio creation — a rare action.
4. **Collapsible sprawl.** `AdvancedSection` stacks are used as the answer to everything, so "Look deeper" is a wall of ten near-identical grey rows with no grouping or memory of what you last opened.
5. **Portfolio detail is unnavigable.** One page, ~2.5k lines, no in-page section index, five sibling report routes with no visible tab strip tying them together.
6. **Two competing density controls** (Simple/Advanced toggle and Focus mode) with overlapping effects and no explanation of how they interact.

## Proposed structure

### Information architecture

Five top-level areas, everything else nests under one of them:

```text
Home      → your money only: hero, next action, portfolios, create
Markets   → market pulse, SMA trend, symbol charts, compare, spillover
Research  → scanners, backtests (setup, batching, cost scenarios, insider replay), walk-forward
Trades    → orders, fills, explanations, reconciliation
System    → Saxo status, broker blocks, hedge fallbacks, admin, settings
```

Home loses Market pulse, SMA trend, the reclaim scanner and the setup backtest; it keeps a single compact "Markets today" strip (3–4 numbers + sparkline) that links into Markets.

### Mobile (primary form factor — you're on a 440px viewport)

- Tab bar becomes **Home / Markets / Trades / Research / More**, all five real tabs. Remove the raised "+"; portfolio creation moves to a header action on Home.
- **More opens a bottom sheet** listing every destination grouped by area, with search — this is the fix for the 26 orphan routes.
- Add a **sticky in-page section index** on long pages (Home, Portfolio detail): a horizontally scrollable chip row that scroll-spies the current section and jumps on tap.
- Standardise card headers: title truncates, action drops below on base breakpoint, per the existing mobile-stacking test contract.
- Charts get a consistent mobile preset (reduced margins, fewer ticks, no axis title) driven by one shared hook rather than per-chart `isMobile` branching.
- All primary actions ≥44px; move destructive/rare actions into overflow menus.

### Desktop

- Introduce a **persistent left rail** (icon + label, collapsible) for the five areas at `lg:`+, replacing header-link hunting. Bottom bar stays mobile-only.
- Home switches to a real bento: hero + next action on row one, portfolios (2/3) beside markets strip and create card (1/3), rather than today's full-width stack.
- **Portfolio detail gets a sticky sub-nav tab strip**: Overview · Holdings · Composition · Attribution · Analytics · Optimizer · Reports · SMA report — unifying the five sibling routes with the in-page sections.
- Widen the content column from `max-w-6xl` to `max-w-7xl` on `2xl:` so the wide tables stop scrolling horizontally on large monitors.

### Density model

Collapse the two controls into one three-position setting: **Simple / Standard / Everything**, persisted, shown once in the header. Focus mode is folded in as "Simple". Each `AdvancedSection` declares which level reveals it, and remembers its own open state per user.

### Portfolio detail decomposition

Split `portfolio.$id.tsx` into section components under `src/components/portfolio-detail/sections/` (overview, holdings, composition, orders, risk, diagnostics), each lazily mounted when its tab/section is reached. This is presentational extraction only — no changes to data fetching or valuation logic.

## Technical notes

- New: `src/components/nav/app-nav.tsx` (shared destination registry), `desktop-rail.tsx`, `more-sheet.tsx`, `section-index.tsx`; `src/lib/use-density.ts` extended to three levels.
- `MobileTabBar` rewritten against the destination registry so tabs and the More sheet can't drift apart.
- Routes: add `/markets` and `/research` index routes that host the cards moved off Home. No route deletions — existing URLs keep working.
- Existing visual-regression suites (`home-mobile-layout.visual`, `related-pages-mobile-stacking.visual`, `trading-mode-responsive.visual`) will need snapshot updates; new contract tests cover the nav registry, More-sheet coverage of every route, and the section index.
- Verification: Playwright screenshots at 375 / 834 / 1440 for Home, Markets, Portfolio detail before and after.

## Suggested order

1. Nav registry + mobile More sheet + real five-tab bar (biggest win, lowest risk)
2. Desktop left rail
3. Home slimming → `/markets`, `/research`
4. Portfolio detail tab strip + section extraction
5. Unified density model
6. Chart mobile preset + card header sweep
7. Snapshot/test refresh and screenshot verification

Steps 1–3 are independently shippable; tell me if you'd rather I do just those first.
