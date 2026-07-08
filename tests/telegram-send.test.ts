// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Integration tests for sendTelegram via a mocked `node:https`.
 *
 * These verify the retry WIRING (settings -> maxRetries, retries=false, abort,
 * HTML->plain fallback) by stubbing the transport that telegramCall uses, so the
 * full sendTelegram -> retryTelegramSend -> telegramCall -> https path is exercised.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpsRequest } = vi.hoisted(() => ({ httpsRequest: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: httpsRequest } }));

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Import AFTER vi.mock so the module picks up the mocked https.
import { sendTelegram } from "../src/telegram.js";

const BASE_SETTINGS = {
  "avtc-pi-notifications": {
    telegram: {
      enabled: true,
      token: "123:ABC",
      chatId: 123456,
      maxRetries: 3,
      retryBackoffMs: 1,
      maxRetryIntervalMs: 10,
    },
  },
};

/** A queued response for the mocked transport. */
type QueuedResponse =
  | { body: Record<string, unknown> } // 200 + JSON body
  | { statusCode: "error"; payload: Record<string, unknown> } // non-200, JSON error body
  | { networkError: string }; // request emits "error"

function ctx(): ExtensionContext {
  return { ui: { notify: vi.fn() } } as unknown as ExtensionContext;
}

/** Configure the mocked https.request to respond with the queued items in order. */
function queueResponses(responses: QueuedResponse[]): void {
  let i = 0;
  httpsRequest.mockImplementation((_opts: unknown, callback: (res: EventEmitter) => void) => {
    const item = responses[Math.min(i++, responses.length - 1)];
    const req = new EventEmitter();
    req.write = vi.fn();
    req.end = vi.fn();
    req.destroy = vi.fn();
    // Respond asynchronously so the promise ordering matches real I/O.
    queueMicrotask(() => {
      if ("networkError" in item) {
        req.emit("error", Object.assign(new Error(item.networkError), { code: item.networkError }));
        return;
      }
      const res = new EventEmitter();
      const body = "body" in item ? JSON.stringify(item.body) : JSON.stringify(item.payload);
      callback(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    });
    return req;
  });
}

describe("sendTelegram integration", () => {
  beforeEach(() => {
    httpsRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends successfully on the first attempt (no retry)", async () => {
    queueResponses([{ body: { ok: true, result: { message_id: 1 } } }]);
    await expect(
      sendTelegram({ html: "<b>hi</b>", text: "hi" }, BASE_SETTINGS, ctx(), {
        retries: true,
        signal: null,
      }),
    ).resolves.toBeUndefined();
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx errors then succeeds", async () => {
    // backoff is 1ms so retries are effectively instant; use real timers.
    queueResponses([
      { statusCode: "error", payload: { ok: false, error_code: 500, description: "Internal Server Error" } },
      { statusCode: "error", payload: { ok: false, error_code: 500, description: "Internal Server Error" } },
      { body: { ok: true, result: { message_id: 7 } } },
    ]);
    await sendTelegram({ html: "<b>hi</b>", text: "hi" }, BASE_SETTINGS, ctx(), { retries: true, signal: null });
    expect(httpsRequest).toHaveBeenCalledTimes(3);
  });

  it("retries network/transport errors then succeeds", async () => {
    queueResponses([
      { networkError: "ECONNREFUSED" },
      { networkError: "ETIMEDOUT" },
      { body: { ok: true, result: { message_id: 9 } } },
    ]);
    await sendTelegram({ html: "<b>hi</b>", text: "hi" }, BASE_SETTINGS, ctx(), { retries: true, signal: null });
    expect(httpsRequest).toHaveBeenCalledTimes(3);
  });

  it("makes a single attempt (no retries) when retries=false", async () => {
    queueResponses([
      { statusCode: "error", payload: { ok: false, error_code: 500, description: "Internal Server Error" } },
      // A second response is queued only to detect over-calling; it must not be used.
      { body: { ok: true, result: { message_id: 1 } } },
    ]);
    await expect(
      sendTelegram({ html: "<b>hi</b>", text: "hi" }, BASE_SETTINGS, ctx(), { retries: false, signal: null }),
    ).rejects.toThrow(/Telegram send failed/);
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain text on HTML parse error (400 can't parse entities)", async () => {
    queueResponses([
      {
        statusCode: "error",
        payload: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      },
      { body: { ok: true, result: { message_id: 5 } } },
    ]);
    await sendTelegram({ html: "<bad html", text: "plain fallback" }, BASE_SETTINGS, ctx(), {
      retries: true,
      signal: null,
    });
    // HTML attempt + plain attempt = 2 calls.
    expect(httpsRequest).toHaveBeenCalledTimes(2);
  });

  it("returns silently when aborted (no throw)", async () => {
    const controller = new AbortController();
    controller.abort();
    queueResponses([
      { statusCode: "error", payload: { ok: false, error_code: 500, description: "Internal Server Error" } },
    ]);
    await expect(
      sendTelegram({ html: "<b>hi</b>", text: "hi" }, BASE_SETTINGS, ctx(), {
        retries: true,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("warns and returns when telegram is not configured (token/chatId missing)", async () => {
    const c = ctx();
    await sendTelegram(
      { html: "<b>hi</b>", text: "hi" },
      { "avtc-pi-notifications": { telegram: { enabled: true } } },
      c,
      {
        retries: true,
        signal: null,
      },
    );
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(c.ui.notify).toHaveBeenCalledWith(
      "Telegram config missing (avtc-pi-notifications.telegram.token/chatId)",
      "warning",
    );
  });
});
