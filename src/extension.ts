// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildTelegramAttentionMessage,
  buildTelegramCompactMessage,
  buildTelegramMessage,
  buildTelegramPlainMessage,
} from "./message.js";
import { EMPTY_SETTING_FALLBACK, getSetting, loadMergedSettings, parseDelayMs } from "./settings.js";
import { coerceChatId, maskToken, readRetryConfig, sendTelegram, telegramCall } from "./telegram.js";
import type { JsonObject, NotificationApi, SessionSnapshot } from "./types.js";

// Idempotent wiring guard. notification can be bundled into the avtc-pi umbrella
// AND installed standalone — whichever copy loads first wires, the rest no-op.
const WIRED_KEY = "__avtcPiNotificationWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/** Default delay before bell fires (ms). Cancelled on keypress. */
const DEFAULT_BELL_DELAY_MS = 30_000;

/** Default delay before Telegram fires (ms). Cancelled on keypress. Independent of bell. */
const DEFAULT_TELEGRAM_DELAY_MS = 120_000;

/** Sentinel: no ExtensionContext available for settings loading */
const NO_EXTENSION_CONTEXT: ExtensionContext | undefined = undefined;

/** Default: bell notifications enabled */
const BELL_DEFAULT_ENABLED = true;
/** Default: Telegram notifications disabled (opt-in) */
const TELEGRAM_ENABLED_DEFAULT = false;
/** Default: force IPv4 for Telegram HTTP calls */
const FORCE_IPV4_DEFAULT = true;

/**
 * Check whether this extension instance is running inside a subagent process.
 * Uses two independent signals (OR logic — either one is sufficient):
 *   ctx.mode !== "tui"   — pi-core signal (RPC children have mode="rpc").
 *   PI_SUBAGENT_PARENT_PID — avtc-pi-subagent env var (set by the parent at spawn).
 */
function isSubagentSession(ctxMode: string): boolean {
  return ctxMode !== "tui" || process.env.PI_SUBAGENT_PARENT_PID !== undefined;
}

