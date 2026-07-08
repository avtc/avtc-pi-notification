// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { deepMerge, getSetting, isPlainObject, parseDelayMs } from "../src/settings.js";

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("merges shallow keys (override wins)", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("deep-merges nested objects", () => {
    const base = { "avtc-pi-notifications": { bell: true, telegram: { enabled: false } } };
    const overrides = { "avtc-pi-notifications": { telegram: { enabled: true } } };
    expect(deepMerge(base, overrides)).toEqual({
      "avtc-pi-notifications": { bell: true, telegram: { enabled: true } },
    });
  });

  it("skips undefined override values", () => {
    expect(deepMerge({ a: 1 }, { a: undefined, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("replaces non-object base values with object overrides", () => {
    expect(deepMerge({ a: 1 }, { a: { nested: true } })).toEqual({ a: { nested: true } });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { y: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("getSetting", () => {
  const settings = {
    "avtc-pi-notifications": {
      telegram: { token: "abc", enabled: true },
      bell: false,
    },
    top: "value",
  };

  it("reads nested paths", () => {
    expect(getSetting(settings, "avtc-pi-notifications.telegram.token", "")).toBe("abc");
    expect(getSetting(settings, "avtc-pi-notifications.telegram.enabled", false)).toBe(true);
  });

  it("reads top-level paths", () => {
    expect(getSetting(settings, "top", "")).toBe("value");
  });

  it("returns fallback for missing paths", () => {
    expect(getSetting(settings, "avtc-pi-notifications.missing", "fb")).toBe("fb");
    expect(getSetting(settings, "nonexistent.deep.path", 42)).toBe(42);
  });

  it("returns fallback when path crosses a non-object", () => {
    expect(getSetting({ a: "string" }, "a.b", "fb")).toBe("fb");
  });

  it("handles empty/null path parts", () => {
    expect(getSetting(settings, "top.", "fb")).toBe("value");
  });
});

describe("parseDelayMs", () => {
  it("parses seconds", () => {
    expect(parseDelayMs("30s", 0)).toBe(30_000);
    expect(parseDelayMs("1.5s", 0)).toBe(1500);
  });

  it("parses minutes", () => {
    expect(parseDelayMs("2m", 0)).toBe(120_000);
    expect(parseDelayMs("0.5m", 0)).toBe(30_000);
  });

  it("parses bare numbers as milliseconds", () => {
    expect(parseDelayMs("1500", 0)).toBe(1500);
    expect(parseDelayMs(5000, 0)).toBe(5000);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseDelayMs("  30S  ", 0)).toBe(30_000);
    expect(parseDelayMs("1M", 0)).toBe(60_000);
  });

  it("returns fallback for invalid input", () => {
    expect(parseDelayMs("not a number", 999)).toBe(999);
    expect(parseDelayMs(undefined, 999)).toBe(999);
    expect(parseDelayMs(null, 999)).toBe(999);
  });

  it("rejects negative numbers", () => {
    expect(parseDelayMs(-5, 999)).toBe(999);
  });
});
