// Attributing a worst case to its causes.
//
// A Monte-Carlo tail number ("p5 return is -4%", "the deepest drawdown is 18%")
// tells you the damage but not the driver. Three separate mechanisms are baked
// into the same simulated path:
//
//   slippage  — you trade, but at a worse price than the mid you modelled
//   fillRate  — you do not get the size you asked for (or get nothing at all)
//   stress    — the correlated regime that makes both of the above worse for
//               every symbol at the same time
//
// They interact: stress is worthless as an explanation on its own, because all
// it does is amplify the other two. So a naive "turn one off and measure" (a
// solo effect) double-counts or under-counts depending on the order you test.
//
// This module runs the full 2^3 ablation lattice with common random numbers and
// splits the total tail damage with Shapley values, which is the unique
// attribution that is (a) exactly additive back to the total, (b) order
// independent, and (c) fair about shared credit for interactions.

export const EXECUTION_CHANNELS = ["slippage", "fillRate", "stress"] as const;
export type ExecutionChannel = (typeof EXECUTION_CHANNELS)[number];

/** Canonical key for a subset of enabled channels; "" is the no-shock baseline. */
export function subsetKey(channels: Iterable<ExecutionChannel>): string {
  const set = new Set(channels);
  return EXECUTION_CHANNELS.filter((c) => set.has(c)).join("+");
}

/** Every subset of `channels`, baseline (empty) first, full set last. */
export function channelSubsets(
  channels: readonly ExecutionChannel[] = EXECUTION_CHANNELS,
): ExecutionChannel[][] {
  const out: ExecutionChannel[][] = [];
  for (let mask = 0; mask < 1 << channels.length; mask++) {
    const subset = channels.filter((_, i) => (mask >> i) & 1);
    out.push(subset);
  }
  return out.sort((a, b) => a.length - b.length);
}

export type ChannelAttribution = {
  channel: ExecutionChannel;
  /** Shapley share of the total effect, in the metric's own units. */
  shapley: number;
  /** Share of the total, as a signed fraction (may exceed 1 if channels offset). */
  share: number;
  /** v({channel}) − v(∅): the damage this channel does entirely on its own. */
  solo: number;
  /** v(N) − v(N∖{channel}): the damage it adds last, on top of everything else. */
  marginal: number;
};

export type AttributionResult = {
  /** Metric with no shocks at all. */
  baseline: number;
  /** Metric with every channel enabled. */
  full: number;
  /** full − baseline: the whole effect being split. */
  total: number;
  contributions: ChannelAttribution[];
  /**
   * total − Σ solo effects. Positive-magnitude values mean the channels
   * amplify each other (the joint tail is worse than the sum of its parts).
   */
  interaction: number;
};

const factorial = (n: number): number => {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
};

/**
 * Shapley decomposition of `valueOf(full) − valueOf(baseline)`.
 *
 * `valueOf` receives a subset of enabled channels and must return the metric
 * for a simulation where only those channels are live — evaluated on the same
 * seeds, so differences are causal rather than sampling noise.
 */
export function shapleyAttribution(
  valueOf: (subset: readonly ExecutionChannel[], key: string) => number,
  channels: readonly ExecutionChannel[] = EXECUTION_CHANNELS,
): AttributionResult {
  const values = new Map<string, number>();
  for (const subset of channelSubsets(channels)) {
    const key = subsetKey(subset);
    values.set(key, valueOf(subset, key));
  }
  const v = (subset: readonly ExecutionChannel[]) => values.get(subsetKey(subset)) ?? NaN;

  const n = channels.length;
  const baseline = v([]);
  const full = v(channels);
  const total = full - baseline;

  const contributions = channels.map((channel) => {
    const others = channels.filter((c) => c !== channel);
    let shapley = 0;
    for (const subset of channelSubsets(others)) {
      const weight = (factorial(subset.length) * factorial(n - subset.length - 1)) / factorial(n);
      shapley += weight * (v([...subset, channel]) - v(subset));
    }
    return {
      channel,
      shapley,
      share: total === 0 ? 0 : shapley / total,
      solo: v([channel]) - baseline,
      marginal: full - v(others),
    };
  });

  const soloSum = contributions.reduce((a, c) => a + c.solo, 0);
  return { baseline, full, total, contributions, interaction: total - soloSum };
}
