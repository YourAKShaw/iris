/**
 * In-memory abuse and quota controls for the hosted demo.
 *
 * Scope: a single process. Counters reset on restart and are not shared across instances,
 * which is acceptable for a one-instance free-tier demo. The provider's own 429 remains the backstop.
 */

type Clock = () => number;

export interface LimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Fixed-window counter per key (client IP). Bounded memory: expired keys are pruned. */
export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: Clock;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, now: Clock = Date.now, maxKeys = 50_000) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  hit(key: string): LimitDecision {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      if (!window && this.#windows.size >= this.#maxKeys) {
        this.prune();
        // Fail closed if an attacker floods us with distinct keys.
        if (this.#windows.size >= this.#maxKeys) return { allowed: false, retryAfterSeconds: 60 };
      }
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.#windowMs - now) / 1000)) };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  prune(): void {
    const now = this.#now();
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}

/** A run budget that resets at 00:00 UTC, sized to stay inside the provider's daily token quota. */
export class DailyBudget {
  readonly #limit: number;
  readonly #now: Clock;
  #day = '';
  #used = 0;

  constructor(limit: number, now: Clock = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#used = 0;
    }
  }

  tryConsume(): LimitDecision {
    this.#roll();
    if (this.#used >= this.#limit) return { allowed: false, retryAfterSeconds: this.secondsUntilReset() };
    this.#used += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Returns a unit when a run failed before spending any model tokens. */
  refund(): void {
    this.#roll();
    this.#used = Math.max(0, this.#used - 1);
  }

  remaining(): number {
    this.#roll();
    return Math.max(0, this.#limit - this.#used);
  }

  secondsUntilReset(): number {
    const now = this.#now();
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
  }
}

/** Size-bounded TTL cache (insertion-ordered eviction). */
export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: Clock;
  readonly #entries = new Map<string, { value: V; expires: number }>();

  constructor(ttlMs: number, maxEntries: number, now: Clock = Date.now) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get enabled(): boolean {
    return this.#ttlMs > 0 && this.#maxEntries > 0;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }
}
