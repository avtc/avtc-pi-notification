// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import {
  buildTelegramAttentionMessage,
  buildTelegramCompactMessage,
  buildTelegramMessage,
  buildTelegramPlainMessage,
  collectToolErrors,
  extractModelError,
  extractText,
  findFirstByRole,
  findLastByRole,
} from "../src/message.js";
import type { JsonObject, SessionSnapshot } from "../src/types.js";

const snapshot = (): SessionSnapshot => ({
  cwd: "/home/user/project",
  sessionHeader: null,
  sessionId: "abcdefgh1234",
  leafId: null,
});

const emptySettings = (): JsonObject => ({});

describe("extractText", () => {
  it("returns empty for non-objects", () => {
    expect(extractText(null)).toBe("");
    expect(extractText("hello")).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  it("returns trimmed string content", () => {
    expect(extractText({ content: "  hi there  " })).toBe("hi there");
  });

  it("joins text blocks from array content", () => {
    const msg = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    };
    expect(extractText(msg)).toBe("line one\nline two");
  });

  it("skips non-text blocks", () => {
    const msg = {
      content: [
        { type: "image", text: "ignored" },
        { type: "text", text: "kept" },
      ],
    };
    expect(extractText(msg)).toBe("kept");
  });

  it("skips empty/whitespace text blocks", () => {
    const msg = {
      content: [
        { type: "text", text: "   " },
        { type: "text", text: "real" },
      ],
    };
    expect(extractText(msg)).toBe("real");
  });

  it("returns empty for unknown content shapes", () => {
    expect(extractText({ content: 123 })).toBe("");
    expect(extractText({})).toBe("");
  });
});

describe("findFirstByRole / findLastByRole", () => {
  const msgs = [{ role: "user" }, { role: "assistant" }, { role: "user", id: 2 }];

  it("finds the first message by role", () => {
    expect(findFirstByRole(msgs, "user")).toEqual({ role: "user" });
  });

  it("finds the last message by role", () => {
    expect(findLastByRole(msgs, "user")).toEqual({ role: "user", id: 2 });
  });

  it("returns undefined when no match", () => {
    expect(findFirstByRole(msgs, "system")).toBeUndefined();
    expect(findLastByRole(msgs, "system")).toBeUndefined();
  });
});

describe("collectToolErrors", () => {
  it("collects only toolResults with isError=true", () => {
    const msgs = [
      { role: "toolResult", isError: true, toolName: "bash", content: "failed" },
      { role: "toolResult", isError: false, toolName: "git", content: "ok" },
      { role: "toolResult", isError: true, toolName: "grep", content: "no match" },
    ];
    const errors = collectToolErrors(msgs, 3);
    expect(errors).toHaveLength(2);
    expect(errors[0].tool).toBe("bash");
    expect(errors[1].tool).toBe("grep");
  });

  it("caps at maxItems", () => {
    const msgs = [
      { role: "toolResult", isError: true, toolName: "a", content: "x" },
      { role: "toolResult", isError: true, toolName: "b", content: "x" },
      { role: "toolResult", isError: true, toolName: "c", content: "x" },
    ];
    expect(collectToolErrors(msgs, 2)).toHaveLength(2);
  });

  it("uses (unknown) for missing toolName", () => {
    const msgs = [{ role: "toolResult", isError: true, content: "err" }];
    expect(collectToolErrors(msgs, 3)[0].tool).toBe("(unknown)");
  });

  it("returns results in chronological order (reverse of the backward scan)", () => {
    const msgs = [
      { role: "toolResult", isError: true, toolName: "first", content: "x" },
      { role: "toolResult", isError: true, toolName: "second", content: "x" },
    ];
    const errors = collectToolErrors(msgs, 3);
    expect(errors[0].tool).toBe("first");
    expect(errors[1].tool).toBe("second");
  });

  it("returns empty for no errors", () => {
    expect(collectToolErrors([{ role: "toolResult", isError: false }], 3)).toEqual([]);
  });
});

describe("extractModelError", () => {
  it("returns null when no assistant message", () => {
    expect(extractModelError([{ role: "user" }])).toBeNull();
  });

  it("returns null when assistant did not stop on error", () => {
    expect(extractModelError([{ role: "assistant", stopReason: "stop" }])).toBeNull();
  });

  it("returns the error message on stopReason=error", () => {
    expect(extractModelError([{ role: "assistant", stopReason: "error", errorMessage: "rate limited" }])).toBe(
      "rate limited",
    );
  });

  it("returns null when stopReason=error but no message", () => {
    expect(extractModelError([{ role: "assistant", stopReason: "error" }])).toBeNull();
  });
});

describe("buildTelegramMessage", () => {
  it("renders a ready header with the last answer", () => {
    const msgs = [{ role: "assistant", content: "Hello world" }];
    const html = buildTelegramMessage(snapshot(), msgs, emptySettings(), 3900);
    expect(html).toContain("<b>Pi is ready</b>");
    expect(html).toContain("cwd: <code>/home/user/project</code>");
    expect(html).toContain("Hello world");
    expect(html).toContain("<b>Last answer</b>");
  });

  it("includes the short session id", () => {
    const html = buildTelegramMessage(snapshot(), [{ role: "assistant", content: "x" }], emptySettings(), 3900);
    expect(html).toContain("<code>abcdefgh</code>");
  });

  it("renders an error header when the model errored", () => {
    const msgs = [{ role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" }];
    const html = buildTelegramMessage(snapshot(), msgs, emptySettings(), 3900);
    expect(html).toContain("<b>Pi encountered an error</b>");
    expect(html).toContain("429 Too Many Requests");
  });

  it("includes tool errors when present", () => {
    const msgs = [
      { role: "toolResult", isError: true, toolName: "bash", content: "command not found" },
      { role: "assistant", content: "done" },
    ];
    const html = buildTelegramMessage(snapshot(), msgs, emptySettings(), 3900);
    expect(html).toContain("<b>Tool errors</b>");
    expect(html).toContain("bash");
  });

  it("includes the prompt when includePrompt is enabled", () => {
    const settings = { "avtc-pi-notifications": { telegram: { includePrompt: true } } };
    const msgs = [
      { role: "user", content: "build the thing" },
      { role: "assistant", content: "ok" },
    ];
    const html = buildTelegramMessage(snapshot(), msgs, settings, 3900);
    expect(html).toContain("<b>Prompt</b>");
    expect(html).toContain("build the thing");
  });

  it("falls back to '(no assistant output)' when no answer", () => {
    const html = buildTelegramMessage(snapshot(), [], emptySettings(), 3900);
    expect(html).toContain("(no assistant output)");
  });
});

describe("buildTelegramPlainMessage", () => {
  it("renders a plain-text ready header with the last answer", () => {
    const html = buildTelegramPlainMessage(snapshot(), [{ role: "assistant", content: "Hi" }], emptySettings(), 3900);
    expect(html).toContain("Pi is ready");
    expect(html).toContain("cwd: /home/user/project");
    expect(html).toContain("Hi");
    expect(html).not.toContain("<b>");
  });
});

describe("buildTelegramAttentionMessage", () => {
  it("renders an attention header with label parsed from detail", () => {
    const result = buildTelegramAttentionMessage(snapshot(), "ask_user_question", "My Question • feature1", 3900);
    expect(result.html).toContain("<b>Pi needs attention</b>");
    expect(result.html).toContain("My Question");
    expect(result.html).toContain("feature1");
    expect(result.text).toContain("Pi needs attention");
  });

  it("includes a lastMessage segment from detail", () => {
    const detail = "label • feature • the last message text";
    const result = buildTelegramAttentionMessage(snapshot(), "src", detail, 3900);
    expect(result.html).toContain("the last message text");
    expect(result.text).toContain("the last message text");
  });

  it("handles undefined detail", () => {
    const result = buildTelegramAttentionMessage(snapshot(), "src", undefined, 3900);
    expect(result.html).toContain("<b>Pi needs attention</b>");
    expect(result.text).toContain("Pi needs attention");
  });

  it("returns both html and text forms", () => {
    const result = buildTelegramAttentionMessage(snapshot(), "src", "x", 3900);
    expect(typeof result.html).toBe("string");
    expect(typeof result.text).toBe("string");
  });
});

describe("buildTelegramCompactMessage", () => {
  it("renders a compacted header and cwd", () => {
    const result = buildTelegramCompactMessage(snapshot(), 3900);
    expect(result.html).toContain("<b>Context compacted</b>");
    expect(result.html).toContain("ready to continue");
    expect(result.html).toContain("cwd: <code>/home/user/project</code>");
    expect(result.text).toContain("Context compacted");
    expect(result.text).toContain("ready to continue");
    expect(result.text).toContain("cwd: /home/user/project");
  });

  it("includes the short session id", () => {
    const result = buildTelegramCompactMessage(snapshot(), 3900);
    expect(result.html).toContain("abcdefgh");
  });
});
