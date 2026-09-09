# openai-computer

Unofficial Claude Code bridge for an already-installed OpenAI computer-use CUA runtime (native macOS apps plus browsers). Not affiliated with, endorsed by, or distributed by OpenAI or Anthropic.

> Security note: this is highly privileged desktop automation. Installing the skill also installs an auto-discovered Claude Code plugin and local MCP server that can observe and operate your entire macOS desktop: every app window, keystroke target, and authenticated session. Review the source and `SECURITY.md` before installing.

## Prerequisites

- macOS with Node.js 22.20 or newer.
- Current Claude Code.
- A separately installed and initialized ChatGPT/Codex desktop runtime, which provides the signed `node_repl` binary and the `@oai/sky/service` native backend.
- The OpenAI native-host registry, normally `~/.codex/chrome-native-hosts-v2.json` or under `$CODEX_HOME`.

Compatibility currently targets the production v2 registry/protocol and may break when the separately installed OpenAI runtime changes.

## Installation

```bash
npx skills add gettalon/openai-computer
```

Recommended explicit global install for Claude Code:

```bash
npx skills add gettalon/openai-computer -g -a claude-code --skill openai-computer
```

Then restart Claude Code or reload plugins and confirm `openai-computer@skills-dir` is visible. What gets installed is the self-contained `skills/openai-computer/` bundle, including `SKILL.md`, `.claude-plugin/plugin.json`, `.mcp.json`, and `scripts/`.

## Usage

Ask for computer use explicitly, for example:

- "Use computer use to open Finder and screenshot the window."
- "Use OpenAI computer to check the app state, read only."
- "Use computer use to click through the signup flow, asking before every submit."

Prefer the `openai-chrome` skill for browser-only tasks. Read-only inspection does not require confirmation. Operating unnamed apps, typing outside the browser, changing settings, deleting data, posting, purchasing, changing credentials/permissions, transmitting sensitive data, CAPTCHAs, installs, medical actions, and system/security changes require explicit action-time confirmation.

## Architecture

1. The Skills CLI copies `skills/openai-computer/` into the agent skill directory.
2. Claude Code discovers the installed `.claude-plugin/plugin.json` as `openai-computer@skills-dir`.
3. `.mcp.json` starts the local `scripts/proxy-server.mjs` MCP server.
4. `runtime-resolver.mjs` reads the existing OpenAI native-host registry.
5. `child-mcp.mjs` launches OpenAI's official signed `unified-computer-use/scripts/launch.mjs` with both `browser` and `computer` surfaces enabled. This launcher initializes the native Sky service correctly.
6. No second model or `codex exec` is used.

The computer surface unlocks only at `node_repl` spawn time. Running `setupCUA({ computer: true })` in-session does not enable `cua.getApp`; the wrapper sets the banner and trusted services before spawn instead.

## Data and privacy

This repository adds no telemetry. Desktop and browser data remains subject to Claude Code, the local bridge, the installed OpenAI runtime, apps, and visited websites. The repository does not contain or upload app contents, browser profiles, registry contents, or runtime code.

## Troubleshooting and diagnostic probe

Run the read-only installed probe if computer use cannot connect:

```sh
node ~/.claude/skills/openai-computer/scripts/probe.mjs
```

It reports compatibility versions and verifies `cua.getApp`/`listApps`/`getBrowser` are all functions, without approving any mutations. Ensure the ChatGPT/Codex app is running. Never patch sockets, extensions, manifests, signing, or permissions.

## Development and offline validation

```bash
npm ci
npm test
npx --no-install claude plugin validate ./skills/openai-computer --strict
npx --no-install skills add . --list
```

The live probe and `tests/proxy-live.py` are opt-in and require the installed OpenAI runtime:

```bash
npm run probe
npm run test:live
```

## Uninstall

```bash
npx skills remove openai-computer
```
