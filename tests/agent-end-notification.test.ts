// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { AgentEndEvent, ExtensionAPI, ExtensionContext, ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the notification extension's agent_end logic.
 *
 * These reproduce the EXACT pi lifecycle (verified against
 * node_modules/@earendil-works/pi-coding-agent/dist):
 *
 *  interactive-mode.js:1305 isIdle: => !this.session.isStreaming
 *  agent-session.js:504 isStreaming => this.agent.state.isStreaming
 *  agent-session.js:242 _handleAgentEvent awaits _emitExtensionEvent(event)
 *  (extension handlers run here, while isStreaming is
 *  still true => ctx.isIdle returns false)
 *  agent-loop.js:57 runAgentLoopContinue emits agent_start on EVERY
 *  retry continuation, so the agent_start handler's
 *  cancelTimers protects against retry noise.
 *
 * Regression under test: `if (!ctx.isIdle) return;` in the
 * agent_end handler ALWAYS suppressed notifications because isStreaming is true
 * for every agent_end in the real lifecycle.
 */

import extension from "../src/extension.ts";

/** Any event name the extension registers a handler for. */
type EventName = string;

function createMockPi(isIdle: () => boolean) {
  const handlers = new Map<string, ExtensionHandler<unknown>[]>();
  const pi = {
    on: vi.fn((event: EventName, handler: ExtensionHandler<unknown>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    }),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    registerCommand: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
  } as unknown as ExtensionAPI;
  (pi as unknown as { _handlers: Map<string, ExtensionHandler<unknown>[]> })._handlers = handlers;
  const ctx: ExtensionContext = {
    mode: "tui" as const,
    hasUI: true,
    isIdle,
    cwd: "/tmp/repro",
    sessionManager: {
      getHeader: () => null,
      getSessionId: () => "session-1",
      getLeafId: () => "leaf-1",
    },
    ui: { notify: vi.fn(), onTerminalInput: vi.fn() },
  } as unknown as ExtensionContext;
  return { pi, ctx };
}

async function fire(pi: ExtensionAPI, event: EventName, payload: unknown, ctx: ExtensionContext) {
  const map = (pi as unknown as { _handlers: Map<string, ExtensionHandler<unknown>[]> })._handlers;
  for (const h of map.get(event) ?? []) await h(payload, ctx);
}

/** Build a failed assistant message like the one pi emits on LLM error. */
function failureMessage(): AgentEndEvent["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: "Retry failed after 9 attempts: 500 An error occurred...",
  } as AgentEndEvent["messages"][number];
}

function agentEndEvent(): AgentEndEvent {
  return { type: "agent_end", messages: [failureMessage()] };
}

