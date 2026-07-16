// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { assembleAndTrim, escapeHtml, formatToTelegramHtml, htmlAwareSlice, truncateText } from "./format.js";
import { getSetting, isPlainObject } from "./settings.js";
import type { JsonObject, SessionSnapshot } from "./types.js";

/** Default: include prompt in Telegram messages */
const INCLUDE_PROMPT_DEFAULT = false;
/** Default: include tool errors in Telegram messages */
const INCLUDE_TOOL_ERRORS_DEFAULT = true;
/** Default: include leaf message in Telegram messages */
const INCLUDE_LEAF_DEFAULT = false;
/** Default: include started notification in Telegram messages */
const INCLUDE_STARTED_DEFAULT = false;

/**
 * Compute the character budget for the final answer block, after reserving what the
 * fixed + variable sections already consume plus a margin for separators/truncation.
 * Shared by the HTML and plain Telegram message builders (identical numeric logic).
 */
export function computeAnswerBudget(fixedLines: string[], variableLines: string[], maxLen: number): number {
  const fixedLen = fixedLines.join("\n").length;
  const variableBeforeAnswer = variableLines.join("\n").length;
  const separatorsAndSuffix = 50; // newlines + "...(truncated)" suffix margin
  return Math.max(200, maxLen - fixedLen - variableBeforeAnswer - separatorsAndSuffix);
}

/**
 * Per-section formatting strategy for the optional message blocks. The HTML and plain
 * Telegram builders share identical section/budget logic but differ in how each
 * line is rendered, so they pass their own MessageFormatter.
 */
export interface MessageFormatter {
  /** Render a section heading, e.g. "Prompt" -> "<b>Prompt</b>" or "Prompt". */
  heading: (text: string) => string;
  /** Render inline text content, e.g. a prompt or error body. */
  inline: (text: string) => string;
  /** Render a single tool-error line given the tool name and error text. */
  toolError: (tool: string, text: string) => string;
}

/** Shared context for building the optional Prompt/Tool-errors/Error sections. */
export interface OptionalSectionInput {
  includePrompt: boolean;
  firstUser: unknown;
  toolErrors: { tool: string; text: string }[];
  modelError: string | null | undefined;
  maxLen: number;
}

/**
 * Push the optional Prompt / Tool errors / Error sections into variableLines, respecting
 * the same iterative budget in both HTML and plain builders. Lines are rendered via fmt.
 */
export function pushOptionalSections(
  variableLines: string[],
  fixedLines: string[],
  input: OptionalSectionInput,
  fmt: MessageFormatter,
): void {
  if (input.includePrompt && input.firstUser) {
    const promptRaw = extractText(input.firstUser);
    // Budget: measure what we have so far, give prompt up to 900 chars
    const usedSoFar = fixedLines.join("\n").length + variableLines.join("\n").length + 4; // 4 = "\n\n" separators
    const promptBudget = Math.min(900, input.maxLen - usedSoFar - 300); // 300 reserve for answer header
    if (promptBudget > 50) {
      const prompt = truncateText(promptRaw, promptBudget);
      variableLines.push("", fmt.heading("Prompt"), fmt.inline(prompt));
    }
  }

  if (input.toolErrors.length > 0) {
    variableLines.push("", fmt.heading("Tool errors"));
    for (const err of input.toolErrors) {
      variableLines.push(fmt.toolError(err.tool, err.text));
    }
  }

  if (input.modelError) {
    variableLines.push("", fmt.heading("Error"), fmt.inline(truncateText(input.modelError, 800)));
  }
}

export function extractText(message: unknown): string {
  if (!isPlainObject(message)) return "";

  const content = message.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) parts.push(t);
      }
    }
    return parts.join("\n").trim();
  }

  return "";
}

export function findFirstByRole(messages: unknown[], role: string): JsonObject | undefined {
  for (const msg of messages) {
    if (isPlainObject(msg) && msg.role === role) return msg;
  }
  return undefined;
}

