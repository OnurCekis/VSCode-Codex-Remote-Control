# VS Code Codex Remote Control architecture

VS Code Codex Remote Control is layered around an authenticated loopback topology. The topology is a compatibility and security constraint, not an abstraction point to replace casually.

```text
Pinned Codex App Server on authenticated 127.0.0.1 WebSocket
        │
        ├── Deno stdio/WebSocket bridge ── real VS Code Codex extension
        │
        └── WebSocket JSON-RPC peer ── AppServerCodexAdapter
                                         │ normalized CodexEvent
                                         ├── WorkspaceManager
                                         ├── ConversationManager
                                         ├── SessionManager
                                         ├── ApprovalManager
                                         ├── TaskManager
                                         └── LiveOutputManager
                                                  │
                                                  ├── local CLI
                                                  ├── Telegram adapter (grammY long polling)
                                                  └── future desktop/mobile UI
```

## Transport and protocol layer

The existing `apps/ipc-probe/src` transport code owns JSONL framing, JSON-RPC correlation, authenticated WebSocket connections, protocol logging, pinned-binary verification, `/readyz`, loopback listener validation, and App Server process cleanup. `tools/vscode-proxy/main.ts` is the extension-facing stdio bridge.

This layer uses exact App Server method names and generated contracts. It does not contain session selection, user-facing approval IDs, or CLI behavior. Phase 0.6 and Phase 0.7 remain executable regression fixtures for this layer.

## Codex adapter layer

`AppServerCodexAdapter` is the only Phase 1 component that translates raw App Server messages into normalized application events. Its `CodexAdapter` boundary exposes only:

- list and attach to VS Code-owned sessions;
- read a bounded recent-conversation preview without attaching or changing ownership;
- start and interrupt tasks;
- resolve an exact approval request;
- subscribe to normalized events;
- close the Pocket client connection.

Raw names such as `thread/status/changed` and `item/commandExecution/requestApproval` do not escape this layer. The adapter deliberately wraps the proven `JsonRpcPeer` instead of replacing or rewriting it.

## Domain and core layer

The core contains no presentation dependency. Phase 2.2 adds only a small local workspace-state file; conversation, task, and approval runtime state remains in memory.

- `SessionManager` discovers, resolves human titles, reads bounded previews, attaches, selects, and tracks runtime state for VS Code-owned sessions. The exact App Server thread ID remains canonical; titles are presentation metadata and never replace identity at adapter boundaries.
- `WorkspaceManager` canonicalizes Windows directory identity, exposes only Desktop/Documents, conventional development directories and locally configured extra project roots, lists one folder level at a time, and persists the active/recent workspace set in an ignored local JSON file. Whole drive roots, Downloads, UNC shares and system/profile roots are not Telegram browsing roots. Parent navigation and final browsed selection are both constrained by canonical `realpath` containment; locally opened exact workspaces remain usable without exposing their parent tree.
- `ConversationManager` filters global discovery using canonical `thread/list.cwd` metadata and coordinates explicit, fail-closed workspace/thread transitions. It distinguishes persistent list metadata from the runtime CWD returned by attach.
- Conversation runtime topology is evidence-based: `thread/loaded/list` on Pocket's authenticated connection means `sharedLive`; an unloaded rollout is `historical`; and a historical resume rejected by an active writer becomes `foreignActive`. Selecting an idle live thread is observation-only (`thread/read` plus `thread/turns/list`) and never retains a subscription. If the selected thread already has an active exact turn, Core immediately establishes the same temporary detailed subscription used for a newly-started observed turn, obtains an authoritative full-item snapshot, and bootstraps that turn without inventing a new identity. Completion releases the subscription with `thread/unsubscribe`. Approval replay uses the same temporary subscription and retains it only until the decision or active turn finishes. A failed release closes Pocket's App Server connection fail-closed.
- `ApprovalManager` assigns opaque local IDs such as `approval-1`, enforces single-use decisions, and expires approvals on resolution, turn completion, or disconnect.
- `TaskManager` starts a task only on an idle selected session whose runtime CWD matches the active workspace, passes that canonical CWD through the pinned `turn/start.cwd` contract, and interrupts the exact tracked active turn.
- `CodexEvent` is the normalized event vocabulary consumed by managers and presentation adapters.
- `LiveOutputManager` turns normalized task, assistant-delta, authoritative assistant-snapshot, approval, and terminal events into an ordered, transport-independent live-turn stream. Identity is the exact runtime/thread/turn tuple and every event has a monotonic per-turn sequence. `observeActiveTurn` supports a client that opens after the turn began: transport ingress checkpoints reconcile the accumulated item snapshot with only later exact-item deltas, without text-prefix dedupe or a fabricated `turn/started`. A final authoritative snapshot precedes terminal output when the temporary detailed subscription is active. Raw assistant Markdown/text is canonical; active output can be replayed through `subscribeToTurn` and is released after the terminal event has carried the complete text. It contains no Telegram message IDs, formatting, timers, or Bot API state.
- `PocketCore` wires these components together and owns their shutdown order.

