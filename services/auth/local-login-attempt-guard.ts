/**
 * OFFLINE-ONLY bounded guard for future local-demo password verification.
 * No HTTP integration, identity lookup, filesystem access, or token issuance.
 * Not production rate limiting: a deployed application needs trusted client
 * identity, cross-instance limits, and genuine session/token authorization.
 */
export type LocalLoginOutcome = "verified" | "invalid" | "rate_limited" | "busy";

export interface LocalLoginGuardOptions {
  maxAttemptsPerWindow?: number;
  windowMs?: number;
  maxConcurrent?: number;
  maxTrackedKeys?: number;
  /** Injectable clock enables deterministic tests without sleeping. */
  now?: () => number;
}

interface AttemptWindow {
  count: number;
  expiresAt: number;
}

export class LocalLoginAttemptGuard {
  private readonly attempts = new Map<string, AttemptWindow>();
  private inFlight = 0;
  private readonly maxAttemptsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(options: LocalLoginGuardOptions = {}) {
    const maxAttemptsPerWindow = options.maxAttemptsPerWindow ?? 5;
    const windowMs = options.windowMs ?? 60_000;
    const maxConcurrent = options.maxConcurrent ?? 2;
    const maxTrackedKeys = options.maxTrackedKeys ?? 1024;
    for (const value of [maxAttemptsPerWindow, windowMs, maxConcurrent, maxTrackedKeys]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError("Guard limits must be positive safe integers");
      }
    }
    this.maxAttemptsPerWindow = maxAttemptsPerWindow;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.maxTrackedKeys = maxTrackedKeys;
    this.now = options.now ?? Date.now;
  }

  /**
   * key MUST be derived by a trusted caller (e.g., verified client address).
   * Never accept a user-controlled request body field as the only limit key.
   * Every permitted attempt consumes one slot, successful or not.
   */
  async run(key: string, verify: () => Promise<boolean>): Promise<LocalLoginOutcome> {
    if (typeof key !== "string" || key.length < 1 || key.length > 256 ||
        typeof verify !== "function") return "rate_limited";
    const currentTime = this.now();
    if (!Number.isFinite(currentTime)) return "busy";

    // Reclaim expired entries on access; never keep unbounded identifiers.
    for (const [oldKey, window] of this.attempts) {
      if (window.expiresAt <= currentTime) this.attempts.delete(oldKey);
    }
    const window = this.attempts.get(key);
    if (window && window.count >= this.maxAttemptsPerWindow) return "rate_limited";
    if (this.inFlight >= this.maxConcurrent) return "busy";
    if (!window && this.attempts.size >= this.maxTrackedKeys) return "busy";

    if (window) window.count++;
    else this.attempts.set(key, { count: 1, expiresAt: currentTime + this.windowMs });
    this.inFlight++;
    try {
      return await verify() ? "verified" : "invalid";
    } catch {
      // A thrown verifier or crypto error must never authenticate someone.
      return "invalid";
    } finally {
      this.inFlight--;
    }
  }
}