describe("agent_end notification lifecycle", () => {
  let pendingTimers: number;
  let nextHandle: number;
  const liveHandles = new Set<number>();
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset the idempotent wiring guard so each test gets a fresh unwired entry.
    delete (globalThis as { __avtcPiNotificationWired?: boolean }).__avtcPiNotificationWired;
    pendingTimers = 0;
    nextHandle = 1;
    liveHandles.clear();
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => {
      const handle = nextHandle++;
      liveHandles.add(handle);
      pendingTimers++;
      return handle as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: unknown) => {
      if (typeof handle === "number" && liveHandles.delete(handle)) {
        pendingTimers = Math.max(0, pendingTimers - 1);
      }
    }) as unknown as typeof clearTimeout);
  });
  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  /** Drive a full retry-exhaustion sequence (the user's reported scenario). */
  async function runRetryExhaustion(pi: ExtensionAPI, ctx: ExtensionContext, attempts: number) {
    await fire(pi, "session_start", {}, ctx);
    // initial prompt + (attempts) retry continuations, each ending in agent_end
    await fire(pi, "agent_start", {}, ctx);
    await fire(pi, "agent_end", agentEndEvent(), ctx);
    for (let i = 0; i < attempts; i++) {
      // each retry continuation starts with agent_start (cancels prior timers)
      await fire(pi, "agent_start", {}, ctx);
      await fire(pi, "agent_end", agentEndEvent(), ctx);
    }
    // The run settles here — completion timers are scheduled at agent_settled, not agent_end.
    await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
  }

  it("schedules a notification after retry exhaustion (isStreaming=true at agent_end)", async () => {
    // Real lifecycle: ctx.isIdle returns false during agent_end. The fix must
    // NOT depend on isIdle, otherwise the final exhaustion is never notified.
    const { pi, ctx } = createMockPi(() => false);

    extension(pi);
    await runRetryExhaustion(pi, ctx, 9);

    // The final agent_settled (after exhaustion) must have scheduled bell + telegram.
    expect(pendingTimers).toBe(2);
  });

  it("does NOT schedule at agent_end (scheduling deferred to agent_settled)", async () => {
    // agent_end captures messages but must not start timers: compaction runs between
    // agent_end and agent_settled, and scheduling at agent_end would tick through it.
    const { pi, ctx } = createMockPi(() => false);
    extension(pi);

    await fire(pi, "session_start", {}, ctx);
    await fire(pi, "agent_start", {}, ctx);
    await fire(pi, "agent_end", agentEndEvent(), ctx);

    // No timers scheduled yet — agent_end only captures.
    expect(pendingTimers).toBe(0);
  });

  it("does not accumulate timers across intermediate retries (agent_start cancels, agent_settled schedules once)", async () => {
    const { pi, ctx } = createMockPi(() => false);
    extension(pi);

    await fire(pi, "session_start", {}, ctx);
    await fire(pi, "agent_start", {}, ctx);
    await fire(pi, "agent_end", agentEndEvent(), ctx);
    // agent_end does not schedule; nothing pending.
    expect(pendingTimers).toBe(0);

    // Retry continuation: agent_start (no-op cancel), agent_end (capture only).
    await fire(pi, "agent_start", {}, ctx);
    expect(pendingTimers).toBe(0);
    await fire(pi, "agent_end", agentEndEvent(), ctx);
    expect(pendingTimers).toBe(0);

    // agent_settled schedules exactly one bell + one telegram (net 2, not accumulated).
    await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
    expect(pendingTimers).toBe(2);
  });

  it("schedules a notification on normal completion too", async () => {
    const { pi, ctx } = createMockPi(() => false);
    extension(pi);

    await fire(pi, "session_start", {}, ctx);
    await fire(pi, "agent_start", {}, ctx);
    await fire(pi, "agent_end", { type: "agent_end", messages: [{ role: "assistant", content: "all done" }] }, ctx);
    await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);

    expect(pendingTimers).toBe(2);
  });

  it("ignores agent_end for subagents (mode=rpc)", async () => {
    const { pi, ctx } = createMockPi(() => false);
    extension(pi);

    await fire(pi, "session_start", {}, ctx);
    await fire(pi, "agent_start", {}, ctx);
    const subagentCtx = { ...ctx, mode: "rpc" as const };
    await fire(pi, "agent_end", agentEndEvent(), subagentCtx);
    await fire(pi, "agent_settled", { type: "agent_settled" }, subagentCtx);

    expect(pendingTimers).toBe(0);
  });

  describe("compaction window (schedule on agent_settled, not agent_end)", () => {
    it("pi auto-compaction path: schedules only after compaction (agent_settled fires last)", async () => {
      // pi's own auto-compaction runs in _handlePostAgentRun AFTER agent_end and BEFORE
      // agent_settled. agent_end must NOT schedule (it only captures): otherwise the bell/
      // telegram timers would tick through the summarization call and fire mid-compaction.
      // No timer is pending during the compaction window; agent_settled schedules once idle.
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(pi, "agent_start", {}, ctx);
      // agent_end captures but does NOT schedule — no timer during the compaction window.
      await fire(pi, "agent_end", agentEndEvent(), ctx);
      expect(pendingTimers).toBe(0);

      // (compaction runs here, between agent_end and agent_settled — no timer to tick)

      // Now the run settles — timers scheduled.
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
      expect(pendingTimers).toBe(2);
    });

    it("reschedules after a continuation run (inject → agent_start → agent_end → agent_settled)", async () => {
      // After an extension compaction (or any continuation) starts a new run, that run's
      // agent_settled schedules the completion notification for its result.
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(pi, "agent_start", {}, ctx);
      await fire(pi, "agent_end", agentEndEvent(), ctx);
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);

      // Continuation: agent_start cancels prior timers; the new run schedules fresh ones.
      await fire(pi, "agent_start", {}, ctx);
      expect(pendingTimers).toBe(0);
      await fire(pi, "agent_end", agentEndEvent(), ctx);
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
      expect(pendingTimers).toBe(2);
    });

    it("manual /compact (idle, no agent run): schedules a bell via session_compact", async () => {
      // A user runs /compact while idle — no agent_end/agent_settled fires. Without a
      // session_compact listener, the user (who may have walked away) gets no bell.
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      // No agent_start/agent_end — pure idle manual compact.
      await fire(
        pi,
        "session_compact",
        {
          type: "session_compact",
          compactionEntry: { id: "c1", type: "compaction" },
          fromExtension: false,
          reason: "manual",
          willRetry: false,
        },
        ctx,
      );
      expect(pendingTimers).toBe(2);
    });

    it("session_compact skips scheduling when an agent run will carry it (pendingMessages set)", async () => {
      // Auto-compaction path: agent_end fired (captured), so agent_settled will schedule.
      // session_compact must NOT also schedule (avoid redundancy).
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(pi, "agent_start", {}, ctx);
      await fire(pi, "agent_end", agentEndEvent(), ctx); // captures pendingMessages
      await fire(
        pi,
        "session_compact",
        {
          type: "session_compact",
          compactionEntry: { id: "c1", type: "compaction" },
          fromExtension: false,
          reason: "threshold",
          willRetry: false,
        },
        ctx,
      );
      expect(pendingTimers).toBe(0); // agent_settled will schedule, not session_compact
    });

    it("a steer after /compact cancels the compact notification (agent_start)", async () => {
      // After a manual /compact schedules a bell, a user steer starts a run → agent_start
      // cancels the timer (the user is back and engaged).
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(
        pi,
        "session_compact",
        {
          type: "session_compact",
          compactionEntry: { id: "c1", type: "compaction" },
          fromExtension: false,
          reason: "manual",
          willRetry: false,
        },
        ctx,
      );
      expect(pendingTimers).toBe(2);

      await fire(pi, "agent_start", {}, ctx);
      expect(pendingTimers).toBe(0);
    });

    it("extension-triggered compact abort stays transparent (pi #7370): session_before_compact cancels mid-compaction timers", async () => {
      // pi 0.84.0+ (#7370) removed _disconnectFromAgent() from compact(), so ctx.compact()'s
      // up-front abort() now reaches extensions as agent_end. The provider surfaces that abort
      // with a VARIABLE errorMessage — zai-proxy/glm reports "This operation was aborted" OR
      // "terminated" (and vLLM/others differ again) — so a string guard is too fragile. pi's own
      // compaction_start is internal-only (not in the ExtensionEvent union), so the earliest
      // extension-visible signal that a compaction is starting is session_before_compact, which
      // fires right after the abort and BEFORE the multi-minute summarization — within the 30s
      // bell window. Cancelling there is reliable and string-independent. A genuine error
      // (429 / retry-exhaustion) is never followed by a compaction, so its notification still
      // fires (see the next test).
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(pi, "agent_start", {}, ctx);
      // The compact abort's agent_end — here surfaced as "terminated" (NOT "This operation was
      // aborted"). It is captured (as any agent_end is); agent_settled then schedules timers.
      await fire(
        pi,
        "agent_end",
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              stopReason: "error",
              errorMessage: "terminated",
            },
          ],
        },
        ctx,
      );
      // agent_settled fires right after the abort (run loop exits in _runAgent's finally) — it
      // schedules the bell/telegram (which would tick through summarization and fire mid-compaction).
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
      expect(pendingTimers).toBe(2);

      // session_before_compact fires milliseconds later, BEFORE summarization — it MUST cancel
      // those timers so nothing ticks through the multi-minute compaction.
      await fire(
        pi,
        "session_before_compact",
        { type: "session_before_compact", reason: "manual", willRetry: false },
        ctx,
      );
      expect(pendingTimers).toBe(0);

      // Compaction completes → session_compact schedules the idle-path timer (no agent run
      // carries it: pendingMessages was consumed at agent_settled).
      await fire(
        pi,
        "session_compact",
        {
          type: "session_compact",
          compactionEntry: { id: "c1", type: "compaction" },
          fromExtension: true,
          reason: "manual",
          willRetry: false,
        },
        ctx,
      );
      expect(pendingTimers).toBe(2);

      // The injected continuation starts shortly after → agent_start cancels (no false notification).
      await fire(pi, "agent_start", {}, ctx);
      expect(pendingTimers).toBe(0);

      // Continuation completes → schedules correctly.
      await fire(pi, "agent_end", agentEndEvent(), ctx);
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
      expect(pendingTimers).toBe(2);
    });

    it("a genuine error NOT followed by a compaction still notifies (regression guard)", async () => {
      // session_before_compact is what neutralizes the abort's timers; a real error is never
      // followed by a compaction, so its bell/telegram must fire normally. Guards against
      // over-broad suppression (e.g. matching on usage===0, which a 429 rate-limit also has).
      const { pi, ctx } = createMockPi(() => false);
      extension(pi);

      await fire(pi, "session_start", {}, ctx);
      await fire(pi, "agent_start", {}, ctx);
      // A genuine 429 rate-limit error (usage 0, like an abort — but real).
      await fire(
        pi,
        "agent_end",
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              stopReason: "error",
              errorMessage: '429 {"error":{"type":"rate_limit_error","message":"Usage limit reached"}}',
            },
          ],
        },
        ctx,
      );
      await fire(pi, "agent_settled", { type: "agent_settled" }, ctx);
      expect(pendingTimers).toBe(2);
      // No session_before_compact ever fires for a real error → timers stay live (notification fires).
    });
  });
});
