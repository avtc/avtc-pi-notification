// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import https from "node:https";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EMPTY_SETTING_FALLBACK, getSetting, isPlainObject } from "./settings.js";
import type { JsonObject, TelegramResponse } from "./types.js";

/** Default: Telegram notifications disabled (opt-in) */
const TELEGRAM_ENABLED_DEFAULT = false;
/** Default: force IPv4 for Telegram HTTP calls */
const FORCE_IPV4_DEFAULT = true;
/** Default: max retry attempts on transient Telegram errors */
const MAX_RETRIES_DEFAULT = 3;
/** Default: base backoff delay (ms) for exponential retry */
const RETRY_BACKOFF_MS_DEFAULT = 10_000;
/** Default: upper bound (ms) on exponential backoff between retries */
const MAX_RETRY_INTERVAL_MS_DEFAULT = 180_000;

export function coerceChatId(chatId: unknown): string | number | undefined {
  if (typeof chatId === "number") return chatId;
  if (typeof chatId === "string") {
    const trimmed = chatId.trim();
    if (!trimmed) return undefined;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
    return trimmed;
  }
  return undefined;
}

export function maskToken(token: string): string {
  if (!token) return "(missing)";
  if (token.length <= 10) return "(present)";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const networkError = error as Error & { code?: string; cause?: { code?: string } };
  const code = networkError.code || networkError.cause?.code;
  return code ? `${error.message} (${code})` : error.message;
}

/**
 * Whether a Telegram response is a transient failure worth retrying:
 *   - 429 Too Many Requests (Telegram supplies retry_after)
 *   - 5xx server errors
 *   - transport failures (network/timeout), surfaced with no error_code
 * Client errors (400/401/403/404) are permanent and not retried.
 */
export function isRetryableError(result: TelegramResponse<unknown>): boolean {
  if (result.ok) return false;
  if (result.error_code === 429) return true;
  if (result.error_code !== undefined && result.error_code >= 500) return true;
  // Transport failures (network/timeout) resolve with no error_code and a "Network error: " prefix.
  if (result.description?.startsWith("Network error:")) return true;
  return false;
}

/**
 * Delay (ms) before the next retry. Exponential backoff (base × 2^attempt),
 * capped by maxRetryIntervalMs. Telegram's retry_after (429) is honored as a
 * floor so retries don't re-trigger rate limits.
 */
export function computeRetryDelayMs(
  result: TelegramResponse<unknown>,
  attempt: number,
  retryBackoffMs: number,
  maxRetryIntervalMs: number,
): number {
  const backoffMs = retryBackoffMs * 2 ** attempt;
  const cappedBackoff = Math.min(maxRetryIntervalMs, backoffMs);
  const retryAfterMs =
    !result.ok && result.parameters?.retry_after !== undefined ? result.parameters.retry_after * 1000 : 0;
  return Math.max(retryAfterMs, cappedBackoff);
}

/** Read a non-negative finite number, falling back when missing or invalid. */
function readNonNegativeNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Read and validate the Telegram retry settings, applying defaults for invalid values. */
export function readRetryConfig(settings: JsonObject): {
  maxRetries: number;
  retryBackoffMs: number;
  maxRetryIntervalMs: number;
} {
  const maxRetriesRaw = getSetting(settings, "avtc-pi-notifications.telegram.maxRetries", MAX_RETRIES_DEFAULT);
  const retryBackoffMsRaw = getSetting(
    settings,
    "avtc-pi-notifications.telegram.retryBackoffMs",
    RETRY_BACKOFF_MS_DEFAULT,
  );
  const maxRetryIntervalMsRaw = getSetting(
    settings,
    "avtc-pi-notifications.telegram.maxRetryIntervalMs",
    MAX_RETRY_INTERVAL_MS_DEFAULT,
  );
  const maxRetries = Math.floor(readNonNegativeNumber(maxRetriesRaw, MAX_RETRIES_DEFAULT));
  const retryBackoffMs = readNonNegativeNumber(retryBackoffMsRaw, RETRY_BACKOFF_MS_DEFAULT);
  const maxRetryIntervalMs = readNonNegativeNumber(maxRetryIntervalMsRaw, MAX_RETRY_INTERVAL_MS_DEFAULT);
  return { maxRetries, retryBackoffMs, maxRetryIntervalMs };
}

/** Max retries used when retries are disabled (single attempt, no backoff). */
const NO_RETRIES = 0;

/**
 * Sleep that resolves early if the signal aborts, so the retry loop can stop
 * promptly on shutdown instead of blocking for the full delay.
 */
export function abortableSleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * Call a Telegram endpoint, retrying transient failures with exponential backoff.
 * caller and sleep are injected so this is unit-testable without network or real timers.
 * Aborts early when the signal fires (shutdown): no further attempts are made and the
 * last result is returned with aborted=true.
 * Returns { result, attempts } where attempts is the number of calls made (1 = no retry).
 */
export async function retryTelegramSend<T>(args: {
  caller: () => Promise<TelegramResponse<T>>;
  maxRetries: number;
  retryBackoffMs: number;
  maxRetryIntervalMs: number;
  sleep: (ms: number, signal: AbortSignal | null) => Promise<void>;
  signal?: AbortSignal | null;
}): Promise<{ result: TelegramResponse<T>; attempts: number; aborted: boolean }> {
  const signal = args.signal ?? null;
  let result = await args.caller();
  let attempts = 1;
  for (let attempt = 0; attempt < args.maxRetries && !signal?.aborted; attempt++) {
    if (result.ok || !isRetryableError(result)) break;
    const delayMs = computeRetryDelayMs(result, attempt, args.retryBackoffMs, args.maxRetryIntervalMs);
    await args.sleep(delayMs, signal);
    if (signal?.aborted) break;
    result = await args.caller();
    attempts++;
  }
  return { result, attempts, aborted: signal?.aborted === true && !result.ok };
}