export default function (pi: ExtensionAPI) {
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // --- Notification state machine ---
  // Two independent channels (bell, telegram), each with its own delay timer.
  // Both are cancelled when:
  //   - Pi starts an auto-retry (agent_start fires)
  //   - User is at the keyboard (terminal input detected)
  //   - Extension calls cancelAttention() (user responded to the blocking prompt)

  /** Pending bell timer. Shared across all notification sources. */
  let bellTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending telegram timer. Shared across all notification sources. */
  let telegramTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether we already sent an attention notification in this agent loop. */
  let attentionNotified = false;

  /** Stored ctx for sending notifications from timers. */
  let rootCtx: ExtensionContext | null = null;

  /** AbortController for in-flight Telegram retries; aborted on shutdown so the app can exit. */
  let telegramAbort: AbortController | null = null;

  /**
   * Messages + ctx-snapshot captured at agent_end and consumed at agent_settled.
   * `agent_settled` carries no message content (`{ type: "agent_settled" }`), and the
   * bell/Telegram bodies are built from the agent messages — so they must be captured
   * at agent_end (the only event that carries them). Scheduling moves to agent_settled
   * (see below); these hold the last agent_end's payload until then. Each agent_end
   * overwrites, so agent_settled (which fires once per run, after all retries/compaction)
   * always sees the final messages.
   */
  let pendingMessages: unknown[] | null = null;
  let pendingSnapshot: SessionSnapshot | null = null;

  function cancelTimers(): void {
    if (bellTimer) {
      clearTimeout(bellTimer);
      bellTimer = null;
    }
    if (telegramTimer) {
      clearTimeout(telegramTimer);
      telegramTimer = null;
    }
  }

  /** Send a Telegram notification with retries + shutdown-abort; failures are surfaced via notify. */
  function sendTelegramNotification(payload: { html: string; text: string }, settings: JsonObject): void {
    sendTelegram(payload, settings, rootCtx, {
      retries: true,
      signal: telegramAbort?.signal ?? null,
    }).catch((error: unknown) => {
      const err = error instanceof Error ? error.message : String(error);
      rootCtx?.ui.notify(`Telegram notification failed: ${err}`, "error");
    });
  }

  // --- User activity detection ---
  // Notifications use delay timers. Timers are cancelled when:
  //   - User presses a key (onTerminalInput)
  //   - User focuses the terminal window (CSI focus reporting, \x1b[?1004h)

  /** Whether terminal focus reporting is active. */
  let focusReportingEnabled = false;

  function enableFocusReporting(): void {
    if (focusReportingEnabled) return;
    process.stdout.write("\x1b[?1004h");
    focusReportingEnabled = true;
  }

  function disableFocusReporting(): void {
    if (!focusReportingEnabled) return;
    process.stdout.write("\x1b[?1004l");
    focusReportingEnabled = false;
  }

  pi.on("session_shutdown", () => {
    // Clear stale context, cancel pending timers, and abort in-flight Telegram
    // retries so no pending timers/sleeps keep the event loop alive on exit.
    rootCtx = null;
    cancelTimers();
    pendingMessages = null;
    pendingSnapshot = null;
    telegramAbort?.abort();
    telegramAbort = null;
    attentionNotified = false;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (isSubagentSession(ctx.mode)) return;
    rootCtx = ctx;
    telegramAbort = new AbortController();
    enableFocusReporting();
    ctx.ui.onTerminalInput((data) => {
      // \x1b[I = terminal window gained focus — user is looking at Pi
      if (data === "\x1b[I") {
        cancelTimers();
        return;
      }
      // \x1b[O = terminal window lost focus — ignore
      if (data === "\x1b[O") return;
      // Any other input (keypresses) — user is at the keyboard
      cancelTimers();
    });
    ctx.ui.notify("Notification extension loaded (/notify)", "info");

    // Expose notification API for other extensions to request attention.
    // Schedules bell + telegram timers. Cancel function clears both.
    const api: NotificationApi = {
      requestAttention: (source: string, detail?: string) => {
        cancelTimers();
        // Snapshot ctx-derived values now — ctx may go stale before timers fire
        const currentCtx = rootCtx;
        const snapshot: SessionSnapshot | null = currentCtx
          ? {
              cwd: currentCtx.cwd,
              sessionHeader: currentCtx.sessionManager.getHeader(),
              sessionId: currentCtx.sessionManager.getSessionId(),
              leafId: currentCtx.sessionManager.getLeafId(),
            }
          : null;
        const settings = snapshot ? loadMergedSettings(snapshot.cwd, NO_EXTENSION_CONTEXT).settings : {};
        const bellDelayMs = parseDelayMs(
          getSetting(settings, "avtc-pi-notifications.bellDelay", "30s"),
          DEFAULT_BELL_DELAY_MS,
        );
        const telegramDelayMs = parseDelayMs(
          getSetting(settings, "avtc-pi-notifications.telegram.delay", "2m"),
          DEFAULT_TELEGRAM_DELAY_MS,
        );

        bellTimer = setTimeout(() => {
          bellTimer = null;
          attentionNotified = true;
          if (!snapshot) return;
          const freshSettings = loadMergedSettings(snapshot.cwd, NO_EXTENSION_CONTEXT).settings;
          ringBell(freshSettings);
        }, bellDelayMs);

        telegramTimer = setTimeout(() => {
          telegramTimer = null;
          attentionNotified = true;
          if (!snapshot) return;
          const freshSettings = loadMergedSettings(snapshot.cwd, NO_EXTENSION_CONTEXT).settings;
          const attentionMsg = buildTelegramAttentionMessage(snapshot, source, detail, 3900);
          sendTelegramNotification({ html: attentionMsg.html, text: attentionMsg.text }, freshSettings);
        }, telegramDelayMs);

        return () => cancelTimers();
      },
    };
    pi.events.emit("pi-notification:ready", api);
  });

  // Clean up focus reporting on exit
  process.on("beforeExit", disableFocusReporting);
  process.on("exit", disableFocusReporting);

  // --- Agent lifecycle ---

  pi.on("agent_start", async () => {
    // New agent loop: reset state, cancel any pending timers
    cancelTimers();
    attentionNotified = false;
  });

  pi.on("turn_start", async () => {
    // New turn within the agent loop (e.g. extension follow-up, auto-agent next task).
    // Cancel pending timers — the agent is still working.
    cancelTimers();
  });

  async function ringBell(settings: JsonObject) {
    // Many terminals (including Alacritty) don't do an audible bell. We still emit BEL,
    // and optionally run a user-specified command (useful on Windows/WSL).
    process.stdout.write("\x07");
    process.stderr.write("\x07");

    const bellCommand = String(
      getSetting(settings, "avtc-pi-notifications.bellCommand", EMPTY_SETTING_FALLBACK),
    ).trim();
    if (!bellCommand) return;

    const timeoutMsRaw = getSetting(settings, "avtc-pi-notifications.bellCommandTimeoutMs", 1500);
    const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 1500;

    try {
      await pi.exec("bash", ["-lc", bellCommand], { timeout: timeoutMs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      rootCtx?.ui.notify(`Bell command failed: ${message}`, "warning");
    }
  }

  // agent_end: capture the agent's messages + a ctx-snapshot for the agent_settled scheduler.
  // We do NOT schedule timers here. In pi's lifecycle, auto-compaction runs AFTER agent_end (in
  // _handlePostAgentRun, BEFORE agent_settled): if we scheduled at agent_end, the bell/telegram
  // timers would tick through the summarization call (which can take many seconds) and fire a
  // false "done" notification while the session is still working. Scheduling is deferred to
  // agent_settled (next handler), which fires only after retry/compaction/continuation resolve.
  //
  // agent_settled carries no message content, so the messages + snapshot must be captured here.
  // (Extension ctx.compact()'s abort used to be suppressed via _disconnectFromAgent, so this
  // handler never saw it; pi 0.84.0+ #7370 removed that suppression — see the abort guard below.)
  pi.on("agent_end", async (event, ctx) => {
    if (isSubagentSession(ctx.mode)) return;
    // NOTE: do NOT guard on ctx.isIdle(). pi keeps session.isStreaming = true for
    // the entire duration of the agent_end listeners (it is only cleared in
    // Agent.finishRun() AFTER all listeners settle), so isIdle() returns false
    // for EVERY agent_end. Guarding here (as a previous version did) silently
    // suppressed all completion/retry-exhaustion notifications.
    // Retry noise is already handled: each retry continuation emits agent_start,
    // whose handler cancels pending timers and resets attentionNotified.

    // Cancel any pending timers — the agent loop ended. Clears a mid-turn
    // requestAttention timer so a fresh completion schedule is built at agent_settled.
    cancelTimers();

    // pi 0.84.0+ (#7370): ctx.compact()'s up-front abort() now reaches extensions as agent_end
    // (previously suppressed via _disconnectFromAgent). The abort carries a terminal assistant
    // message with stopReason "error" + "This operation was aborted". Capturing it would make
    // the immediately-following agent_settled (run loop exits in _runAgent's finally) schedule
    // the bell/telegram, which then tick THROUGH the multi-minute compaction summarization and
    // fire a false "done" notification mid-compaction. Stay transparent: do NOT capture —
    // agent_settled then no-ops (nothing captured), and the compaction's session_compact + the
    // injected continuation's agent_start/agent_end/agent_settled handle the notification
    // (matching pre-#7370, where this abort's agent_end never fired to extensions).
    const endMessages = event.messages as Array<{
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    }>;
    const lastEndMessage = endMessages[endMessages.length - 1];
    if (
      lastEndMessage?.role === "assistant" &&
      lastEndMessage.stopReason === "error" &&
      lastEndMessage.errorMessage === "This operation was aborted"
    ) {
      return;
    }

    // Capture the agent's messages + a ctx-snapshot for the agent_settled scheduler.
    // ctx may become stale if auto-agent triggers newSession/switchSession before the
    // timer fires, so the ctx-derived values are snapshotted now (agent_end and
    // agent_settled belong to the same run, so this is the correct point).
    pendingMessages = event.messages as unknown[];
    pendingSnapshot = {
      cwd: ctx.cwd,
      sessionHeader: ctx.sessionManager.getHeader(),
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
    };
  });

  /**
   * Schedule the completion bell + Telegram timers from a settled/compacted snapshot.
   * Shared by agent_settled (run completion) and session_compact (idle compaction). Bell and
   * Telegram both reload fresh settings at fire time; only the Telegram message differs,
   * supplied by buildTelegramPayload.
   */
  function scheduleCompletionTimers(
    ctx: ExtensionContext,
    snapshot: SessionSnapshot,
    buildTelegramPayload: (snapshot: SessionSnapshot, freshSettings: JsonObject) => { html: string; text: string },
  ) {
    const { settings } = loadMergedSettings(ctx.cwd, ctx);
    const bellDelayMs = parseDelayMs(
      getSetting(settings, "avtc-pi-notifications.bellDelay", "30s"),
      DEFAULT_BELL_DELAY_MS,
    );
    const telegramDelayMs = parseDelayMs(
      getSetting(settings, "avtc-pi-notifications.telegram.delay", "2m"),
      DEFAULT_TELEGRAM_DELAY_MS,
    );

    bellTimer = setTimeout(() => {
      bellTimer = null;
      const { settings: freshSettings } = loadMergedSettings(snapshot.cwd, NO_EXTENSION_CONTEXT);
      ringBell(freshSettings);
    }, bellDelayMs);

    telegramTimer = setTimeout(() => {
      telegramTimer = null;
      const { settings: freshSettings } = loadMergedSettings(snapshot.cwd, NO_EXTENSION_CONTEXT);
      const payload = buildTelegramPayload(snapshot, freshSettings);
      sendTelegramNotification(payload, freshSettings);
    }, telegramDelayMs);
  }

  // agent_settled: the agent run has fully settled — no automatic retry, compaction, or queued
  // continuation will run. This is the true idle point, so the completion timers start here.
  // Scheduling at agent_end would tick through the compaction summarization call (which runs
  // after agent_end, before agent_settled) and fire a false notification mid-compaction.
  pi.on("agent_settled", async (_event, ctx) => {
    if (isSubagentSession(ctx.mode)) return;

    // Consume the payload captured at agent_end (clear first so a later session_shutdown / new
    // run never reuses it). agent_end always precedes agent_settled within a run, so this is set.
    const messages = pendingMessages;
    const snapshot = pendingSnapshot;
    pendingMessages = null;
    pendingSnapshot = null;

    // Defensive: clear any timer still pending (e.g. a requestAttention timer that fired between
    // agent_end and here), then decide whether to schedule.
    cancelTimers();

    // If we already sent an attention notification (tool blocked too long),
    // skip the completion notification — user already knows about this session.
    if (attentionNotified) {
      attentionNotified = false;
      return;
    }

    // Nothing captured (should not happen — agent_end always precedes agent_settled).
    if (!messages || !snapshot) return;

    scheduleCompletionTimers(ctx, snapshot, (snap, freshSettings) => {
      const htmlMessage = buildTelegramMessage(snap, messages, freshSettings, 3900);
      const plainMessage = buildTelegramPlainMessage(snap, messages, freshSettings, 3900);
      return { html: htmlMessage, text: plainMessage };
    });
  });

  // session_compact: a compaction just completed. Schedule a notification when no agent run
  // will carry one via agent_settled — i.e. when agent_end did not fire (pendingMessages is
  // null). This covers a user running /compact while idle: no agent run, so agent_settled never
  // fires, and without this the user (who may have walked away during summarization) gets no
  // bell. If a continuation follows (extension inject / user steer), its agent_start cancels
  // this timer. When an agent run DID carry the notification (pendingMessages set), skip —
  // agent_settled (firing after the compaction window) schedules it.
  pi.on("session_compact", async (_event, ctx) => {
    if (isSubagentSession(ctx.mode)) return;
    // An agent run is in flight (or about to settle) — agent_settled owns the notification.
    if (pendingMessages !== null) return;

    cancelTimers();
    if (attentionNotified) {
      attentionNotified = false;
      return;
    }

    const snapshot: SessionSnapshot = {
      cwd: ctx.cwd,
      sessionHeader: ctx.sessionManager.getHeader(),
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
    };

    scheduleCompletionTimers(ctx, snapshot, (snap) => {
      const compactMsg = buildTelegramCompactMessage(snap, 3900);
      return { html: compactMsg.html, text: compactMsg.text };
    });
  });
  pi.registerCommand("notification:notify", {
    description: "Test notifications (use: /notification:notify debug)",
    handler: async (args, ctx) => {
      const { settings, globalSettingsPath, projectSettingsPath } = loadMergedSettings(ctx.cwd, ctx);

      const enableBell = getSetting(settings, "avtc-pi-notifications.bell", BELL_DEFAULT_ENABLED);
      if (enableBell) {
        await ringBell(settings);
      }
      ctx.ui.notify("Test notification!", "info");

      const enableTelegram = getSetting(settings, "avtc-pi-notifications.telegram.enabled", TELEGRAM_ENABLED_DEFAULT);

      if (args.trim() === "debug") {
        const token = String(
          getSetting(settings, "avtc-pi-notifications.telegram.token", EMPTY_SETTING_FALLBACK),
        ).trim();
        const rawChatId = getSetting(settings, "avtc-pi-notifications.telegram.chatId", EMPTY_SETTING_FALLBACK);
        const chatId = coerceChatId(rawChatId);
        const timeoutMs = getSetting(settings, "avtc-pi-notifications.telegram.timeoutMs", 5000);
        const forceIpv4 = getSetting(settings, "avtc-pi-notifications.telegram.forceIpv4", FORCE_IPV4_DEFAULT);
        const { maxRetries, retryBackoffMs, maxRetryIntervalMs } = readRetryConfig(settings);
        const bellCommand = String(
          getSetting(settings, "avtc-pi-notifications.bellCommand", EMPTY_SETTING_FALLBACK),
        ).trim();
        const bellDelay = getSetting(settings, "avtc-pi-notifications.bellDelay", "30s");
        const telegramDelay = getSetting(settings, "avtc-pi-notifications.telegram.delay", "2m");

        ctx.ui.notify(
          `notify debug: bell=${enableBell}, bellCommand=${bellCommand ? "(set)" : "(unset)"}, bellDelay=${bellDelay}, telegram=${enableTelegram}, telegramDelay=${telegramDelay}, token=${maskToken(token)}, chatId=${chatId ?? "(missing)"}, timeoutMs=${String(timeoutMs)}, forceIpv4=${String(forceIpv4)}, maxRetries=${String(maxRetries)}, retryBackoffMs=${String(retryBackoffMs)}, maxRetryIntervalMs=${String(maxRetryIntervalMs)}`,
          "info",
        );
        ctx.ui.notify(`settings: global=${globalSettingsPath}`, "info");
        ctx.ui.notify(`settings: project=${projectSettingsPath}`, "info");

        if (enableTelegram && token) {
          const me = await telegramCall<{ username?: string; id: number }>({
            token,
            method: "getMe",
            body: {},
            timeoutMs: 3000,
            family: forceIpv4 ? 4 : undefined,
          });
          if (me.ok) {
            ctx.ui.notify(`Telegram getMe ok: @${me.result.username ?? "(no username)"} (${me.result.id})`, "info");
          } else {
            ctx.ui.notify(
              `Telegram getMe failed: ${me.description ?? "Unknown error"}${me.error_code ? ` (code ${me.error_code})` : ""}`,
              "warning",
            );
          }
        }
      }

      try {
        await sendTelegram(
          { html: "<b>Pi test notification</b>", text: "Pi test notification" },
          settings,
          ctx,
          // Manual test command: single attempt, no retries (stays responsive).
          { retries: false, signal: telegramAbort?.signal ?? null },
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Telegram notification failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", () => {
    (globalThis as GlobalWithWired)[WIRED_KEY] = false;
  });
}
