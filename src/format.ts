// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 40));
  const breakPoint = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
  const cut = breakPoint > slice.length * 0.6 ? slice.slice(0, breakPoint).trim() : slice.trim();
  return `${cut}\n\n...(truncated)`;
}

/** Truncate an HTML string without splitting entities (e.g. &amp; → don't cut inside it). */
export function htmlAwareSlice(html: string, maxLen: number): string {
  if (html.length <= maxLen) return html;
  // Find the last ';' before maxLen that closes an entity (preceded by '&' within 10 chars).
  // Walk backwards from maxLen to find a safe cut point.
  let cut = maxLen;
  for (let i = Math.min(maxLen, html.length) - 1; i >= Math.max(0, maxLen - 12); i--) {
    if (html[i] === ";") {
      // Look back for '&' within 10 chars (longest entity: &#x27; = 6 chars)
      const amp = html.lastIndexOf("&", i);
      if (amp !== -1 && amp >= i - 10 && amp < i) {
        cut = amp;
        break;
      }
      cut = i + 1;
      break;
    }
    // If we hit a '<' (start of tag), cut before it
    if (html[i] === "<") {
      cut = i;
      break;
    }
  }
  return html.slice(0, cut).trimEnd();
}

/** Assemble lines and enforce maxLen with HTML-aware final trim. */
export function assembleAndTrim(lines: string[], maxLen: number): string {
  const joined = lines.join("\n").trim();
  if (joined.length <= maxLen) return joined;
  const trimmed = htmlAwareSlice(joined, maxLen - 20);
  return `${trimmed}\n...(truncated)`;
}

export function formatToTelegramHtml(markdown: string): string {
  let result = markdown;

  // Protect code blocks first
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    const index = codeBlocks.length;
    const escapedCode = escapeHtml(String(code ?? "").trim());
    codeBlocks.push(`<pre><code>${escapedCode}</code></pre>`);
    return `%%CODEBLOCK_${index}%%`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINECODE_${index}%%`;
  });

  // Escape the rest
  result = escapeHtml(result);

  // Basic markdown → HTML conversions.
  // Keep this intentionally minimal because Telegram's HTML parser is strict.
  // (Malformed nesting causes: "can't parse entities: Unmatched end tag ...")
  result = result.replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");
  result = result.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");

  // Bullets
  result = result.replace(/^(?:- |\* )/gm, "• ");

  // Restore code placeholders (use regex so we don't depend on exact placeholder formatting)
  result = result.replace(/%%CODEBLOCK_?(\d+)%%/g, (_m, i: string) => {
    const index = Number(i);
    return Number.isFinite(index) && codeBlocks[index] ? codeBlocks[index] : _m;
  });
  result = result.replace(/%%INLINECODE_?(\d+)%%/g, (_m, i: string) => {
    const index = Number(i);
    return Number.isFinite(index) && inlineCodes[index] ? inlineCodes[index] : _m;
  });

  return result.trim();
}
