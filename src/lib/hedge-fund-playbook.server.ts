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

INDEX / LOW-COST PASSIVE SCHOOL — VANGUARD / BOGLE:
  - Jack Bogle / Vanguard (founded 1975; VFINX first retail S&P 500 index fund, 1976; ~$9T AUM today at cost basis): the mathematics of costs. Aggregate active managers must, before fees, earn the market return; after fees they must underearn it by the amount of those fees. Over 15–20 years ~85–90% of active US equity funds lag their benchmark net of fees (SPIVA scorecards). Ergo: minimise costs, minimise turnover, own the market.
  - "Don't look for the needle in the haystack. Just buy the haystack." Cap-weighted broad-market ownership captures the entire upside distribution — the small number of stocks that produce nearly all long-run equity returns (Bessembinder 2018: ~4% of US stocks generated the entire net wealth creation of the market since 1926).
  - Costs compound negatively at the same rate returns compound positively. A 1% annual fee drag over 40 years costs ~28% of terminal wealth; a 2% drag costs ~50%. Every basis point of round-trip cost avoided is a basis point of alpha, guaranteed.
  - Asset allocation drives ~90% of the variance of long-term portfolio returns (Brinson/Hood/Beebower 1986/1991). Get the stock/bond/cash mix right first; security selection is a rounding error against that decision.
  - Three-Fund Portfolio (Vanguard-adjacent orthodoxy — Bogleheads): total US market + total international + total bond, rebalanced annually. Simple, tax-efficient, hard to beat.
  - Behaviour is the biggest tax. Dalbar's QAIB studies show the average equity-fund investor earns ~2–4% less per year than the funds themselves, entirely from mistimed inflows/outflows. Discipline > cleverness.
  - Rebalancing is the only "market timing" that reliably adds value: sell what has appreciated, buy what has lagged, back to policy weights. Do it on a schedule or on ±5% drift bands, not on feelings.
  - "Stay the course." Bear-market selling converts temporary drawdowns into permanent losses. Vanguard's own research: an investor who missed the best 10 days in the S&P 1990–2020 halved their annualised return; most of those best days occur within two weeks of the worst days.
  - Tax-efficiency as alpha: ETF creation/redemption + low turnover keeps realised capital gains near zero. Location matters — bonds in tax-sheltered accounts, equities in taxable.
  - Application to an ACTIVE AI portfolio: use Vanguard's rules as a hard-to-beat BENCHMARK and as guardrails on our own activity —
      • Every proposed trade must pass an implicit cost-hurdle test: expected edge must exceed round-trip cost + spread + tax drag. If it does not, do nothing.
      • Excess turnover is a tax on future returns. Prefer holding to trading; require a positive marginal-information reason to churn.
      • Anchor to a strategic asset allocation (policy weights per risk level). Deviations from policy are TACTICAL BETS that must be sized and time-bounded, not drifting exposures.
      • Rebalance on drift bands, not on narrative; take from what has run, add to what has lagged, within the same asset class.
      • Track live performance vs a low-cost passive benchmark (e.g. 60/40 VT+BND for balanced) net of all costs. If we cannot beat it over rolling 3-year windows, the correct action is to REDUCE active bet size, not increase it.
      • Never abandon the strategic allocation during a drawdown. Panic-selling into weakness is the single biggest destroyer of Bogle-style compound returns; our stops and hedges exist so we do not have to.
      • Prefer broad, cheap, liquid instruments (index ETFs) as the DEFAULT exposure; single-name active bets should earn their place by clearing a higher evidence bar than "seems like a good idea."

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
