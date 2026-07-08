// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Package entry point for pi (keeps the startup display name clean).
// Re-exports the real factory + the notification API type.

export { default } from "./src/extension.js";
export type { NotificationApi } from "./src/types.js";
