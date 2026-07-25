# Aegis — UX, Visual Design & Ergonomics Improvement Plan

Grounded in a review of `src/routes/index.tsx` (the 1,488-line dashboard), `app-header.tsx`, `mobile-tab-bar.tsx`, `styles.css`, and the wider component library (backtest cards, live-trading card, news reel, decision breakdown, coach marks, help drawer, notifications, etc.).

The plan is deliberately staged: earlier phases pay off on every screen, later phases add polish and delight. Each phase is behaviour-preserving unless flagged.

---

## Findings at a glance

1. **The design system is under-used.** `styles.css` defines a rich oklch dark palette, but many components hard-code `text-emerald-400`, `bg-cyan-500/15`, `border-red-400`, `text-primary` on brand elements, etc. Tone is inconsistent between cards.
2. **The home dashboard is a single 1,488-line component** rendering: header, mode-summary strip, controls row, snapshot mismatch alert, "new here" banner, all-portfolios chart, news reel, decision breakdown, portfolio list, create-portfolio card. There is no visible hierarchy — every section screams for attention.
3. **Information density is high with weak grouping.** Headings are small (`text-xl`), muted-foreground body is `text-xs` in many places, and control affordances (deposit toggle, decimals `<select>`, range chips) live on cramped one-line strips.
4. **Header + mobile tab bar duplicate destinations.** Admin lives in three places (desktop nav pill, mobile header pill, mobile tab bar). "Broker" appears in the tab bar and header. "Learn" appears in both. There is no persistent "Home".
5. **Ergonomic gaps.** No global search / command palette. No breakpoint-aware sidebar for the dense dashboard. Sparkline range chips are per-card only; there is no dashboard-wide range selector. No compact/comfortable density toggle. Icon-only buttons in some places rely on `title=` only.
6. **Empty, loading and error states are inconsistent.** `PortfolioRow` recently got a proper skeleton/error contract (good) but other cards (news reel, decision breakdown, all-portfolios chart) fall back to blank divs.
7. **Typography is a single sans stack.** No display face for headline numbers; big money values compete with body copy at the same weight/family.
8. **Mobile: primary CTAs are scattered.** Bottom tab bar is 5 items, but the primary action ("New portfolio") is a scroll-anchor. Header is heavy (safe-area, brand, tagline, help, notifications, admin pill, hamburger) — leaves little air on iPhone widths.
9. **Accessibility.** Several icon-only interactive elements use `title` not `aria-label`; the "Include deposits" strip uses a native `<select>` for decimals with focus outline disabled; hard-coded `text-emerald-400`/`text-red-400` bypass theming and hurt contrast when re-themed.
10. **Motion & feedback.** Skeleton shimmer exists (recently added) but is not applied to all loading surfaces; there are no subtle transitions when values update, no toast style variants tied to semantics.

---

## Phase 1 — Design language & tokens (foundation)

Goal: one visual voice, tokenised. Every later phase depends on this.

- Extend `src/styles.css` with **semantic status tokens**: `--success`, `--success-foreground`, `--warning`, `--warning-foreground`, `--info`, `--info-foreground`, plus soft variants (`--success-soft`, etc.) registered in `@theme inline`. Retire ad-hoc `emerald-400`/`red-400`/`cyan-500` usage.
- Add **surface tiers**: `--surface-1` (page bg), `--surface-2` (card), `--surface-3` (raised/hover), `--surface-sunken` (input/muted panels). Cards currently all sit on the same `--card` colour, killing hierarchy.
- Add **typography scale** tokens: `--font-display` (a tighter display face for numeric headlines, e.g. Space Grotesk or Inter Display) plus `--font-sans` for body, wired through a `<link>` in `src/routes/__root.tsx` (never `@import` in CSS per Tailwind v4 rules).
- Add **numeric utility**: `@utility num` → `font-variant-numeric: tabular-nums; font-feature-settings: "cv11","ss01"`. Apply on all money/percentage renderings.
- Add **elevation & radius scale**: `--shadow-card`, `--shadow-card-hover`, `--shadow-popover`; standardise radii on `rounded-xl` for cards and `rounded-md` for chips.
- Publish a short **component recipe file** (`src/styles/recipes.css`) with `@utility` classes for `tile-metric`, `chip-status`, `data-row`, `card-section-header` so ad-hoc styling stops proliferating.

