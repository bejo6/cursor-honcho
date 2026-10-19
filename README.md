# cursor-honcho

Persistent memory for [Cursor](https://cursor.com), powered by [Honcho](https://honcho.dev).

Cursor forgets across chats. This plugin gives it memory that does not: how you like to work, what you decided last week, and what you are building. It reads the same `~/.honcho/config.json` as the other Honcho integrations (Hermes, dsh-honcho, and friends), so there is one place to configure all of them — and pointing two hosts at the same `workspace` gives them shared memory.

The memory loop follows **Hermes / dsh-honcho**: every turn is captured, and context is injected again each prompt (TTL refresh + periodic dialectic) — not only once when a session opens.

| Piece | Path | Role |
| --- | --- | --- |
| Rule | `rules/honcho.mdc` | Always-on identity and “do not re-save” guidance |
| Skill | `skills/honcho-status/` | Answer status questions from the injected block |
| Command | `commands/honcho-status.md` | `/honcho-status` in chat |
| Hooks | `hooks/hooks.json` | Capture turns and inject memory via `node ./scripts/honcho.mjs` |

## Requirements

- [Cursor](https://cursor.com) with local plugins / project hooks enabled
- [Node.js](https://nodejs.org/) 20+ on `PATH`
- A Honcho API key ([app.honcho.dev](https://app.honcho.dev) or your self-hosted server)

On self-hosted Honcho, `apiKey` is an HMAC secret: the plugin signs a workspace JWT `{w: workspace}` and sends that token. A raw key is rejected with `Invalid JWT`.

## Install

```sh
git clone <this-repo> cursor-honcho
cd cursor-honcho
npm install
node src/cli.mjs install
```

`install` copies the plugin into `~/.cursor/plugins/local/cursor-honcho`. Symlinks from outside that folder are not loaded by Cursor. Older `cursor-honcho` entries in `~/.cursor/hooks.json` are removed so turns are not saved twice.

Then run **Developer: Reload Window**. In Customize, confirm the `cursor-honcho` rule, skill, and hooks appear.

If your team disables local plugin import, use the fallback instead (do not run both):

```sh
node src/cli.mjs install-hooks
```

## Configuration

All identity and behavior live in `~/.honcho/config.json`. The plugin has no built-in peer or workspace names.

```json
{
  "peerName": "your-name",
  "apiKey": "your-api-key",
  "baseUrl": "https://api.honcho.dev",
  "hosts": {
    "cursor": {
      "workspace": "cursor",
      "aiPeer": "cursor",
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"],
        "perTurn": ["userContext", "dialectic"],
        "contextTokens": 1500,
        "cadence": {
          "dialectic": 5,
          "ttlSeconds": 300
        }
      }
    }
  }
}
```

- Root: shared identity and connection (`peerName`, `apiKey`, `baseUrl`).
- `hosts.cursor` (required): Cursor-only workspace, AI peer, session strategy, capture, and injection.
- Override the config path with `HONCHO_CONFIG_PATH`, or the state directory with `HONCHO_STATE_DIR`.

If `injection` is omitted, defaults match dsh/Hermes: `perTurn: ["userContext", "dialectic"]`, dialectic every 5 turns, context TTL 300 seconds.

Check what the CLI resolves:

```sh
node src/cli.mjs status
```

## How it works

**Capture.** Each user prompt and assistant reply is queued, redacted, and uploaded to Honcho in the background. The queue flushes on `stop`, `preCompact`, and `sessionEnd`.

**Inject.** `beforeSubmitPrompt` returns `additional_context` for the model:

| Turn | Behavior |
| --- | --- |
| First | Wait up to ~5s for `session.context()` (and dialectic when due) |
| Later | Serve the cached block; refresh in the background when the TTL expires |
| Dialectic | Periodic background profile refresh (cadence), not a blocking per-prompt call |

`sessionStart` only bootstraps peers, optional directives, and a warm cache. The reliable inject path is `beforeSubmitPrompt` (also works when Agents Window misses `sessionStart` context).

| Hook | Role |
| --- | --- |
| `sessionStart` | Ensure session/peers, light directives, warm cache |
| `beforeSubmitPrompt` | Queue user message + inject memory |
| `afterAgentResponse` | Queue assistant message |
| `stop` / `preCompact` / `sessionEnd` | Flush the upload queue |

Logs: `~/.honcho/cursor/hook.log`  
Per-chat inject state: `~/.honcho/cursor/memory/`

## Uninstall

```sh
node src/cli.mjs uninstall
```

## Develop

```sh
npm test
```

## License

MIT
