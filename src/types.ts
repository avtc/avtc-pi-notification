// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionHeader } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;

export type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } };

/** Snapshot of ctx-derived values captured at timer setup time.
 *  Timer callbacks use only this — never a possibly-stale ctx. */
export interface SessionSnapshot {
  cwd: string;
  sessionHeader: SessionHeader | null;
  sessionId: string;
  leafId: string | null;
}

/**
 * API exposed via pi.events for inter-extension communication.
 * Extensions that block on user input (ask_user_question, permission dialogs, etc.)
 * call requestAttention() before blocking and cancelAttention() when unblocked.
 */
export interface NotificationApi {
  /**
   * Signal that the agent is blocked waiting for user input.
   * Starts delayed bell and telegram timers. If the cancel function is not called
   * in time and the user is inactive, notifications are sent.
   *
   * @param source - Who is requesting attention (e.g. "ask_user_question", "permission")
   * @param detail - Optional human-readable detail (e.g. tool name, question summary)
   * @returns A cancel function to clear the pending attention request
   */
  requestAttention: (source: string, detail?: string) => () => void;
}