Deliverable: no behaviour change; a codemod PR that replaces hard-coded status colours with tokens.

## Phase 2 — Information architecture & navigation

Goal: the user always knows where they are and how to get to the three things they do most (open a portfolio, review today, run/inspect trades).

- Reorganise the header to a **two-tier layout**:
  - Row 1 (brand): logo · optional environment badge · global search input · notifications · help · account menu.
  - Row 2 (context nav): route-aware breadcrumb + secondary actions (e.g. on `/` shows "Add portfolio", on `/portfolio/:id` shows "Backtest / Report / Optimizer").
- De-duplicate destinations: Admin becomes an item in the account menu (not a permanently visible pill) unless the route is `/admin*`.
- Redesign the **mobile tab bar** around user tasks, not routes: `Home`, `Trades`, `News/Decisions`, `Learn`, `More`. Reserve one slot for a floating primary action ("+ New") that swaps to "Run" on a portfolio detail page.
- Introduce a **command palette** (`Cmd/Ctrl-K`) with actions: jump to portfolio by name, "Run backtest", "Open trades today", "Reconnect broker", "Toggle include deposits", "Toggle real/sim view". Uses shadcn `<Command>`.
- Persistent **UK-time clock + next-run countdown** in the header (currently buried in the summary strip).

## Phase 3 — Dashboard redesign (`/`)

Goal: turn the wall-of-cards into a scan-first dashboard where the answer to "how am I doing today?" is above the fold.

- Split the 1,488-line `index.tsx` into: `DashboardShell`, `TodayHeader`, `EquityOverviewChart`, `PortfolioList`, `SidePanel` (news + decisions), `CreatePortfolioCard`. Each in `src/components/home/`.
- **Hero "Today" band**: one full-width band showing combined equity (large, display font), delta vs yesterday, sparkline, and a live "Next run in mm:ss" chip. Sim vs Real appears as two segmented pills with equity underneath — replaces the current 3-tile strip.
- **Range selector at dashboard level** (`1D / 1W / 1M / 3M / 1Y / All`) that drives every sparkline and the overview chart in unison. Per-card overrides remain but default to the global range.
- **PortfolioRow redesign**: 3-column grid on desktop (identity + status | sparkline + range delta | equity + actions), collapsing to a stacked mobile layout. Money uses the new display font at `text-3xl`; % pill uses status tokens; last-run and risk metadata become chips, not a long comma-separated line.
- Move controls (`Include deposits`, `Decimals`, density toggle) into a **Settings popover** on the dashboard header, not an inline strip.
- Introduce **section headers with icons and short one-line explanations** for News, Decisions, All-portfolios chart so the page reads like a briefing.
- Add a **"Focus mode"**: hide news/decisions panels for a numbers-only view (persisted per user).

## Phase 4 — Cards & data density polish

Goal: every card looks like part of the same product.

- Adopt a standard `<SectionCard>` primitive: header (title + tooltip + trailing action), body, footer (updated-at + refresh). Apply to backtest results, live holdings, live trading, correlation heatmap, regime, decision-news breakdown, risk controls, execution calibration, signal decay, learning panels, security cards.
- Standardise **loading states**: shimmer skeleton matching final shape (already done for the equity headline — extend to chart, list rows, and tiles).
- Standardise **empty states**: illustration slot + one-line description + primary action. E.g. "No trades today — the AI will re-evaluate at 15:00 BST" with a "Run now" button where applicable.
- Standardise **error states**: destructive-tinted banner inside the card with a `Retry` button (mirrors the current PortfolioRow error contract).
- Tables (`/trades`, portfolio detail): sticky header, zebra rows via `bg-muted/40`, right-aligned numeric columns with `num` utility, column-level filter chips, CSV export.
- Charts: unify axis colours, gridline opacity, tooltip surface (`bg-popover` + `shadow-popover`), and a shared legend component.