export function findLastByRole(messages: unknown[], role: string): JsonObject | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isPlainObject(msg) && msg.role === role) return msg;
  }
  return undefined;
}

export function collectToolErrors(messages: unknown[], maxItems: number): Array<{ tool: string; text: string }> {
  const errors: Array<{ tool: string; text: string }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg)) continue;
    if (msg.role !== "toolResult") continue;
    if (msg.isError !== true) continue;

    const tool = typeof msg.toolName === "string" ? msg.toolName : "(unknown)";
    const text = truncateText(extractText(msg), 300);

    errors.push({ tool, text });
    if (errors.length >= maxItems) break;
  }

  return errors.reverse();
}

/** Extract model API error from the last assistant message (rate limits, provider errors, etc.). */
export function extractModelError(messages: unknown[]): string | null {
  const lastAssistant = findLastByRole(messages, "assistant");
  if (!lastAssistant) return null;
  if (lastAssistant.stopReason !== "error") return null;
  const err = lastAssistant.errorMessage;
  if (typeof err === "string" && err.trim()) return err.trim();
  return null;
}

/** Shared preamble extracted by both HTML and plain Telegram message builders. */
interface TelegramContext {
  header: SessionSnapshot["sessionHeader"];
  sessionId: string | undefined;
  sessionIdShort: string;
  leafId: SessionSnapshot["leafId"];
  includePrompt: boolean;
  includeToolErrors: boolean;
  includeLeaf: boolean;
  includeStarted: boolean;
  firstUser: JsonObject | undefined;
  lastAssistant: JsonObject | undefined;
  answerRaw: string;
  toolErrors: Array<{ tool: string; text: string }>;
  modelError: string | null;
}

/** Collect the shared context (snapshot/header fields, settings reads, message scanning) used by both Telegram builders. */
function collectTelegramContext(snapshot: SessionSnapshot, messages: unknown[], settings: JsonObject): TelegramContext {
  const includePrompt = getSetting(settings, "avtc-pi-notifications.telegram.includePrompt", INCLUDE_PROMPT_DEFAULT);
  const includeToolErrors = getSetting(
    settings,
    "avtc-pi-notifications.telegram.includeToolErrors",
    INCLUDE_TOOL_ERRORS_DEFAULT,
  );
  const includeLeaf = getSetting(settings, "avtc-pi-notifications.telegram.includeLeaf", INCLUDE_LEAF_DEFAULT);
  const includeStarted = getSetting(settings, "avtc-pi-notifications.telegram.includeStarted", INCLUDE_STARTED_DEFAULT);

  const firstUser = includePrompt ? findFirstByRole(messages, "user") : undefined;
  const lastAssistant = findLastByRole(messages, "assistant");

  return {
    header: snapshot.sessionHeader,
    sessionId: snapshot.sessionId,
    sessionIdShort: snapshot.sessionId ? snapshot.sessionId.slice(0, 8) : "",
    leafId: snapshot.leafId,
    includePrompt,
    includeToolErrors,
    includeLeaf,
    includeStarted,
    firstUser,
    lastAssistant,
    answerRaw: lastAssistant ? extractText(lastAssistant) : "",
    toolErrors: includeToolErrors ? collectToolErrors(messages, 3) : [],
    modelError: extractModelError(messages),
  };
}

