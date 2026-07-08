// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { assembleAndTrim, escapeHtml, formatToTelegramHtml, htmlAwareSlice, truncateText } from "../src/format.js";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeHtml("a & b & c")).toBe("a &amp; b &amp; c");
  });
});

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    expect(truncateText("short", 100)).toBe("short");
  });

  it("truncates at a paragraph break when available", () => {
    const text =
      "First paragraph here with enough words to push past the break." +
      "\n\nSecond paragraph that is long enough to require truncation here and even more padding now.";
    const result = truncateText(text, 80);
    expect(result).toContain("...(truncated)");
    // Should prefer the \n\n break point
    expect(result).toContain("First paragraph");
  });

  it("truncates at a sentence break when available", () => {
    const text =
      "Leading words to position the sentence break deeper in the slice. " +
      "This is sentence one. " +
      "This is sentence two and it continues on with more padding to fill space now here.";
    const result = truncateText(text, 100);
    expect(result).toContain("...(truncated)");
    expect(result.endsWith("...(truncated)")).toBe(true);
  });

  it("produces no truncation marker when under limit", () => {
    expect(truncateText("abc", 3)).toBe("abc");
  });
});

describe("htmlAwareSlice", () => {
  it("returns short html unchanged", () => {
    expect(htmlAwareSlice("<b>hi</b>", 100)).toBe("<b>hi</b>");
  });

  it("does not split a numeric entity", () => {
    // A string ending in an entity &#39; should not be cut mid-entity.
    const html = `<code>${"x".repeat(15)}&#39;</code>`;
    const sliced = htmlAwareSlice(html, 20);
    // The entity must not appear half-cut: either fully present or fully omitted.
    expect(sliced.endsWith("&#39;") || !sliced.includes("&#39;")).toBe(true);
    // No dangling ampersand left at the cut
    expect(sliced.endsWith("&") || sliced.endsWith("&#")).toBe(false);
  });

  it("cuts before a tag start when one falls near the boundary", () => {
    const html = `${"x".repeat(18)}<b>`;
    const sliced = htmlAwareSlice(html, 20);
    // Should cut before the '<' rather than leaving a dangling '<'
    expect(sliced.endsWith("<")).toBe(false);
  });
});

describe("assembleAndTrim", () => {
  it("joins lines under the limit", () => {
    expect(assembleAndTrim(["a", "b", "c"], 100)).toBe("a\nb\nc");
  });

  it("trims and adds truncation marker when over the limit", () => {
    const lines = ["x".repeat(40), "y".repeat(40)];
    const result = assembleAndTrim(lines, 50);
    expect(result).toContain("...(truncated)");
  });
});

describe("formatToTelegramHtml", () => {
  it("escapes HTML in plain text", () => {
    expect(formatToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("converts markdown bold", () => {
    expect(formatToTelegramHtml("**important**")).toBe("<b>important</b>");
  });

  it("converts headings to bold", () => {
    expect(formatToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(formatToTelegramHtml("### Subtitle")).toBe("<b>Subtitle</b>");
  });

  it("converts bullet markers", () => {
    const result = formatToTelegramHtml("- item one\n- item two");
    expect(result).toContain("• item one");
    expect(result).toContain("• item two");
  });

  it("wraps inline code in <code>", () => {
    expect(formatToTelegramHtml("use `npm test`")).toBe("use <code>npm test</code>");
  });

  it("wraps fenced code blocks in <pre><code>", () => {
    const result = formatToTelegramHtml("```js\nconsole.log(1)\n```");
    expect(result).toBe("<pre><code>console.log(1)</code></pre>");
  });

  it("escapes HTML inside code blocks", () => {
    const result = formatToTelegramHtml("```\n<b>not html</b>\n```");
    expect(result).toContain("&lt;b&gt;not html&lt;/b&gt;");
  });

  it("escapes HTML inside inline code", () => {
    expect(formatToTelegramHtml("run `<danger>`")).toBe("run <code>&lt;danger&gt;</code>");
  });

  it("trims surrounding whitespace", () => {
    expect(formatToTelegramHtml("  hello  ")).toBe("hello");
  });

  it("preserves content with no markdown as plain escaped text", () => {
    expect(formatToTelegramHtml("just words here")).toBe("just words here");
  });
});
