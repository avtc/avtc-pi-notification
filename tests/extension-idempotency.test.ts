// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI, ExtensionContext, ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import extension from "../src/extension.ts";

/**
 * Idempotent wiring guard tests.
 *
 * The notification extension can be bundled into the avtc-pi umbrella AND
 * installed standalone — whichever copy loads first wires, the rest no-op.
 * This is enforced via a globalThis flag that the entry function checks before
 * registering handlers.
 */

type EventName = string;

/** Mock pi matching the shape the entry function touches (on/exec/registerCommand/events). */
function createMockPi() {
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
  return pi;
}

const ctx: ExtensionContext = {
  mode: "tui" as const,
  hasUI: true,
  isIdle: () => false,
  cwd: "/tmp/idempotency",
  sessionManager: {
    getHeader: () => null,
    getSessionId: () => "session-1",
    getLeafId: () => "leaf-1",
  },
  ui: { notify: vi.fn(), onTerminalInput: vi.fn() },
} as unknown as ExtensionContext;

// ctx is used below to invoke captured lifecycle handlers against a realistic context.

const WIRED_FLAG = "__avtcPiNotificationWired";

describe("idempotent wiring guard", () => {
  beforeEach(() => {
    delete (globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG];
  });
  afterEach(() => {
    delete (globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG];
  });

  it("wires on first call without throwing", () => {
    const pi = createMockPi();
    expect(() => extension(pi)).not.toThrow();
    // First call registers handlers — at least one pi.on registration.
    expect(pi.on).toHaveBeenCalled();
  });

  it("second call no-ops without throwing (does not re-register)", () => {
    const pi = createMockPi();
    extension(pi);
    const firstCallCount = vi.mocked(pi.on).mock.calls.length;

    expect(() => extension(pi)).not.toThrow();
    // Second call must NOT register any additional handlers.
    expect(vi.mocked(pi.on).mock.calls.length).toBe(firstCallCount);
  });

  it("sets the globalThis wiring flag", () => {
    const pi = createMockPi();
    extension(pi);
    expect((globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG]).toBe(true);
  });

  it("re-wires after session_shutdown resets the flag (reload-safe)", async () => {
    const pi = createMockPi();

    // First call: wires the extension (registers handlers + sets flag).
    extension(pi);
    expect((globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG]).toBe(true);
    const firstCallCount = vi.mocked(pi.on).mock.calls.length;

    // Second call: no-op — flag stays set, no new handlers registered.
    extension(pi);
    expect((globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG]).toBe(true);
    expect(vi.mocked(pi.on).mock.calls.length).toBe(firstCallCount);

    // Capture and fire every session_shutdown handler (simulates /reload teardown).
    const shutdownHandlers = vi
      .mocked(pi.on)
      .mock.calls.filter(([event]) => event === "session_shutdown")
      .map(([, handler]) => handler as ExtensionHandler<unknown>);
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const handler of shutdownHandlers) {
      await handler(undefined as unknown as Parameters<typeof handler>[0], ctx);
    }

    // Shutdown must reset the flag so a fresh module load can re-wire.
    expect((globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG]).toBe(false);

    // Third call: re-wires — flag set again and handlers re-registered.
    extension(pi);
    expect((globalThis as { [WIRED_FLAG]?: boolean })[WIRED_FLAG]).toBe(true);
    expect(vi.mocked(pi.on).mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});
