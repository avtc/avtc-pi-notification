// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortableSleep,
  coerceChatId,
  computeRetryDelayMs,
  formatNetworkError,
  isRetryableError,
  maskToken,
  readRetryConfig,
  retryTelegramSend,
} from "../src/telegram.js";
import type { TelegramResponse } from "../src/types.js";

describe("coerceChatId", () => {
  it("passes through numbers", () => {
    expect(coerceChatId(123456)).toBe(123456);
  });

  it("converts numeric strings to numbers", () => {
    expect(coerceChatId("123456")).toBe(123456);
  });

  it("keeps non-numeric strings as strings", () => {
    expect(coerceChatId("@channelname")).toBe("@channelname");
    expect(coerceChatId("abc")).toBe("abc");
  });

  it("trims whitespace from string ids", () => {
    expect(coerceChatId("  123  ")).toBe(123);
    expect(coerceChatId("  @chan  ")).toBe("@chan");
  });

  it("returns undefined for empty/whitespace-only strings", () => {
    expect(coerceChatId("")).toBeUndefined();
    expect(coerceChatId("   ")).toBeUndefined();
  });

  it("returns undefined for unsupported types", () => {
    expect(coerceChatId(null)).toBeUndefined();
    expect(coerceChatId(undefined)).toBeUndefined();
    expect(coerceChatId({})).toBeUndefined();
    expect(coerceChatId([])).toBeUndefined();
  });

  it("keeps decimals as numbers (String(Number(x)) round-trips)", () => {
    expect(coerceChatId("1.5")).toBe(1.5);
  });
});

describe("maskToken", () => {
  it("reports missing for empty token", () => {
    expect(maskToken("")).toBe("(missing)");
  });

  it("reports present without leaking short tokens", () => {
    expect(maskToken("short")).toBe("(present)");
    expect(maskToken("1234567890")).toBe("(present)"); // exactly 10 chars
  });

  it("masks long tokens showing first 4 and last 4", () => {
    expect(maskToken("1234567890ABCDEF")).toBe("1234…CDEF");
  });
});

describe("formatNetworkError", () => {
  it("stringifies non-Error values", () => {
    expect(formatNetworkError("oops")).toBe("oops");
    expect(formatNetworkError(42)).toBe("42");
  });

  it("returns the message for a plain Error", () => {
    expect(formatNetworkError(new Error("boom"))).toBe("boom");
  });

  it("appends the error code when present", () => {
    const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(formatNetworkError(err)).toBe("connect failed (ECONNREFUSED)");
  });

  it("appends a nested cause code when present", () => {
    const cause = { code: "ETIMEDOUT" };
    const err = Object.assign(new Error("wrapped"), { cause });
    expect(formatNetworkError(err)).toBe("wrapped (ETIMEDOUT)");
  });
});