## Lifecycle host

The Windows-native lifecycle host owns the exact pinned App Server and isolated VS Code fixture. It writes a short-lived connection descriptor whose ACL grants access only to the current Windows identity. The descriptor contains the capability token, is ignored by Git, is never logged, and is deleted during host shutdown.

The VS Code runtime and extension are separate disposable fixtures under `.codex-pocket/phase-0-7`. Runtime discovery verifies `Code.exe`, `resources/app/out/cli.js`, `product.json`, version, and full commit. Extension discovery uses an isolated `--extensions-dir` and verifies publisher, package version, and the bundled Codex SHA-256. The user's daily VS Code installation and global extensions remain untouched; they are eligible only as copy sources when they already match the exact pins.

The host constructs a clean VS Code child environment instead of forwarding a parent Codex conversation descriptor. All inherited `CODEX_*` values are removed, then only `CODEX_HOME` and the Pocket-owned proxy endpoint, capability token, pinned CLI path, and redacted-log path are installed. This prevents a launch from a Codex terminal from binding the isolated window to the parent's App Server.

`VS Code READY` is a live topology invariant, not a one-time extension initialization flag. The status heartbeat is written only while the exact pinned Code executable is running with the owned profile, the exact proxy executable is alive, that proxy PID has an established connection to the Pocket-owned loopback listener, the extension initialization identity matches the pin, and an authenticated Pocket Client B can call `thread/loaded/list` on the same server. The host fails closed if this evidence disappears, and `main.py` refuses to reuse a stale heartbeat.

The pinned baseline supports multiple isolated VS Code windows on that one App Server. Every window has its own extension host and Pocket proxy process, while all proxies authenticate to the same loopback listener. The host records a workspace runtime only after a new, exact proxy PID initializes and has an established connection to that listener. Its heartbeat reconciles each runtime independently, so closing one window removes only that workspace runtime.

Workspace selection is UI state; it does not own or replace runtime processes. `WorkspaceRuntimeManager` maps a live thread to a runtime using the exact protocol thread ID, `thread/loaded/list`, and the thread's canonical CWD. Telegram can request `Open in Pocket VS Code` through an owner-only file control channel advertised in the connection descriptor. The host validates the canonical directory, refuses duplicate connected runtimes, and launches the pinned Code/extension/profile through the existing proxy topology. `main.py` remains only the supervisor.

`ProfileSyncService` is a filesystem/application service below presentation adapters. It performs a one-way allowlisted daily-to-Pocket merge using staging, rollback and hash state; Pocket-owned Codex/proxy/update settings always win. Its fixed managed transaction root uses versioned ownership journals and lifecycle phases; startup recovers only positively proven abandoned work, while canonical containment, active-profile exclusion and full-tree junction checks make deletion fail closed. `pocket-code`, Telegram and the future desktop UI converge on the same `WorkspaceRuntimeManager` and owner-only runtime-control operation. The host synchronizes before launching a new runtime and publishes structured profile status in its heartbeat. Presentation layers do not copy profiles or spawn App Servers themselves.

