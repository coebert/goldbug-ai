## Aegis — Usability & Clarity Review

Based on a walkthrough of the dashboard, portfolio detail, compare, get-started, admin, news reel and Saxo flows on both mobile (390px) and desktop, plus a file-size audit (portfolio.$id.tsx is 1,450 lines, news-reel 933, risk-controls 631, compare 819). The app is feature-rich but suffers from information overload, inconsistent hierarchy, tiny mobile tap targets, and jargon that new users can't parse quickly.

Below is a prioritised plan. Each phase ships independently — no phase blocks the next.

---

### Phase 1 — Navigation & global shell (highest leverage)

Goal: make it obvious where you are, what you can do next, and how to get back.

- Consolidate the top nav. Today it's 6 items (Get started, Learn, Compare, Saxo, Reconnect, Admin) with two of them Saxo-related. Merge "Saxo status" and "Reconnect" into a single **Broker** entry with tabs inside; drop "Reconnect" from the top bar. Result: 5 → 4 items, less noise.
- Add a persistent **bottom tab bar on mobile** (Home · News · Compare · Broker · More) so key sections are one tap away instead of behind the hamburger.
- Add a page title + breadcrumb strip under the header on every non-home route ("Portfolios › Aggressive Growth › Attribution"). Currently deep pages have no back affordance except the browser button.
- Show a compact **status pill** in the header: green dot "Live · Saxo connected · Last run 14:02 GMT" or amber "Reconnect required". Replaces having to visit /saxo-status to check.
- Ensure hamburger sheet on mobile includes Sign out, current email, and a link to Settings/Notifications (today Sign out lives at the bottom but Notifications is buried in /admin).

### Phase 2 — Home dashboard clarity

- Give the "New portfolio" CTA a prominent position at the top of the list on mobile (today the card list dominates the fold and CTA is easy to miss).
- Portfolio card: unify the row into three clear zones — **Identity** (name + mode badge + live/offline), **Trend** (sparkline + % change + timeframe), **Actions** (Open, kebab for Rename/Duplicate/Delete). Currently actions are inconsistent per card.
- Add an **empty state** for users with no portfolios that walks straight into `/get-started`.
- Add a small "Today" summary strip above the list: total equity across all portfolios, day P&L, next scheduled run.
- Fix mobile density: minimum 44px tap targets on Open button and timeframe chips; wrap long portfolio names with `truncate` + tooltip.

### Phase 3 — Portfolio detail page (biggest offender)

`portfolio.$id.tsx` is 1,450 lines rendering ~12 cards on one scroll. New users can't tell what matters.

- Split into **tabs**: Overview · Trades · Decisions · Risk · Diagnostics · Reports. Overview keeps equity chart, mode/live badges, today's decision, and next-run info. Everything else moves behind a tab. On mobile this becomes a horizontally scrollable tab strip.
- Move the AI Decision panel + News breakdown to the top of Overview — that's the "why did it do this" moment users care about.
- Collapse advanced diagnostics (execution calibration, shadow variants, signal decay, stress) into a single **Advanced** accordion inside Diagnostics tab, collapsed by default.
- Trade table: add sticky header, column sort, and a mobile card view (each trade becomes a stacked mini-card) instead of horizontal scroll.
- Add an inline **"What does this mean?"** link next to Sharpe, CAGR, Drawdown, ATR, guardrail terms — reuse the existing glossary popover component.

### Phase 4 — Forms, wizards & risk controls ✅ shipped

- Risk controls card is 631 lines with slider + ~15 fields visible at once. Reorganise into: **Simple** (slider + summary) shown by default, **Advanced fields** behind a "Fine-tune" toggle. The change-summary panel stays.
- `/get-started` wizard: add a visible progress bar (Step 2 of 4), make Next/Back buttons full-width and sticky on mobile, and add a "Skip for now" that lands the user on Home with a partly-configured portfolio.
- Number inputs everywhere: pair with unit suffix ("%", "£", "bps") and inline validation copy instead of red border only.
- Confirmations for destructive actions (Delete portfolio, Disconnect Saxo, Switch to Real money) use a typed-confirmation dialog, not just a native `confirm()`.

### Phase 5 — News reel & notifications

- News reel (933 lines) currently mixes filters, sort, translation badges, AI notes, infinite scroll. Move filters into a collapsible drawer on mobile so the reel itself is full-width.
- Group headlines by day with sticky day headers.
- Add an unread indicator on the Notifications bell in the header, opening a popover instead of requiring a trip to `/admin`.

### Phase 6 — Compare page

- Compare (819 lines) has heavy controls above the chart. On mobile the chart is squeezed. Solution: chart first, controls collapse into a bottom sheet triggered by a "Configure" FAB.
- Legend chips should double as show/hide toggles with clear on-state colour; today the isolate behaviour is not discoverable.

### Phase 7 — Visual system polish

- Standardise card padding (currently varies between `p-3`, `p-4`, `p-6`). Adopt `p-4 sm:p-6` everywhere.
- Standardise section headings: single `<h2>` per card, muted-foreground subtitle, consistent icon size (`h-4 w-4`).
- Add `focus-visible` ring to every interactive element (currently inconsistent — accessibility win).
- Replace `h-screen` with `h-dvh` on any full-height layout to fix mobile Safari.
- Loading states: replace bare "Loading…" text with skeleton cards matching the final layout.

### Phase 8 — Onboarding & help

- First-run **coach marks** (dismissible) on Home pointing to New Portfolio, Broker status, News reel.
- A single **Help** entry in the More menu opening a slide-over with: glossary, keyboard shortcuts, "What's happening right now" (last run, next run, live/paper mode), and a link to `/learn`.
- Rename `/learn` content to be beginner-first, with a "5-minute tour" at the top.

---

### Technical notes

- Bottom tab bar: new `src/components/mobile-tab-bar.tsx`, mounted in `__root.tsx` with `md:hidden`, hidden on `/auth`.
- Header status pill: derive from existing Saxo status query + last-run query already used by `/admin`; extract into `useSystemStatus()` hook in `src/hooks/`.
- Portfolio tabs: use existing shadcn `Tabs`, route as search param (`?tab=overview`) so links are shareable and browser back works.
- Trade card mobile view: `hidden md:table` on the table, `md:hidden` stacked list — no new component required.
- Split `portfolio.$id.tsx` into `portfolio.$id/_layout.tsx` + child files per tab to keep bundles manageable.
- Splitting `news-reel.tsx`, `risk-controls-card.tsx`, `compare.tsx` into presentation + logic modules is a prerequisite for tab/drawer refactors; do it as the first commit of each phase.
- All changes are frontend/presentation only — no schema, cron, or trading-engine changes.

### Suggested execution order

1. Phase 1 (nav + mobile tab bar + status pill) — 1 change, immediate clarity win.
2. Phase 3 (portfolio tabs) — biggest complexity reduction.
3. Phase 2 (dashboard polish).
4. Phase 4 (forms & risk).
5. Phases 5, 6, 7, 8 in parallel as smaller passes.

Tell me which phase to start with — or say "do phase 1" and I'll ship it.
