// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "./types.js";

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: JsonObject, overrides: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue;

    const baseValue = base[key];

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

export function loadJsonFile(path: string, ctx: ExtensionContext | undefined): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx?.ui.notify(`Failed to read settings: ${path} (${message})`, "warning");
    return {};
  }
}

export function getAgentDir(): string {
  // pi uses ~/.pi/agent by default. If overridden, it's via PI_CODING_AGENT_DIR.
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function loadMergedSettings(
  cwd: string,
  ctx: ExtensionContext | undefined,
): {
  settings: JsonObject;
  globalSettingsPath: string;
  projectSettingsPath: string;
} {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  const globalSettings = loadJsonFile(globalSettingsPath, ctx);
  const projectSettings = loadJsonFile(projectSettingsPath, ctx);

  return {
    settings: deepMerge(globalSettings, projectSettings),
    globalSettingsPath,
    projectSettingsPath,
  };
}

/** Fallback for string settings that default to empty (no value configured). */
export const EMPTY_SETTING_FALLBACK = "";

export function getSetting<T>(settings: JsonObject, path: string, fallback: T): T {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = settings;

  for (const part of parts) {
    if (!isPlainObject(current)) return fallback;
    current = current[part];
  }

  return (current as T) ?? fallback;
}

/** Parse a human-readable delay string ("30s", "1m", "90s") or number (ms) into milliseconds. */
export function parseDelayMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    const secondsMatch = trimmed.match(/^(\d+(?:\.\d+)?)s$/);
    if (secondsMatch) return Math.round(Number(secondsMatch[1]) * 1000);
    const minutesMatch = trimmed.match(/^(\d+(?:\.\d+)?)m$/);
    if (minutesMatch) return Math.round(Number(minutesMatch[1]) * 60_000);
    const bareNumber = Number(trimmed);
    if (Number.isFinite(bareNumber) && bareNumber >= 0) return bareNumber;
  }
  return fallbackMs;
}