describe("isRetryableError", () => {
  it("returns false for a successful response", () => {
    expect(isRetryableError({ ok: true, result: { message_id: 1 } })).toBe(false);
  });

  it("retries 429 Too Many Requests", () => {
    expect(isRetryableError({ ok: false, error_code: 429, description: "Too Many Requests" })).toBe(true);
  });

  it("retries 5xx server errors", () => {
    expect(isRetryableError({ ok: false, error_code: 500, description: "Internal Server Error" })).toBe(true);
    expect(isRetryableError({ ok: false, error_code: 502, description: "Bad Gateway" })).toBe(true);
    expect(isRetryableError({ ok: false, error_code: 503, description: "Service Unavailable" })).toBe(true);
  });

  it("does not retry 4xx client errors", () => {
    expect(isRetryableError({ ok: false, error_code: 400, description: "Bad Request" })).toBe(false);
    expect(isRetryableError({ ok: false, error_code: 401, description: "Unauthorized" })).toBe(false);
    expect(isRetryableError({ ok: false, error_code: 403, description: "Forbidden" })).toBe(false);
    expect(isRetryableError({ ok: false, error_code: 404, description: "Not Found" })).toBe(false);
  });

  it("retries transport failures (network/timeout, no error_code)", () => {
    expect(isRetryableError({ ok: false, description: "Network error: connect ECONNREFUSED" })).toBe(true);
    expect(isRetryableError({ ok: false, description: "Network error: Request timed out" })).toBe(true);
  });

  it("does not retry an unknown error without the network prefix", () => {
    expect(isRetryableError({ ok: false, description: "Something else" })).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  const transient = { ok: false, error_code: 500, description: "Internal Server Error" } as TelegramResponse<unknown>;

  it("grows exponentially with the attempt index", () => {
    expect(computeRetryDelayMs(transient, 0, 1000, 30_000)).toBe(1000);
    expect(computeRetryDelayMs(transient, 1, 1000, 30_000)).toBe(2000);
    expect(computeRetryDelayMs(transient, 2, 1000, 30_000)).toBe(4000);
    expect(computeRetryDelayMs(transient, 3, 1000, 30_000)).toBe(8000);
  });

  it("caps the exponential growth at maxRetryIntervalMs", () => {
    expect(computeRetryDelayMs(transient, 5, 1000, 30_000)).toBe(30_000); // 1000 * 2^5 = 32000 -> capped
    expect(computeRetryDelayMs(transient, 10, 1000, 30_000)).toBe(30_000);
  });

  it("honors Telegram retry_after as a floor above the capped backoff", () => {
    const rateLimited = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 10 },
    } as TelegramResponse<unknown>;
    // backoff at attempt 0 = 1000, but retry_after=10s -> max(10000, 1000) = 10000
    expect(computeRetryDelayMs(rateLimited, 0, 1000, 30_000)).toBe(10_000);
  });

  it("uses the backoff when retry_after is below it", () => {
    const rateLimited = {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 1 },
    } as TelegramResponse<unknown>;
    // backoff at attempt 3 = 8000, retry_after=1s -> max(1000, 8000) = 8000
    expect(computeRetryDelayMs(rateLimited, 3, 1000, 30_000)).toBe(8000);
  });

  it("still caps the backoff even when retry_after is absent", () => {
    expect(computeRetryDelayMs(transient, 8, 500, 4000)).toBe(4000); // 500 * 2^8 = 128000 -> capped
  });
});

