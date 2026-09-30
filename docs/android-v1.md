# Android preview: pairing and remote control

The Android preview supports Android 10 / API 29 and later on ARM64 devices. It does not ask for a Telegram bot token or numeric Telegram ID.

## Install

1. Download `VSCode-Codex-Remote-Control-1.2.2-android-arm64-debug.apk` and `SHA256SUMS.txt` from the same GitHub release.
2. Verify the APK SHA-256.
3. Allow installation from the browser or file manager you used, then install the APK.
4. This preview is debug-signed. A future production-signed build can require uninstalling this preview first.

## Pair with your Mac

1. Make sure the Mac desktop app reports READY and Telegram setup is complete.
2. Open **Pair phone** on the Mac. A single-use QR code appears for five minutes.
3. Open the Android app and scan the QR.
4. Select **Verify with Telegram**. Telegram opens your already configured bot with a one-time code.
5. Send the prepared message from the same private Telegram identity configured on the Mac.
6. Return to Android. The connection screen changes to connected after verification.

The QR contains the relay address, an expiring claim, the desktop public key, and bot username. It never contains the Telegram bot token. Pairing a new phone revokes the previous phone.

## Mobile controls

- View computer, Pocket runtime, Telegram, and profile status.
- Browse the Mac's allowed workspace roots and select a workspace.
- Select an existing conversation or create a new conversation.
- Choose a model and reasoning level reported by the connected App Server.
- Send prompts and view paragraph-preserving live output or late-join output.
- Approve/Deny exact pending requests, Stop an active turn, view recent history, and run a read-only update check.

The relay does not queue commands. When the Mac is offline, the app reports it and the command is not silently executed later. Browser screenshot/URL is intentionally unavailable in this preview.

## Notifications

Foreground control works without Firebase. Background notifications for task completion and approval require a production Firebase configuration. If this prerelease was built without it, no background push notification is expected. Push payloads contain only a generic event name, not prompt or output content.

## For developers

```sh
cd apps/codex_pocket_ui
flutter pub get
flutter analyze
flutter test
flutter build apk --debug --target-platform android-arm64
```

For a production-signed APK, provide an ignored `android/key.properties` and private keystore. The repository never contains signing or Firebase service-account secrets.