## Phase 5 — Ergonomics, accessibility & motion

Goal: the app feels considerate.

- Replace every icon-only `<button>`/`<Link>` currently relying on `title=` with `aria-label`. Audit list: sparkline range chips, close-banner button, decimals `<select>` (swap to shadcn `<Select>`), mobile admin pill, header hamburger.
- Ensure every interactive element hits **44×44 min tap target** on mobile; the sparkline range chips and mode-summary chip currently sit around 28px tall.
- Add **skip-to-content** link, single `<main>` per route (already close), proper `<h1>` on every route.
- **Keyboard shortcuts**: `g h` home, `g t` trades, `g c` compare, `n` new portfolio, `/` focus search, `?` open shortcut help.
- **Motion**: use `prefers-reduced-motion` guarded fades on value changes (e.g. equity headline tweens between old→new). Standardise `duration-200 ease-out` for hovers, `duration-300` for enter, no bounce.
- **Toasts**: theme by intent — success/warning/destructive tokens; group broker/AI/system toasts under distinct titles.
- **Help drawer**: pin a "What am I looking at?" affordance next to every complex chart, opening pre-scrolled content in the drawer.

## Phase 6 — Cross-device & responsive refinement

Goal: the desktop feels spacious, the phone feels native.

- Introduce an **optional persistent left sidebar** on `≥ xl` breakpoints with primary nav + recent portfolios, freeing the top for context actions. Collapses to icon-rail at `lg`.
- Bottom tab bar becomes a **frosted rounded pill** floating above the safe area with 4 tabs + a raised centre "+" (primary action).
- Add **density modes** (`comfortable` default, `compact`) that swap padding tokens and row heights, persisted per user.
- **Tablet-specific layout**: two-column dashboard (portfolio list + side panel), no bottom bar at `md`+.
- Add a **first-run onboarding sheet** that walks brand-new users through: create portfolio → risk profile → connect broker (optional) → first backtest. Replaces the current mix of "New here" banner + coach marks + get-started page.

---

## Technical details

- Styling: Tailwind v4 CSS-first (`@theme inline`, `@utility`, `@custom-variant`); tokens live in `src/styles.css`. Fonts loaded via `<link>` in `src/routes/__root.tsx`.
- Components: extend shadcn/Radix primitives — no bespoke widget rebuilds. New primitives: `SectionCard`, `MetricTile`, `StatusPill`, `RangeSelector`, `CommandPalette`, `SettingsPopover`.
- Structure: `src/components/home/*` for the split dashboard; `src/components/patterns/*` for the reusable primitives; no changes to server functions.
- Testing: keep the existing headline/percent-pill invariants (`derive-card-equity`, `portfolio-card-*.e2e`). Add snapshot tests for new `SectionCard` and `MetricTile`. Update existing snapshots when Phase 3 lands.
- Rollout: each phase is a self-contained PR. Phase 1 and 4 are safest; Phase 3 is the biggest visual change and should ship behind no flag but with a rollback plan (git revert of `src/routes/index.tsx` and `src/components/home/*`).

---

## Suggested order & rough sizing

```text
Phase 1  Tokens & type scale         ~1 day   foundation, low risk
Phase 2  Nav & command palette       ~2 days  visible everywhere
Phase 3  Dashboard redesign          ~3 days  highest-impact
Phase 4  Card & table polish         ~2 days  cross-cutting
Phase 5  A11y / motion / shortcuts   ~1 day   quality bar
Phase 6  Responsive & density        ~2 days  finish
```

Recommend starting with **Phase 1 + Phase 2** in parallel: they unblock every later phase and change no business logic. Confirm and I'll begin.