export function buildTelegramMessage(
  snapshot: SessionSnapshot,
  messages: unknown[],
  settings: JsonObject,
  maxLen: number,
): string {
  // jscpd:ignore-start — signature + shared context wiring are intentionally parallel to buildTelegramPlainMessage (HTML vs plain variants of the same message; both delegate to collectTelegramContext)
  const ctx = collectTelegramContext(snapshot, messages, settings);
  const {
    header,
    sessionIdShort,
    leafId,
    includePrompt,
    includeLeaf,
    includeStarted,
    firstUser,
    answerRaw,
    toolErrors,
    modelError,
  } = ctx;
  // jscpd:ignore-end

  // --- Build fixed header lines (already HTML) ---
  const fixedLines: string[] = [];
  const headerLabel = modelError ? "<b>Pi encountered an error</b>" : "<b>Pi is ready</b>";
  fixedLines.push(`${headerLabel}${sessionIdShort ? ` • <code>${escapeHtml(sessionIdShort)}</code>` : ""}`);
  fixedLines.push(`cwd: <code>${escapeHtml(snapshot.cwd)}</code>`);
  if (includeLeaf && leafId) fixedLines.push(`leaf: <code>${escapeHtml(String(leafId))}</code>`);
  if (includeStarted && header?.timestamp) fixedLines.push(`started: <code>${escapeHtml(header.timestamp)}</code>`);

  // --- Build optional sections with iterative budget ---
  const variableLines: string[] = [];

  pushOptionalSections(
    variableLines,
    fixedLines,
    { includePrompt, firstUser, toolErrors, modelError, maxLen },
    {
      heading: (t) => `<b>${t}</b>`,
      inline: (t) => formatToTelegramHtml(t),
      toolError: (tool, text) => `<b>${escapeHtml(tool)}</b>: ${formatToTelegramHtml(text)}`,
    },
  );

  // --- Answer: gets whatever budget is left ---
  variableLines.push("", "<b>Last answer</b>");

  const answerBudget = computeAnswerBudget(fixedLines, variableLines, maxLen);

  const answer = truncateText(answerRaw || "(no assistant output)", answerBudget);
  variableLines.push(formatToTelegramHtml(answer));

  // --- Assemble with HTML-aware final trim ---
  return assembleAndTrim([...fixedLines, ...variableLines], maxLen);
}

export function buildTelegramPlainMessage(
  snapshot: SessionSnapshot,
  messages: unknown[],
  settings: JsonObject,
  maxLen: number,
): string {
  // jscpd:ignore-start — signature + shared context wiring are intentionally parallel to buildTelegramMessage (HTML vs plain variants of the same message; both delegate to collectTelegramContext)
  const ctx = collectTelegramContext(snapshot, messages, settings);
  const {
    header,
    sessionIdShort,
    leafId,
    includePrompt,
    includeLeaf,
    includeStarted,
    firstUser,
    answerRaw,
    toolErrors,
    modelError,
  } = ctx;
  // jscpd:ignore-end

  // --- Build fixed header lines ---
  const fixedLines: string[] = [];
  const headerLabel = modelError ? "Pi encountered an error" : "Pi is ready";
  fixedLines.push(`${headerLabel}${sessionIdShort ? ` • ${sessionIdShort}` : ""}`);
  fixedLines.push(`cwd: ${snapshot.cwd}`);
  if (includeLeaf && leafId) fixedLines.push(`leaf: ${String(leafId)}`);
  if (includeStarted && header?.timestamp) fixedLines.push(`started: ${header.timestamp}`);

  // --- Build optional sections with iterative budget ---
  const variableLines: string[] = [];

  pushOptionalSections(
    variableLines,
    fixedLines,
    { includePrompt, firstUser, toolErrors, modelError, maxLen },
    {
      heading: (t) => t,
      inline: (t) => t,
      toolError: (tool, text) => `${tool}: ${text}`,
    },
  );

  // --- Answer: gets whatever budget is left ---
  variableLines.push("", "Last answer");

  const answerBudget = computeAnswerBudget(fixedLines, variableLines, maxLen);

  const answer = truncateText(answerRaw || "(no assistant output)", answerBudget);
  variableLines.push(answer);

  // --- Assemble with plain-text final trim ---
  const joined = [...fixedLines, ...variableLines].join("\n").trim();
  if (joined.length <= maxLen) return joined;
  return `${joined.slice(0, maxLen - 20).trimEnd()}\n...(truncated)`;
}

