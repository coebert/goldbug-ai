// LTTB (Largest-Triangle-Three-Buckets) downsampling.
// Preserves visual shape of a series much better than uniform stride sampling,
// so decades-long equity curves stay readable when reduced to a few hundred
// points before hitting recharts.
//
// Reference: Steinarsson, "Downsampling Time Series for Visual Representation" (2013).

export type Point = { x: number; y: number };

export function lttb<T extends Point>(data: readonly T[], threshold: number): T[] {
  const n = data.length;
  if (threshold >= n || threshold <= 2) return data.slice();

  const sampled: T[] = new Array(threshold);
  const bucketSize = (n - 2) / (threshold - 2);

  let a = 0; // index of previously kept point
  sampled[0] = data[0];

  for (let i = 0; i < threshold - 2; i++) {
    // next-bucket average (used as the third triangle point)
    const nextStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const count = nextEnd - nextStart;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    avgX /= count || 1;
    avgY /= count || 1;

    // current bucket range
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const ax = data[a].x;
    const ay = data[a].y;

    let maxArea = -1;
    let chosen = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (ax - avgX) * (data[j].y - ay) - (ax - data[j].x) * (avgY - ay),
      ) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled[i + 1] = data[chosen];
    a = chosen;
  }
  sampled[threshold - 1] = data[n - 1];
  return sampled;
}