The Pocket CLI does not own the host, App Server, or VS Code. Closing or restarting Pocket therefore affects only Client B's authenticated WebSocket connection.

Repository-root `main.py` is a thin process supervisor above this host; it contains no Codex, Telegram, approval, or JSON-RPC application logic. It resolves exact Node `24.19.0`, validates `.env` through the existing TypeScript configuration, reuses only status descriptors whose PID and command line match the expected Codex Pocket entry point, and requires a fresh `sharedAppServer` topology heartbeat before reporting host readiness. On Windows it retains the frozen host behavior. On Apple Silicon macOS, a platform adapter independently verifies the exact Microsoft-signed VS Code app, Darwin extension/CLI and compiled proxy hashes; launches them with an owner-only short-path profile; proves extension initialization, proxy process identity, authenticated TCP ownership and a second Pocket client; and only then publishes readiness. POSIX children use separate process sessions so `main.py` remains the sole lifecycle owner. Shutdown uses `host-stop` and `bot-stop` only for child processes started by that invocation. Daily VS Code and pre-existing Pocket processes are never termination targets.

## Presentation adapters

The local CLI and Telegram bot are presentation adapters. Both render normalized events and invoke core managers; neither handles raw App Server method names.

The Telegram adapter uses grammY long polling and opens no inbound listener. `TelegramController` depends on a small outbound `TelegramPort`, which lets normal tests feed deterministic updates without Telegram credentials. The grammY layer only translates Bot API updates and responses.

For a turn that starts while its conversation is selected, or an already-active turn bootstrapped when that conversation is selected late, `TelegramLiveOutputPresenter` binds the exact runtime/thread/turn tuple to the authorized Telegram chat. Switching selection does not redirect an already-bound turn, and simultaneous workspace turns cannot merge. The presenter consumes canonical Core snapshots and deltas; it does not interpret raw App Server methods or own Codex streaming semantics.

Telegram renders a deliberately simple plain-text fallback headed by `🤖 Codex`. Edits are serialized and coalesced at 750 ms, while terminal states flush immediately. A conservative 3,500-character message limit leaves Bot API headroom. At 3,380 body characters the current message is frozen and a numbered continuation (`🤖 Codex · 2`, and so on) is created, preferring paragraph, newline, then whitespace boundaries. Frozen segments are immutable and discarded from active presentation memory only after successful delivery; no beginning or middle output is truncated. Completion markers are presentation-only. The existing secret redactor runs before every send or edit, while Core retains unmodified semantic content for a future rich Markdown renderer.

Telegram authorization is fail-closed: both the sender ID and private chat ID must equal the configured numeric user ID. Inline callbacks contain only opaque in-memory approval IDs or random conversation-action handles. Conversation handles are user/chat scoped, expiring, single-use mappings to exact internal thread IDs; raw IDs do not appear in the primary `/chats` UI. The adapter sends capability and bot tokens through an explicit redactor before any presentation text is emitted.

The conversation browser asks core managers for workspace discovery, conversation discovery, preview, and exact-thread attachment. Telegram contains no raw App Server methods or filesystem business rules. Listing follows every opaque `thread/list` cursor for VS Code sources and keeps its five-row UI pagination separate from protocol pagination. `/chats` is active-workspace scoped by default and retains an explicit global view. Opening one conversation makes one bounded `thread/turns/list` request through `AppServerCodexAdapter`. A failed active-writer or CWD-consistency check leaves the previous selection unchanged and never creates a new thread.

The selected Telegram session and approval-message mappings are intentionally in memory. SQLite, browser automation, frontend, Tailscale, WSL, and a generic event bus remain out of scope.