describe("retryTelegramSend", () => {
  /** Build a caller that returns queued responses in order, repeating the last when exhausted. */
  function queuedCaller<T>(responses: TelegramResponse<T>[]): () => Promise<TelegramResponse<T>> {
    let i = 0;
    return async () => responses[Math.min(i++, responses.length - 1)];
  }

  /** Sleep that records the requested delays instead of actually waiting. */
  function recordingSleep(record: number[]): (ms: number, signal: AbortSignal | null) => Promise<void> {
    return async (ms) => {
      record.push(ms);
    };
  }

  it("returns immediately on success without sleeping", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([{ ok: true, result: { message_id: 42 } }]);
    const { result, attempts } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries transient errors then succeeds, sleeping with exponential backoff", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 500, description: "Internal Server Error" },
      { ok: false, error_code: 500, description: "Internal Server Error" },
      { ok: true, result: { message_id: 1 } },
    ]);
    const { result, attempts } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("stops retrying a non-retryable 4xx error immediately (no sleep)", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    ]);
    const { result, attempts } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("exhausts retries on persistent transient errors and reports the attempt count", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 500, description: "Internal Server Error" },
    ]);
    const { result, attempts } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(4); // 1 initial + 3 retries
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("makes a single attempt (no retries) when maxRetries is 0", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 500, description: "Internal Server Error" },
    ]);
    const { result, attempts } = await retryTelegramSend({
      caller,
      maxRetries: 0,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("caps the backoff delay between retries", async () => {
    const sleeps: number[] = [];
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 500, description: "Internal Server Error" },
    ]);
    await retryTelegramSend({
      caller,
      maxRetries: 5,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 3000,
      sleep: recordingSleep(sleeps),
    });
    // 6 attempts (1 + 5 retries), 5 sleeps; backoff capped at 3000 from attempt 2 onward.
    expect(sleeps).toEqual([1000, 2000, 3000, 3000, 3000]);
  });

  it("aborts before any retry when the signal is already aborted", async () => {
    const sleeps: number[] = [];
    const controller = new AbortController();
    controller.abort();
    const caller = queuedCaller<{ message_id: number }>([
      { ok: false, error_code: 500, description: "Internal Server Error" },
    ]);
    const { result, attempts, aborted } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
      signal: controller.signal,
    });
    expect(aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("stops retrying once the signal aborts between attempts", async () => {
    const sleeps: number[] = [];
    const controller = new AbortController();
    // First call fails and aborts the signal; no further attempts should follow.
    let calls = 0;
    const caller = async (): Promise<TelegramResponse<{ message_id: number }>> => {
      calls += 1;
      controller.abort();
      return { ok: false, error_code: 500, description: "Internal Server Error" };
    };
    const { result, attempts, aborted } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep(sleeps),
      signal: controller.signal,
    });
    expect(aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("reports aborted=false when the send succeeds", async () => {
    const controller = new AbortController();
    const caller = queuedCaller<{ message_id: number }>([{ ok: true, result: { message_id: 1 } }]);
    const { aborted } = await retryTelegramSend({
      caller,
      maxRetries: 3,
      retryBackoffMs: 1000,
      maxRetryIntervalMs: 30_000,
      sleep: recordingSleep([]),
      signal: controller.signal,
    });
    expect(aborted).toBe(false);
  });
});

describe("readRetryConfig", () => {
  it("applies defaults when settings are missing", () => {
    expect(readRetryConfig({})).toEqual({ maxRetries: 3, retryBackoffMs: 10_000, maxRetryIntervalMs: 180_000 });
  });

  it("reads valid values", () => {
    expect(
      readRetryConfig({
        "avtc-pi-notifications": { telegram: { maxRetries: 5, retryBackoffMs: 500, maxRetryIntervalMs: 10_000 } },
      }),
    ).toEqual({ maxRetries: 5, retryBackoffMs: 500, maxRetryIntervalMs: 10_000 });
  });

  it("falls back on non-number values", () => {
    expect(
      readRetryConfig({
        "avtc-pi-notifications": {
          telegram: { maxRetries: "nope", retryBackoffMs: null, maxRetryIntervalMs: undefined },
        },
      }),
    ).toEqual({ maxRetries: 3, retryBackoffMs: 10_000, maxRetryIntervalMs: 180_000 });
  });

  it("falls back on negative values", () => {
    expect(
      readRetryConfig({
        "avtc-pi-notifications": { telegram: { maxRetries: -1, retryBackoffMs: -5, maxRetryIntervalMs: -1 } },
      }),
    ).toEqual({ maxRetries: 3, retryBackoffMs: 10_000, maxRetryIntervalMs: 180_000 });
  });

  it("floors a fractional maxRetries", () => {
    expect(readRetryConfig({ "avtc-pi-notifications": { telegram: { maxRetries: 2.9 } } }).maxRetries).toBe(2);
  });
});

describe("abortableSleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the delay when not aborted", async () => {
    const controller = new AbortController();
    let resolved = false;
    const p = abortableSleep(1000, controller.signal).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(999);
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    const p = abortableSleep(1000, controller.signal).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(0);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves early when aborted mid-sleep", async () => {
    const controller = new AbortController();
    let resolved = false;
    const p = abortableSleep(10_000, controller.signal).then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(100);
    expect(resolved).toBe(false);
    controller.abort();
    await p;
    expect(resolved).toBe(true);
  });
});