export async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  family?: 4 | 6;
}): Promise<TelegramResponse<T>> {
  const data = JSON.stringify(options.body);

  return await new Promise<TelegramResponse<T>>((resolve) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.telegram.org",
        method: "POST",
        path: `/bot${options.token}/${options.method}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: options.timeoutMs,
        family: options.family,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            const parsed = JSON.parse(text) as unknown;
            if (isPlainObject(parsed) && typeof parsed.ok === "boolean") {
              resolve(parsed as TelegramResponse<T>);
              return;
            }
            resolve({ ok: false, description: text.slice(0, 500) });
          } catch {
            resolve({ ok: false, description: text.slice(0, 500) });
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", (error) => {
      resolve({ ok: false, description: `Network error: ${formatNetworkError(error)}` });
    });

    req.write(data);
    req.end();
  });
}

export async function sendTelegram(
  payload: { html: string; text: string },
  settings: JsonObject,
  ctx: ExtensionContext | null,
  options: { retries: boolean; signal: AbortSignal | null },
): Promise<void> {
  const enableTelegram = getSetting(settings, "avtc-pi-notifications.telegram.enabled", TELEGRAM_ENABLED_DEFAULT);
  if (!enableTelegram) return;

  const tokenFromSettings = String(
    getSetting(settings, "avtc-pi-notifications.telegram.token", EMPTY_SETTING_FALLBACK),
  ).trim();
  const telegramToken = tokenFromSettings || process.env.TELEGRAM_BOT_TOKEN || process.env.PI_TELEGRAM_TOKEN || "";

  const chatIdFromSettings = getSetting(settings, "avtc-pi-notifications.telegram.chatId", EMPTY_SETTING_FALLBACK);
  const telegramChatId =
    coerceChatId(chatIdFromSettings) ??
    coerceChatId(process.env.TELEGRAM_CHAT_ID) ??
    coerceChatId(process.env.PI_TELEGRAM_CHAT_ID);

  const timeoutMsRaw = getSetting(settings, "avtc-pi-notifications.telegram.timeoutMs", 5000);
  const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 5000;

  const forceIpv4 = getSetting(settings, "avtc-pi-notifications.telegram.forceIpv4", FORCE_IPV4_DEFAULT);
  const retryBase = readRetryConfig(settings);
  // Manual sends (/notify) use a single attempt so the command stays responsive.
  const maxRetries = options.retries ? retryBase.maxRetries : NO_RETRIES;
  const retryBackoffMs = retryBase.retryBackoffMs;
  const maxRetryIntervalMs = retryBase.maxRetryIntervalMs;

  if (!telegramToken || telegramChatId === undefined) {
    ctx?.ui.notify("Telegram config missing (avtc-pi-notifications.telegram.token/chatId)", "warning");
    return;
  }

  const {
    result: htmlResult,
    attempts: htmlAttempts,
    aborted: htmlAborted,
  } = await retryTelegramSend<{ message_id: number }>({
    caller: () =>
      telegramCall<{ message_id: number }>({
        token: telegramToken,
        method: "sendMessage",
        body: {
          chat_id: telegramChatId,
          text: payload.html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
        timeoutMs,
        family: forceIpv4 ? 4 : undefined,
      }),
    maxRetries,
    retryBackoffMs,
    maxRetryIntervalMs,
    sleep: abortableSleep,
    signal: options.signal,
  });

  // Aborted (shutdown): stop silently — don't throw or notify.
  if (htmlAborted) return;
  if (htmlResult.ok) return;

  const htmlDesc = htmlResult.description || "Unknown Telegram error";
  const htmlCode = htmlResult.error_code ? ` (code ${htmlResult.error_code})` : "";

  // If HTML parsing fails, fall back to plain text so notifications still get delivered.
  if (htmlResult.error_code === 400 && htmlDesc.includes("can't parse entities")) {
    const {
      result: plainResult,
      attempts: plainAttempts,
      aborted: plainAborted,
    } = await retryTelegramSend<{ message_id: number }>({
      caller: () =>
        telegramCall<{ message_id: number }>({
          token: telegramToken,
          method: "sendMessage",
          body: {
            chat_id: telegramChatId,
            text: payload.text,
            disable_web_page_preview: true,
          },
          timeoutMs,
          family: forceIpv4 ? 4 : undefined,
        }),
      maxRetries,
      retryBackoffMs,
      maxRetryIntervalMs,
      sleep: abortableSleep,
      signal: options.signal,
    });

    // Aborted (shutdown): stop silently.
    if (plainAborted) return;
    if (plainResult.ok) return;

    const plainDesc = plainResult.description || "Unknown Telegram error";
    const plainCode = plainResult.error_code ? ` (code ${plainResult.error_code})` : "";
    throw new Error(
      `Telegram send failed (HTML parse error fallback): ${htmlDesc}${htmlCode}; plain: ${plainDesc}${plainCode} (after ${plainAttempts} ${plainAttempts === 1 ? "attempt" : "attempts"})`,
    );
  }

  throw new Error(
    `Telegram send failed: ${htmlDesc}${htmlCode} (after ${htmlAttempts} ${htmlAttempts === 1 ? "attempt" : "attempts"})`,
  );
}
