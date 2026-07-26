// Correlation-aware position sizing (Phase 5).
//
// Rationale: naive "max X% per position" caps miss the real risk when
// several holdings move together (all AI names, all rate-sensitives, all
// oil-linked). Two 8% positions with 0.9 correlation are effectively one
// 16% bet. This module lets the sizer treat correlated holdings as a
// cluster and cap the *cluster's* combined weight, then downscale a
// proposed add so it doesn't breach the cluster cap.
//
// Pure math only. Callers supply return series (aligned, same length).

export type ReturnSeries = Record<string, number[]>; // symbol -> returns

export type CorrelationMatrix = Record<string, Record<string, number>>;

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length ? s / xs.length : 0;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

export function correlationMatrix(series: ReturnSeries): CorrelationMatrix {
  const syms = Object.keys(series);
  const m: CorrelationMatrix = {};
  for (const s of syms) m[s] = {};
  for (let i = 0; i < syms.length; i++) {
    m[syms[i]][syms[i]] = 1;
    for (let j = i + 1; j < syms.length; j++) {
      const c = pearson(series[syms[i]], series[syms[j]]);
      m[syms[i]][syms[j]] = c;
      m[syms[j]][syms[i]] = c;
    }
  }
  return m;
}

// Greedy single-link clustering: any pair with correlation >= threshold
// ends up in the same cluster. Deterministic on symbol order.
export function clusterByCorrelation(
  matrix: CorrelationMatrix,
  threshold: number,
): string[][] {
  const syms = Object.keys(matrix).sort();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const s of syms) parent.set(s, s);
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      if ((matrix[syms[i]][syms[j]] ?? 0) >= threshold) {
        union(syms[i], syms[j]);
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const s of syms) {
    const r = find(s);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(s);
  }
  return Array.from(groups.values()).map((g) => g.sort());
}

export type ClusterSizingInput = {
  currentWeights: Record<string, number>;   // symbol -> fractional weight (0..1)
  proposedSymbol: string;
  proposedWeight: number;                   // fractional weight to add
  clusters: string[][];
  clusterCap: number;                       // max combined fraction per cluster
};

export type ClusterSizingResult = {
  cluster: string[];
  cluster_weight_before: number;
  cluster_weight_after_raw: number;
  allowed_weight: number;      // clipped proposed weight
  scale: number;               // allowed / proposed  (1 == no trim)
  breached_cap: boolean;
  reason: string;
};

export function sizeAgainstClusterCap(i: ClusterSizingInput): ClusterSizingResult {
  const cluster =
    i.clusters.find((c) => c.includes(i.proposedSymbol)) ?? [i.proposedSymbol];
  const before = cluster.reduce((s, sym) => s + (i.currentWeights[sym] ?? 0), 0);
  const rawAfter = before + i.proposedWeight;
  const headroom = Math.max(0, i.clusterCap - before);
  const allowed = Math.min(i.proposedWeight, headroom);
  const scale = i.proposedWeight > 0 ? allowed / i.proposedWeight : 1;
  const breached = rawAfter > i.clusterCap + 1e-9;
  const reason = breached
    ? `cluster [${cluster.join(",")}] would reach ${(rawAfter * 100).toFixed(1)}% vs cap ${(i.clusterCap * 100).toFixed(1)}%`
    : `within cluster cap (${(rawAfter * 100).toFixed(1)}% / ${(i.clusterCap * 100).toFixed(1)}%)`;
  return {
    cluster,
    cluster_weight_before: before,
    cluster_weight_after_raw: rawAfter,
    allowed_weight: allowed,
    scale,
    breached_cap: breached,
    reason,
  };
}
