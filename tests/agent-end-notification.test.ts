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
  });
});
