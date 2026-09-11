# Global strong-signal trading coverage

## Goal
Ensure every configured market gets a fair chance to surface strong, affordable ideas while its exchange is open, without weakening cash, cost, concentration, or loss controls.

## Changes
- Replace the first-in-list candidate cutoff with a venue-balanced selection so US, UK, continental Europe, Japan, and Australia cannot crowd one another out during overlapping sessions.
- Preserve held positions, inverse-fund priorities, affordability checks, and deterministic ordering.
- Add continental European venues to the execution time-of-day safeguards so their opening and closing windows are handled correctly rather than treated as always available.
- Add regression tests proving balanced coverage and venue classification across all configured market groups.
- Record the completed work in the project roadmap and verify focused tests plus TypeScript.

## Technical details
- Reuse the shared symbol-to-venue classifier to avoid a second regional mapping.
- Allocate the limited AI candidate window round-robin across active venue groups, then fill spare places by existing universe order.
- Do not bypass the net-profit hurdle, available-cash rule, reserve, daily spend limit, per-position/sector limits, broker eligibility, or market-hours gate.
