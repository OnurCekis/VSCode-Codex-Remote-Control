# Flutter presentation layer

VS Code Codex Remote Control's Flutter application is a presentation client. It does not implement sessions, conversations, routing, tasks, approvals, live output, Telegram authorization, or runtime control in Dart. Those remain owned by the existing TypeScript Core.

```text
Flutter macOS / responsive mobile layout
                 │ authenticated HTTP + SSE
                 │ 127.0.0.1, dynamic port, capability token
                 ▼
          Pocket UI bridge
                 │ bounded application operations
                 ▼
      existing TypeScript Pocket Core
                 │
        shared Codex App Server
```

The bridge writes its endpoint and high-entropy capability token to `.codex-pocket/ui-bridge/connection.json` with owner-only permissions. It binds only to IPv4 loopback, rejects non-local and unauthenticated requests, caps request bodies, does not enable browser CORS, and exposes only status, workspace open, conversation select, task send/stop, approval/deny, pairing, and canonical live-output events. There is no raw JSON-RPC or shell endpoint. Tokens are not returned by application routes or printed in logs.

Run the already-started Pocket host, then start the bridge and UI from the repository root:

```sh
npm run ui:bridge
cd apps/codex_pocket_ui
flutter run -d macos --dart-define=POCKET_ROOT=/absolute/path/to/Codex-Pocket
```

The desktop window shows the real host, Codex/App Server, Telegram, version, profile, workspace, conversation, preview, live output, approvals, Stop control and Open Project flow. Browser state is intentionally shown as unavailable until the real Windows Gate 2 is accepted and BrowserManager is production-wired.

Pairing uses a short-lived, single-use code stored only as a SHA-256 digest. The bot accepts `/pair CODE` only from a real private Telegram chat whose user and chat identifiers match. A successful pairing persists the numeric Telegram identity locally; the BotFather token remains in the ignored owner-only `.env` file and is never printed.

The layout is responsive and the Android project is generated from the same common UI. Android compilation requires a configured Android SDK; no custom remote transport is introduced, so a phone continues to use Telegram for remote control in V1.
