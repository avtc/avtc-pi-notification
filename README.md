# avtc-pi-notification

Bell and Telegram notifications on agent completion, errors, or attention needed — only fires when you're away; inter-extension attention API included.

## Features

- **Two independent channels** — terminal bell and Telegram, each with its own configurable delay timer
- **Smart cancellation** — both timers cancel on keypress, terminal focus, or the agent continuing
- **Inter-extension attention API** — extensions blocking on user input (e.g. `avtc-pi-ask-user-question`) can request attention, which fires these same delayed notifications
- **Environment variable support** — Telegram token and chat ID can be provided via env vars instead of settings
- **Force IPv4** — enabled by default to avoid WSL2 IPv6 connectivity issues
- **Retry on transient errors** — Telegram sends retry with exponential backoff (configurable max attempts, base delay, and delay cap); 4xx errors fail fast

## Installation

```bash
pi install npm:avtc-pi-notification
```

## Configuration

Settings live in `~/.pi/agent/settings.json` under the `"avtc-pi-notifications"` key. Project-level overrides go in `<project>/.pi/settings.json` and win over global settings.

The agent directory can be customized via the `PI_CODING_AGENT_DIR` environment variable (defaults to `~/.pi/agent`).

### Settings reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `bell` | boolean | `true` | Enable/disable terminal bell |
| `bellDelay` | string | `"30s"` | Delay before bell fires (e.g., "30s", "1m") |
| `bellCommand` | string | *(none)* | Optional command to run with bell (useful on Windows/WSL2 + Alacritty) |
| `bellCommandTimeoutMs` | number | `1500` | Timeout for bell command execution |
| `telegram.enabled` | boolean | `false` | Enable/disable Telegram notifications |
| `telegram.token` | string | *(none)* | Telegram Bot API token (or use `TELEGRAM_BOT_TOKEN` / `PI_TELEGRAM_TOKEN` env vars) |
| `telegram.chatId` | string \| number | *(none)* | Telegram chat ID (or use `TELEGRAM_CHAT_ID` / `PI_TELEGRAM_CHAT_ID` env vars) |
| `telegram.delay` | string | `"2m"` | Delay before Telegram fires (e.g., "2m", "120s") |
| `telegram.timeoutMs` | number | `5000` | HTTP request timeout for Telegram API calls |
| `telegram.forceIpv4` | boolean | `true` | Force IPv4 for Telegram API calls (avoids WSL2 IPv6 issues) |
| `telegram.maxRetries` | number | `3` | Max retry attempts on transient errors (network, timeout, 5xx, 429) |
| `telegram.retryBackoffMs` | number | `10000` | Base delay (ms) for exponential backoff between retries (delay = base × 2^attempt) |
| `telegram.maxRetryIntervalMs` | number | `180000` | Upper bound (ms) on exponential backoff between retries (caps growth; Telegram 429 retry_after still honored) |
| `telegram.includePrompt` | boolean | `false` | Include the first user prompt in the Telegram message |
| `telegram.includeToolErrors` | boolean | `true` | Include up to 3 recent tool errors in the message |
| `telegram.includeLeaf` | boolean | `false` | Include subagent leaf ID in the message |
| `telegram.includeStarted` | boolean | `false` | Include session start timestamp in the message |

### Minimal Telegram config

```json
{
  "avtc-pi-notifications": {
    "telegram": {
      "enabled": true,
      "token": "123456:ABCDEF...",
      "chatId": "123456789"
    }
  }
}
```

### Optional bell + Windows sound

```json
{
  "avtc-pi-notifications": {
    "bell": true,
    "bellDelay": "30s",
    "bellCommand": "powershell.exe -NoProfile -Command \"[System.Media.SystemSounds]::Asterisk.Play()\"",
    "bellCommandTimeoutMs": 1500
  }
}
```

## How delays work

When the agent finishes its run — after any automatic retry or context compaction has completed — or when attention is needed, both timers start and run independently:

1. **Bell** fires at 30s — you may be in another window; the bell brings you back.
2. **Telegram** fires at 2m — you're truly away from the computer.

Either timer is cancelled if you press a key, focus the terminal, or the agent continues.

The timers also start after a manual context compaction (`/compact`) run while the agent is idle, so you're notified if you walk away during summarization. A follow-up message or steer cancels it.

## Commands

| Command | Description |
|---------|-------------|
| `/notification:notify` | Send a test notification (bell + Telegram if configured) |
| `/notification:notify debug` | Show effective config and run Telegram `getMe` to verify credentials |

## Inter-extension API

If your extension blocks on user input (permission dialogs, question prompts, etc.), it can request attention so the user gets notified while away. Integration is three steps:

1. **Copy the snippet** — vendor [`src/snippets/canonical/subscribe-to-notifications.ts`](./src/snippets/canonical/subscribe-to-notifications.ts) into your extension (e.g. `src/snippets/vendored/subscribe-to-notifications.ts`).
2. **Register it** in your entry point:

   ```typescript
   import { subscribeToNotificationApi, withAttention } from "./snippets/vendored/subscribe-to-notifications.js";

   export default function (pi: ExtensionAPI) {
     subscribeToNotificationApi(pi);
     // ...
   }
   ```

3. **Wrap any blocking UI call** with `withAttention(source, detail, fn)` — it requests attention on entry and cancels on completion or error. If `pi-notification` isn't installed, it's a transparent no-op:

   ```typescript
   const choice = await withAttention("my-extension", "branch selection", () =>
     ctx.ui.select("Select a branch:", branches)
   );
   ```

## Security

Telegram bot tokens are sensitive. Prefer env vars if you don't want tokens persisted in plaintext settings files. Four env vars are supported:

| Env var | Purpose |
|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `PI_TELEGRAM_TOKEN` | Alternative Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |
| `PI_TELEGRAM_CHAT_ID` | Alternative Telegram chat ID |

The `PI_*` variants are provided for environments where the shorter names conflict with other tools.

## Full suite

Check out the full suite of related extensions, [avtc-pi](https://github.com/avtc/avtc-pi) — deterministic feature development, subagent delegation, working-memory, behavioral learning, parallel-work guardrails, durable decisions, notifications, and more.

Developed with [Z.ai](https://z.ai/subscribe?ic=N5IV4LLOOV) — get 10% off your subscription via this referral link.

## Attribution

An evolution of [lsj5031/pi-notification-extension](https://github.com/lsj5031/pi-notification-extension).

## License

MIT
