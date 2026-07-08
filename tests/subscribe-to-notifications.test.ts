// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetNotificationState,
  extractLastAssistantText,
  getLastMessage,
  requestAttention,
  subscribeToNotificationApi,
  withAttention,
} from "../src/snippets/canonical/subscribe-to-notifications.js";

beforeEach(() => {
  _resetNotificationState();
});

describe("extractLastAssistantText", () => {
  it("returns empty string for non-assistant message", () => {
    expect(extractLastAssistantText({ message: { role: "user", content: "hello" } })).toBe("");
  });

  it("returns empty string for message without role", () => {
    expect(extractLastAssistantText({ message: { content: "hello" } })).toBe("");
  });

  it("returns empty string for undefined message", () => {
    expect(extractLastAssistantText({})).toBe("");
  });

  it("extracts string content directly", () => {
    expect(
      extractLastAssistantText({
        message: { role: "assistant", content: "I need to ask you something" },
      }),
    ).toBe("I need to ask you something");
  });

  it("extracts last text block from array content", () => {
    const event = {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First part" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
          { type: "text", text: "Now I need to ask" },
        ],
      },
    };
    expect(extractLastAssistantText(event)).toBe("Now I need to ask");
  });

  it("returns empty string for array with no text blocks", () => {
    const event = {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }],
      },
    };
    expect(extractLastAssistantText(event)).toBe("");
  });

  it("returns first text block when only one exists", () => {
    const event = {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Single block" }],
      },
    };
    expect(extractLastAssistantText(event)).toBe("Single block");
  });
});

describe("getLastMessage", () => {
  it("returns empty string initially", () => {
    expect(getLastMessage()).toBe("");
  });
});

describe("subscribeToNotificationApi", () => {
  it("captures last assistant message from message_end events", () => {
    const messageEndHandlers: Array<(event: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn(() => () => {}),
      },
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        if (event === "message_end") {
          messageEndHandlers.push(handler);
        }
        return () => {};
      }),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    // Simulate a message_end event
    expect(messageEndHandlers.length).toBe(1);
    messageEndHandlers[0]?.({
      message: {
        role: "assistant",
        content: "I need to clarify something",
      },
    });

    expect(getLastMessage()).toBe("I need to clarify something");
  });

  it("ignores non-assistant messages", () => {
    const messageEndHandlers: Array<(event: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn(() => () => {}),
      },
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        if (event === "message_end") {
          messageEndHandlers.push(handler);
        }
        return () => {};
      }),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    messageEndHandlers[0]?.({
      message: { role: "user", content: "hello" },
    });

    expect(getLastMessage()).toBe("");
  });

  it("updates on subsequent assistant messages", () => {
    const messageEndHandlers: Array<(event: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn(() => () => {}),
      },
      on: vi.fn((event: string, handler: (event: unknown) => void) => {
        if (event === "message_end") {
          messageEndHandlers.push(handler);
        }
        return () => {};
      }),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    messageEndHandlers[0]?.({
      message: { role: "assistant", content: "First message" },
    });
    expect(getLastMessage()).toBe("First message");

    messageEndHandlers[0]?.({
      message: { role: "assistant", content: "Second message" },
    });
    expect(getLastMessage()).toBe("Second message");
  });

  it("resets on session_shutdown", () => {
    const messageEndHandlers: Array<(event: unknown) => void> = [];
    const shutdownHandlers: Array<() => void> = [];
    const mockPi = {
      events: {
        on: vi.fn(() => () => {}),
      },
      on: vi.fn((event: string, handler: (event?: unknown) => void) => {
        if (event === "message_end") {
          messageEndHandlers.push(handler);
        }
        if (event === "session_shutdown") {
          shutdownHandlers.push(handler);
        }
        return () => {};
      }),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    messageEndHandlers[0]?.({
      message: { role: "assistant", content: "Some message" },
    });
    expect(getLastMessage()).toBe("Some message");

    // Simulate session shutdown
    shutdownHandlers[0]?.();
    expect(getLastMessage()).toBe("");
  });

  it("subscribes to pi-notification:ready for requestAttention", () => {
    let readyHandler: ((data: unknown) => void) | null = null;
    const mockPi = {
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-notification:ready") {
            readyHandler = handler;
          }
          return () => {};
        }),
      },
      on: vi.fn(() => () => {}),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    expect(readyHandler).not.toBeNull();
    expect(mockPi.events.on).toHaveBeenCalledWith("pi-notification:ready", expect.any(Function));
  });
});

describe("requestAttention", () => {
  it("returns undefined when no notification API registered", () => {
    expect(requestAttention("test", "detail")).toBeUndefined();
  });

  it("delegates to registered requestAttention", () => {
    const readyHandlers: Array<(data: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-notification:ready") {
            readyHandlers.push(handler);
          }
          return () => {};
        }),
      },
      on: vi.fn(() => () => {}),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    const mockCancel = vi.fn();
    const mockRA = vi.fn(() => mockCancel);
    readyHandlers[0]?.({ requestAttention: mockRA });

    const cancel = requestAttention("source", "detail");
    expect(mockRA).toHaveBeenCalledWith("source", "detail");
    expect(cancel).toBe(mockCancel);
  });
});

describe("withAttention", () => {
  it("calls fn directly when no notification API", async () => {
    const fn = vi.fn(async () => "result");
    const result = await withAttention("source", "detail", fn);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("calls cancel after fn completes", async () => {
    const readyHandlers: Array<(data: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-notification:ready") {
            readyHandlers.push(handler);
          }
          return () => {};
        }),
      },
      on: vi.fn(() => () => {}),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    const mockCancel = vi.fn();
    const mockRA = vi.fn(() => mockCancel);
    readyHandlers[0]?.({ requestAttention: mockRA });

    const fn = vi.fn(async () => "done");
    const result = await withAttention("src", "det", fn);
    expect(result).toBe("done");
    expect(mockRA).toHaveBeenCalledWith("src", "det");
    expect(mockCancel).toHaveBeenCalledOnce();
  });

  it("calls cancel even when fn throws", async () => {
    const readyHandlers: Array<(data: unknown) => void> = [];
    const mockPi = {
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          if (event === "pi-notification:ready") {
            readyHandlers.push(handler);
          }
          return () => {};
        }),
      },
      on: vi.fn(() => () => {}),
    };

    subscribeToNotificationApi(mockPi as unknown as ExtensionAPI);

    const mockCancel = vi.fn();
    const mockRA = vi.fn(() => mockCancel);
    readyHandlers[0]?.({ requestAttention: mockRA });

    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(withAttention("src", "det", fn)).rejects.toThrow("boom");
    expect(mockCancel).toHaveBeenCalledOnce();
  });
});
