# Security Policy

## Scope

This project is an unofficial local bridge for a separately installed OpenAI computer-use runtime. It exposes privileged desktop automation to Claude Code and can operate native apps and authenticated browser tabs with the user's authority.

## Threat model

Treat the skill, MCP server, app state, browser state, and visited pages as security-sensitive. Prompt injection in app content or a webpage can attempt to influence an agent. A compromised local user account or tampered native-host registry can also affect the bridge. The bridge does not replace the native host's signing, origin, transfer, or authorization checks.

The skill intentionally prohibits cookie, password, profile, session-store, and local-storage inspection; raw CDP or direct socket access; arbitrary page evaluation; clipboard exfiltration; browsing-history access; extension or native-host patching; and security-control bypasses. Operating unnamed apps, typing outside the browser, and changing settings require explicit confirmation. These are behavioral safeguards, not a hard sandbox around desktop control.

## Reporting

Please use GitHub's private vulnerability reporting or security advisory flow when available. Do not include credentials, registry files, app screenshots, profile contents, authenticated URLs, or other sensitive data in public issues.

## Supported versions

Only the latest published version is supported. Compatibility depends on the separately installed OpenAI runtime and its production v2 registry/protocol.

## Non-goals

This project does not bypass native-host signing, OS permission checks, browser origin checks, Chrome security controls, paywalls, CAPTCHAs, permissions, or runtime authorization.
