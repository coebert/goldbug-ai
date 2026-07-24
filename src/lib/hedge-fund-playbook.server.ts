// Publicly-documented strategies of leading investors and hedge funds,
// distilled into decision priors. Sources: shareholder letters, 13F filings,
// SEC disclosures, published interviews, academic papers, and books.
// Injected into the AI trading agent's system prompt alongside the historical
// playbook so decisions can be sanity-checked against how proven operators
// have historically framed similar setups.
export const HEDGE_FUND_PLAYBOOK = `HEDGE FUND & INVESTOR PLAYBOOK — publicly-documented strategies of successful firms. Treat these as decision priors: when today's setup matches a school's edge, weight its rule higher; when it contradicts, require stronger evidence before overriding.

VALUE / QUALITY-COMPOUNDER SCHOOL:
  - Warren Buffett / Berkshire (letters 1977-2024): buy durable-moat businesses at a fair price; hold indefinitely; concentrate in best ideas; keep large cash reserve for dislocations. Rule of thumb: avoid businesses you can't explain in one paragraph; avoid leverage; be greedy when others are fearful (act on -20%+ drawdowns in quality names, not on hot IPOs).
  - Charlie Munger / Daily Journal: invert — avoid obvious losers first. "It is remarkable how much long-term advantage people like us have gotten by trying to be consistently not stupid."
  - Terry Smith / Fundsmith: only invest in high-return-on-capital businesses (>20% ROCE), don't overpay, do nothing. Ban banks, resources, airlines, utilities — capital-intensive, low-margin businesses.
  - Nick Sleep / Nomad: "scaled economies shared" businesses (Costco, Amazon) — reinvest scale benefits into customers, compounding a moat.
  - Application: on quality large-caps in an uptrend with sound fundamentals, prefer to hold or add on weakness rather than trade around them.

GROWTH / INNOVATION SCHOOL:
  - Philip Fisher (Common Stocks and Uncommon Profits): scuttlebutt research; hold multi-decade compounders through volatility; sell only when the story breaks.
  - Peter Lynch / Fidelity Magellan: invest in what you understand; PEG ratio <1 is attractive; six categories (slow growers, stalwarts, fast growers, cyclicals, turnarounds, asset plays) each need a different discipline.
  - T. Rowe Price / Baillie Gifford: identify structural growth themes early (internet, EVs, biotech, AI) and be willing to underperform for 2-3 years to capture the payoff.
  - Application: give secular-growth themes room; don't cut winners just because they're up — cut them when the underlying growth or moat erodes.

MACRO / GLOBAL-MACRO SCHOOL:
  - George Soros / Quantum: reflexivity — market prices and fundamentals feed back on each other; big asymmetric bets when the feedback loop is obvious (1992 GBP short, 1997 Asian FX). "It's not whether you're right or wrong, but how much money you make when you're right and how much you lose when you're wrong."
  - Stanley Druckenmiller: concentrate when conviction is high; central-bank liquidity is the dominant driver of asset prices over 6-24 months. Follow the Fed.
  - Ray Dalio / Bridgewater: All-Weather / Risk Parity — balance risk (not dollars) across four economic regimes (growth up/down × inflation up/down). No regime should sink the portfolio. Diversify across uncorrelated return streams — the "Holy Grail" of 15-20 truly uncorrelated bets.
  - Paul Tudor Jones: "Losers average losers." Cut losers fast, let winners run. Never risk more than 1% on a single idea. Respect the 200-day moving average.
  - Application: size bets by conviction × liquidity backdrop; when policy is tightening AND price is below 200d SMA, dial down cyclical/growth risk.

TREND / MANAGED-FUTURES / CTA SCHOOL:
  - Renaissance / Medallion (public info only — actual model private): purely quantitative, thousands of small edges, aggressive risk targeting, low correlation to indices. Takeaway: no single trade matters; the ensemble does. Diversify signals.
  - Winton, AHL, Man, DE Shaw, Two Sigma: systematic trend-following on price alone works because trends persist longer than random-walk models predict, especially in commodities and FX. Cut losers via hard stops, add to winners via pyramid entries.
  - Ed Seykota, Richard Dennis (Turtles): "The trend is your friend until it ends." Position sizing is the edge; entry is secondary.
  - Application: if price > 50d > 200d SMA AND momentum (12-1m) positive, bias toward trend continuation; if 200d slope turns negative, trim exposure regardless of narrative.

RISK-ARBITRAGE / EVENT-DRIVEN SCHOOL:
  - Bill Ackman / Pershing Square: concentrated activist bets with catalysts (Chipotle, Canadian Pacific), plus tail hedges (Feb 2020 CDS trade returned $2.6B on $27M premium). Lesson: cheap convex hedges around known event risk.
  - John Paulson (2007-08 subprime CDS): asymmetric payoff when a widely-held consensus is fragile. Focus on the payoff shape, not just probability.
  - Seth Klarman / Baupost: margin-of-safety on distressed debt and special situations; hold cash when nothing is cheap; "risk is what's left over when you think you've thought of everything."
  - Application: around known catalysts (earnings, elections, Fed meetings) prefer defined-risk exposure and consider convex hedges in high-VIX regimes.

SHORT / SKEPTIC SCHOOL:
  - Jim Chanos (Kynikos): forensic shorting of fads, frauds, and unsustainable business models (Enron, Wirecard). Warning signs: aggressive accounting, insider selling, capex > operating cash flow for years, related-party transactions.
  - Muddy Waters, Hindenburg: focus on cash flow vs. reported earnings, channel stuffing, and revenue recognition. Even if you don't short, avoid the names.
  - Application: hard skip on stocks with negative FCF, insider selling, and story-stock narratives — regardless of price action.

FACTOR / QUANT-EQUITY SCHOOL:
  - Fama-French / AQR (Cliff Asness): five factors robustly premia-generating over decades — value, size, momentum, quality, low-volatility. All suffer multi-year drawdowns; diversify across factors and time.
  - Robert Shiller: CAPE > 30 has historically preceded weaker 10-year forward returns. Not a timing tool, but a size-of-risk gauge.
  - Application: at broad-market CAPE >30, size positions smaller and lean into quality + low-vol rather than pure momentum or high-beta.

MULTI-STRATEGY / POD-SHOP SCHOOL:
  - Citadel, Millennium, Point72, Balyasny: dozens of independent portfolio managers, each on tight risk budgets (~5% drawdown stops); strict market-neutral or beta-hedged; alpha from many small edges combined. Lesson: risk management IS the edge; single-PM alpha decays fast without ruthless stops.
  - Application: enforce per-position and per-sector caps; a losing thesis at -5% is a stop-out, not an "add" opportunity, unless the setup has genuinely improved.

CROSS-CUTTING PRINCIPLES (rules that appear in nearly every successful firm):
  1. Position sizing dominates entry timing (Tudor Jones, Turtles, pod shops).
  2. Cash is a position with option value (Buffett, Klarman, Druckenmiller).
  3. Concentrate on best ideas, but diversify sources of risk (Munger, Dalio's "Holy Grail").
  4. Cut losers fast, let winners run; average up, not down, on price confirmation (Livermore, Tudor Jones, Turtles).
  5. Respect the trend and the 200-day SMA — don't fight primary trends (Druckenmiller, CTA firms).
  6. Follow the Fed / global liquidity for 6-24m regime bias (Druckenmiller, macro school).
  7. Avoid leverage; survive to compound (Buffett, Taleb, LTCM cautionary tale).
  8. Be skeptical of stories with aggressive accounting or negative FCF (Chanos).
  9. Prefer convex payoffs around known event risk; buy cheap tail insurance (Ackman, Taleb, Paulson).
  10. Do less. Most trades are noise; the edge comes from a handful of high-conviction ideas held long enough (Buffett, Smith, Munger).

Apply these as PRIORS alongside the historical playbook and the portfolio's own learned lessons. When today's signal aligns with multiple schools' rules, conviction is higher; when it contradicts them all, prefer inaction.`;
