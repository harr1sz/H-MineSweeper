interface Bucket {
  tokens: number;
  lastRefillAt: number;
  lastSeenAt: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
  readonly capacityReached: boolean;
}

export class RestRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #tokensPerMs: number;

  constructor(
    perMinute: number,
    private readonly burst: number,
    private readonly maxBuckets = 50_000,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokensPerMs = perMinute / 60_000;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    const existing = this.#buckets.get(key);
    if (!existing && this.#buckets.size >= this.maxBuckets) {
      this.sweep();
      if (this.#buckets.size >= this.maxBuckets) {
        return {
          allowed: false,
          retryAfterMs: 60_000,
          capacityReached: true,
        };
      }
    }
    const bucket = existing ?? {
      tokens: this.burst,
      lastRefillAt: now,
      lastSeenAt: now,
    };
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + elapsed * this.#tokensPerMs,
    );
    bucket.lastRefillAt = now;
    bucket.lastSeenAt = now;
    this.#buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, capacityReached: false };
    }
    return {
      allowed: false,
      retryAfterMs: Math.max(
        1,
        Math.ceil((1 - bucket.tokens) / this.#tokensPerMs),
      ),
      capacityReached: false,
    };
  }

  sweep(maxIdleMs = 10 * 60_000): void {
    const cutoff = this.now() - maxIdleMs;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.lastSeenAt < cutoff) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
