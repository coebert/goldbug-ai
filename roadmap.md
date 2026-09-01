# Roadmap

- [x] FX risk dashboard page (rate history + decision log + backtest + stress test + cash-at-risk summary)
- [x] FX playbook backtest sized in real portfolio cash and leverage (money P&L, not just %)
- [ ] Currency selector on the FX risk dashboard (per-pair history, backtest, stress test)
- [ ] Per-leg rows on the FX risk dashboard (entry rate, unrealised P&L, own stress worst case)
- [ ] Verify admin/broker health page returns real live_broker_log rows (not timeout fallback)
- [x] Portfolio summary page (real cash, open legs, unrealised P&L, FX risk) matching My Portfolio
- [x] FX leverage ladder card (1x/2x/3x real cash)
- [x] Live-cash report claimed a SPY buy that never routed (audit outcome fixed) + stuck VMID.L sell reconciliation (sell-side position fallback)
- [x] Live FX risk alert on the Summary tab: red banner + close suggestion when a leg's stress worst case crosses a threshold
- [x] Close-leg button on the FX risk dashboard (live rate, fees shown, Summary refreshes automatically)
- [ ] Confirm stuck VMID.L sell is reconciled (equity order, not an FX leg — FX close button does not apply)
- [ ] Project monitoring: leverage ladder 3x overstatement, bare-pair Yahoo 404s, FX pair selector empty cards
- [ ] FX risk history chart on the Summary tab (per-leg stress + P&L over time, not a single snapshot)
- [ ] Auto-close FX legs that breach the loss budget (no click) + surface the close in the order status card
