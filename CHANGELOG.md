# Changelog

All notable changes to this project are documented here.

## [1.2.2-preview.1] - 2026-09-30

### Fixed

- Improved Android pairing recovery and reconnect behavior after temporary relay or desktop disconnects.
- Serialized encrypted relay frame handling so out-of-order async decryption cannot break the mobile secure-channel sequence.
- Added a first-run welcome screen; the camera now opens only after the user taps the QR pairing button.
- QR pairing opens the Telegram bot's `/start` deep link; users do not need to type `/pair` manually (Telegram may require tapping Start once).

## [1.2.1-preview.1] - 2026-09-29

### Changed

- Added an in-app English/Turkish language selector across first-run setup, desktop controls, Android pairing, and Android remote-control screens.
- Replaced public screenshots with English captures generated exclusively from synthetic demo data.
- Added localization and screenshot-generation regression coverage.

## [1.2.0-preview.1] - 2026-09-28

Initial public developer preview.

### Included

- Apple Silicon macOS desktop application with in-app Telegram setup.
- Isolated pinned VS Code/Codex runtime, shared authenticated App Server, workspace reuse, multi-workspace routing, and profile sync.
- Telegram commands, paragraph-preserving live output, late join, approval, Stop, history, and read-only update checks.
- Android 10+ ARM64 application with single-use QR pairing, Telegram identity proof, encrypted remote controls, new conversation, model/reasoning selection, and offline/reconnect behavior.
- Cloudflare Worker + Durable Object opaque relay with per-IP connection rate limiting and 30-day inactive metadata cleanup.

### Known limitations

- Windows browser Gate 2 acceptance is pending.
- Browser screenshot and current URL are unavailable.
- iOS is not supported.
- macOS is ad-hoc signed and not notarized.
- Android is debug-signed; a future production-signed app can require reinstalling.
- Background push is unavailable in builds without production Firebase configuration.
