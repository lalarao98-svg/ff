/* Robust statistics used by the projection engine.
 * Ports of the R functions the original scripts relied on:
 * wilcox.test(conf.int=TRUE)$estimate (Hodges-Lehmann), mad(), scale(). */

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Median absolute deviation with R's default consistency constant 1.4826. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** All pairwise Walsh averages (x_i + x_j)/2 for i <= j, sorted ascending. */
function walshAverages(xs: number[]): number[] {
  const w: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i; j < xs.length; j++) w.push((xs[i] + xs[j]) / 2);
  }
  return w.sort((a, b) => a - b);
}

/** Hodges-Lehmann pseudo-median: median of the Walsh averages. */
export function pseudoMedian(xs: number[]): number {
  if (xs.length === 1) return xs[0];
  return median(walshAverages(xs));
}

/**
 * Tukey confidence interval for the pseudo-median: the k-th smallest and
 * k-th largest Walsh averages. With the 2-4 sources we have per player the
 * achievable interval is the full Walsh-average range (k = 1), which matches
 * what R's wilcox.test(conf.int=TRUE) returns at these sample sizes.
 */
export function pseudoMedianCI(xs: number[]): [number, number] {
  if (xs.length === 1) return [xs[0], xs[0]];
  const w = walshAverages(xs);
  return [w[0], w[w.length - 1]];
}

/** z-scores using the sample mean/sd of the non-null entries (R's scale()). */
export function zScores(xs: (number | null)[]): (number | null)[] {
  const present = xs.filter((x): x is number => x != null);
  if (present.length < 2) return xs.map(() => null);
  const m = mean(present);
  const s = sd(present);
  if (!s) return xs.map(() => null);
  return xs.map((x) => (x == null ? null : (x - m) / s));
}