/** Clamp an HTML/plain message pair to maxLen, appending a truncation marker when over. */
function clampHtmlTextToMaxLen(html: string, text: string, maxLen: number): { html: string; text: string } {
  return {
    html: html.length <= maxLen ? html : `${htmlAwareSlice(html, maxLen - 20)}\n...(truncated)`,
    text: text.length <= maxLen ? text : `${text.slice(0, maxLen - 20).trimEnd()}\n...(truncated)`,
  };
}

/** Build attention notification messages (HTML + plain text) with smart truncation. */
export function buildTelegramAttentionMessage(
  snapshot: SessionSnapshot,
  _source: string,
  detail: string | undefined,
  maxLen: number,
): { html: string; text: string } {
  const sessionIdShort = snapshot.sessionId ? snapshot.sessionId.slice(0, 8) : "";

  // Parse detail: "label • feature • lastMessage" or just "label"
  const detailParts = detail ? detail.split(" • ") : [];
  const label = detailParts[0] || "";
  const feature = detailParts[1] || "";
  const lastMessage = detailParts.slice(2).join(" • ") || "";

  // --- HTML version ---
  const htmlFixed = `<b>Pi needs attention</b>${sessionIdShort ? ` • <code>${escapeHtml(sessionIdShort)}</code>` : ""}${label ? ` • <code>${escapeHtml(label)}</code>` : ""}`;
  const htmlCwd = `\ncwd: <code>${escapeHtml(snapshot.cwd)}</code>`;
  const htmlFeature = feature ? `\nfeature: <code>${escapeHtml(feature)}</code>` : "";
  // Measure fixed part for lastMessage budget
  const fixedHtml = htmlFixed + htmlCwd + htmlFeature;
  const fixedHtmlLen = fixedHtml.length;
  const lastMsgBudget = Math.max(0, maxLen - fixedHtmlLen - 20);
  const htmlLastMsg =
    lastMessage && lastMsgBudget > 50 ? `\n${formatToTelegramHtml(truncateText(lastMessage, lastMsgBudget))}` : "";
  const html = fixedHtml + htmlLastMsg;

  // --- Plain text version ---
  const textFixed = `Pi needs attention${sessionIdShort ? ` • ${sessionIdShort}` : ""}${label ? ` • ${label}` : ""}`;
  const textCwd = `\ncwd: ${snapshot.cwd}`;
  const textFeature = feature ? `\nfeature: ${feature}` : "";
  const fixedText = textFixed + textCwd + textFeature;
  const fixedTextLen = fixedText.length;
  const lastMsgBudgetText = Math.max(0, maxLen - fixedTextLen - 20);
  const textLastMsg = lastMessage && lastMsgBudgetText > 50 ? `\n${truncateText(lastMessage, lastMsgBudgetText)}` : "";
  const text = fixedText + textLastMsg;

  return clampHtmlTextToMaxLen(html, text, maxLen);
}

/**
 * Build a Telegram message for a completed context compaction (no agent run — the user ran
 * `/compact` while idle). Mirrors the attention message shape but with a "compacted" header.
 */
export function buildTelegramCompactMessage(
  snapshot: SessionSnapshot,
  maxLen: number,
): {
  html: string;
  text: string;
} {
  const sessionIdShort = snapshot.sessionId ? snapshot.sessionId.slice(0, 8) : "";

  const html = `<b>Context compacted</b>${sessionIdShort ? ` • <code>${escapeHtml(sessionIdShort)}</code>` : ""} — ready to continue\ncwd: <code>${escapeHtml(snapshot.cwd)}</code>`;
  const text = `Context compacted${sessionIdShort ? ` • ${sessionIdShort}` : ""} — ready to continue\ncwd: ${snapshot.cwd}`;

  return clampHtmlTextToMaxLen(html, text, maxLen);
}
