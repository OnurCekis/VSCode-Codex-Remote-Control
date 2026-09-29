# macOS installation and first run

This preview supports Apple Silicon Macs (M1 or newer). The app bundles the Pocket host and starts its isolated, verified VS Code/Codex runtime. End users do not need Terminal or developer tools.

## Install

1. Download `VSCode-Codex-Remote-Control-1.2.0-macos-arm64-unsigned.dmg` and `SHA256SUMS.txt` from the same GitHub release.
2. Verify the DMG SHA-256.
3. Open the DMG and drag **VS Code Codex Remote Control.app** to **Applications**.
4. Open it from Applications.
5. This preview is ad-hoc signed and not notarized. If macOS blocks it, continue only after the checksum matches, then allow it under **System Settings → Privacy & Security**.

The internal bundle identifier and `~/Library/Application Support/Codex Pocket` data directory intentionally retain their historical names so existing pairings remain valid.

## Create and verify your Telegram bot

The control screen stays locked until setup succeeds.

1. Select **Open BotFather** in the app.
2. Send `/newbot` to BotFather and follow Telegram's instructions.
3. Paste the HTTP API token into the protected token field.
4. Select **Open my bot**, then send `/start` in the private chat with your bot.
5. Return to the desktop app and select **Find my ID**.
6. Select **Test connection and save**. The app verifies the bot, the private Telegram identity, and a real callback message before starting Pocket.

The token is not shown again, logged, placed in a QR code, or sent to the relay. If it may have been exposed, revoke it in BotFather and repeat setup with the replacement token.

## Use the desktop app

- **Open Project** opens a native folder picker and opens or reuses that workspace.
- Select a workspace and conversation, or create a new conversation.
- Choose a model and reasoning level from values reported by the running App Server.
- Send prompts, watch canonical live output, Approve/Deny exact requests, or Stop the active turn.
- **Pair phone** creates a five-minute, single-use QR code for Android.
- **Updates** performs a read-only version check in this preview.

Daily VS Code and global extensions are never modified. Browser screenshot/URL controls stay unavailable until the Windows browser acceptance gate is complete.

## Troubleshooting

- Initial runtime preparation may take several minutes. Keep the app open.
- If **Find my ID** fails, send a fresh `/start` to your own bot in a private chat; group messages are rejected.
- If READY fails, restart the app once. Do not paste private logs or credentials into a public issue.
- For security reports, follow [SECURITY.md](../SECURITY.md).
