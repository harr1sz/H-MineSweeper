const MAX_SAMPLES_PER_METRIC = 256;

type MetricStore = Record<string, number[]>;
type MetricCountStore = Record<string, number>;

declare global {
  var __HMS_PERF__: MetricStore | undefined;
  var __HMS_PERF_COUNTS__: MetricCountStore | undefined;
}

export function recordMetric(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  const store = globalThis.__HMS_PERF__ ?? {};
  globalThis.__HMS_PERF__ = store;
  const countStore = globalThis.__HMS_PERF_COUNTS__ ?? {};
  globalThis.__HMS_PERF_COUNTS__ = countStore;
  countStore[name] = (countStore[name] ?? 0) + 1;
  const samples = store[name] ?? [];
  samples.push(value);
  if (samples.length > MAX_SAMPLES_PER_METRIC) {
    samples.splice(0, samples.length - MAX_SAMPLES_PER_METRIC);
  }
  store[name] = samples;
}

export function percentile(
  samples: readonly number[],
  quantile: number,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}
