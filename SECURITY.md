# Security policy

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** flow in the Security tab of this repository. Do not open a public issue for a vulnerability until a fix or coordinated disclosure is ready.

Never include Telegram tokens, capability tokens, private keys, personal Telegram identifiers, workspace contents, authorization headers, QR payloads, or raw private logs in an issue. If a Telegram token may have been exposed, revoke it immediately through BotFather and replace it in the desktop app.

## Supported release

Security fixes are provided for the newest published preview only. `v1.2.0-preview.1` is an evaluation release: the macOS DMG is ad-hoc signed and not notarized, while the Android APK is debug-signed.

## Security boundaries

- Desktop services bind only to loopback and require high-entropy capabilities.
- Telegram requires the exact configured private user and chat identity.
- Daily VS Code and global extensions are read-only inputs; Pocket uses an isolated profile.
- Mobile pairing is short-lived and single-use. The Telegram token never leaves the computer.
- Mobile application frames are end-to-end encrypted and replay protected.
- The relay stores no prompt, output, workspace path, approval content, or task history and does not queue offline commands.
- Hash, ownership, routing, or readiness mismatch fails closed.

No preview binary should be trusted unless its SHA-256 matches the checksum in the same GitHub release.
