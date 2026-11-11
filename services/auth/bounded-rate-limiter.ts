/**
 * Bounded per-key fixed-window rate limiter with Express middleware helper.
 * Caps total tracked keys to keep memory bounded under distributed key rotation.
 */
import express from "express";

export interface BoundedRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  maxTrackedKeys?: number;
  now?: () => number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_TRACKED_KEYS = 2048;

export class BoundedRateLimiter {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(options: BoundedRateLimiterOptions) {
    const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    for (const value of [options.maxRequests, options.windowMs, maxTrackedKeys]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError("Rate limiter limits must be positive safe integers");
      }
    }
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.maxTrackedKeys = maxTrackedKeys;
    this.now = options.now ?? Date.now;
  }

  get trackedKeyCount(): number {
    return this.buckets.size;
  }

  consume(key: string): RateLimitConsumeResult {
    const fallbackRetryAfter = Math.max(1, Math.ceil(this.windowMs / 1000));
    if (typeof key !== "string" || key.length < 1 || key.length > 256) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSeconds: fallbackRetryAfter,
      };
    }

    const currentTime = this.now();
    if (!Number.isFinite(currentTime)) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSeconds: fallbackRetryAfter,
      };
    }

    for (const [existingKey, bucket] of this.buckets) {
      if (bucket.resetAt <= currentTime) {
        this.buckets.delete(existingKey);
      }
    }

    const existing = this.buckets.get(key);
    if (!existing) {
      if (this.buckets.size >= this.maxTrackedKeys) {
        return {
          allowed: false,
          limit: this.maxRequests,
          remaining: 0,
          retryAfterSeconds: fallbackRetryAfter,
        };
      }
      this.buckets.set(key, {
        count: 1,
        resetAt: currentTime + this.windowMs,
      });
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - 1),
        retryAfterSeconds: 0,
      };
    }

    if (existing.count >= this.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAt - currentTime) / 1000),
      );
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    existing.count++;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - existing.count),
      retryAfterSeconds: 0,
    };
  }
}

export interface RateLimitMiddlewareOptions {
  keyGenerator?: (req: express.Request) => string;
  errorMessage?: string;
}

export function createRateLimitMiddleware(
  limiter: BoundedRateLimiter,
  options: RateLimitMiddlewareOptions = {},
): express.RequestHandler {
  const keyGenerator =
    options.keyGenerator ??
    ((req) => `ip:${req.socket?.remoteAddress || req.ip || "unknown"}`);
  const errorMessage =
    options.errorMessage ?? "Too many requests. Please wait and try again.";

  return (req, res, next) => {
    const outcome = limiter.consume(keyGenerator(req));
    res.setHeader("X-RateLimit-Limit", String(outcome.limit));
    res.setHeader("X-RateLimit-Remaining", String(outcome.remaining));

    if (!outcome.allowed) {
      res.setHeader("Retry-After", String(outcome.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        error: errorMessage,
      });
    }

    return next();
  };
}

