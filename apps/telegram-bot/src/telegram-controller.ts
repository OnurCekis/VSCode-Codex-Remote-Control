import os from "node:os";
import path from "node:path";
import type { PocketCore } from "../../../packages/codex-core/src/pocket-core.js";
import { ForeignActiveSessionError } from "../../../packages/codex-core/src/codex-adapter.js";
import type { CodexEvent } from "../../../packages/codex-core/src/domain-events.js";
import type { PendingApproval } from "../../../packages/codex-core/src/approval-manager.js";
import type { ManagedSession } from "../../../packages/codex-core/src/session-manager.js";
import type { PocketUpdateStatus } from "../../../packages/codex-core/src/workspace-runtime-manager.js";
import type { InlineButton, TelegramPort, TelegramUpdate } from "./telegram-port.js";
import { TelegramLiveOutputPresenter } from "./live-output-presenter.js";
import {
  ConversationCallbackRegistry,
  renderConversationPage,
  renderConversationPreview,
  type ConversationAction,
  type ConversationScope,
} from "./conversation-browser.js";
import {
  renderWorkspaceDirectory,
  renderWorkspaceHome,
  renderWorkspaceRoots,
  WorkspaceCallbackRegistry,
  type WorkspaceAction,
} from "./workspace-browser.js";

interface ApprovalMessage {
  chatId: number;
  messageId: number;
  text: string;
  sessionId: string;
}

export type TelegramAuditEvent =
  | { type: "sessions.listed"; count: number }
  | { type: "session.selected"; sessionId: string; topology: ManagedSession["topology"] }
  | { type: "task.submitted"; turnId: string }
  | { type: "task.stopRequested"; turnId: string }
  | { type: "approval.presented"; approvalId: string }
  | { type: "approval.decided"; approvalId: string; decision: "approve" | "deny" };

function redactDetail(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "<REDACTED>");
  return safe
    .replaceAll(os.homedir(), "<HOME>")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer <REDACTED>")
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s"']+/giu, "$1=<REDACTED>");
}

function safeDetail(value: string, secrets: readonly string[], limit = 900): string {
  return redactDetail(value, secrets).slice(0, limit);
}

const TELEGRAM_PLAIN_TEXT_LIMIT = 4_000;

function splitPlainText(text: string): string[] {
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_PLAIN_TEXT_LIMIT) {
    const window = remaining.slice(0, TELEGRAM_PLAIN_TEXT_LIMIT + 1);
    const minimum = Math.floor(TELEGRAM_PLAIN_TEXT_LIMIT * 0.6);
    let split = -1;
    for (const boundary of ["\n\n", "\n", " "]) {
      const found = window.lastIndexOf(boundary);
      if (found >= minimum) { split = found + boundary.length; break; }
    }
    if (split < 1) {
      split = TELEGRAM_PLAIN_TEXT_LIMIT;
      const previous = remaining.charCodeAt(split - 1);
      const next = remaining.charCodeAt(split);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) split -= 1;
    }
    segments.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining || segments.length === 0) segments.push(remaining);
  return segments;
}

function callbackButtons(id: string): InlineButton[][] {
  return [[
    { text: "Approve", callbackData: `approval:approve:${id}` },
    { text: "Deny", callbackData: `approval:deny:${id}` },
  ]];
}

function approvalText(approval: PendingApproval, title: string, secrets: readonly string[]): string {
  const lines = [
    "Approval required",
    `Project: ${safeDetail(title, secrets, 120)}`,
    `Kind: ${approval.kind}`,
    `Approval: ${approval.id}`,
  ];
  if (approval.reason) lines.push(`Reason: ${safeDetail(approval.reason, secrets, 500)}`);
  if (approval.command) lines.push(`Command: ${safeDetail(approval.command, secrets)}`);
  if (approval.grantRoot) lines.push(`Path: ${safeDetail(approval.grantRoot, secrets, 500)}`);
  return lines.join("\n");
}

export class TelegramController {
  readonly #core: PocketCore;
  readonly #port: TelegramPort;
  #allowedUserId: number;
  readonly #cwd: string | undefined;
  readonly #approvalMessages = new Map<string, ApprovalMessage>();
  readonly #unsubscribe: () => void;
  readonly #onError: (error: Error) => void;
  readonly #onAudit: (event: TelegramAuditEvent) => void;
  readonly #secrets: readonly string[];
  readonly #conversationCallbacks: ConversationCallbackRegistry;
  readonly #workspaceCallbacks: WorkspaceCallbackRegistry;
  readonly #streamUpdateMs: number;
  #liveOutput: TelegramLiveOutputPresenter;
  #eventQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    core: PocketCore;
    port: TelegramPort;
    allowedUserId: number;
    cwd?: string;
    onError?: (error: Error) => void;
    onAudit?: (event: TelegramAuditEvent) => void;
    secrets?: readonly string[];
    conversationCallbacks?: ConversationCallbackRegistry;
    workspaceCallbacks?: WorkspaceCallbackRegistry;
    streamUpdateMs?: number;
  }) {
    this.#core = options.core;
    this.#port = options.port;
    this.#allowedUserId = options.allowedUserId;
    this.#cwd = options.cwd;
    this.#onError = options.onError ?? (() => undefined);
    this.#onAudit = options.onAudit ?? (() => undefined);
    this.#secrets = options.secrets ?? [];
    this.#conversationCallbacks = options.conversationCallbacks ?? new ConversationCallbackRegistry();
    this.#workspaceCallbacks = options.workspaceCallbacks ?? new WorkspaceCallbackRegistry();
    this.#streamUpdateMs = Math.max(0, options.streamUpdateMs ?? 750);
    this.#liveOutput = new TelegramLiveOutputPresenter({
      core: this.#core,
      port: this.#port,
      chatId: this.#allowedUserId,
      userId: this.#allowedUserId,
      secrets: this.#secrets,
      updateMs: this.#streamUpdateMs,
      onError: this.#onError,
    });
    this.#unsubscribe = this.#core.adapter.subscribe((event) => {
      this.#eventQueue = this.#eventQueue
        .then(async () => this.#handleEvent(event))
        .catch((error: unknown) => this.#onError(error instanceof Error ? error : new Error(String(error))));
    });
  }

  setAllowedUserId(userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Telegram user ID must be a positive safe integer.");
    this.#liveOutput.close();
    this.#allowedUserId = userId;
    this.#approvalMessages.clear();
    this.#liveOutput = new TelegramLiveOutputPresenter({
      core: this.#core,
      port: this.#port,
      chatId: this.#allowedUserId,
      userId: this.#allowedUserId,
      secrets: this.#secrets,
      updateMs: this.#streamUpdateMs,
      onError: this.#onError,
    });
  }

  async handle(update: TelegramUpdate): Promise<void> {
    if (update.userId !== this.#allowedUserId || update.chatId !== this.#allowedUserId) {
      if (update.type === "callback") await this.#port.answerCallback(update.callbackId, "Unauthorized.", true);
      return;
    }
    if (update.type === "callback") {
      await this.#handleCallback(update);
      return;
    }
    await this.#handleText(update.text.trim());
  }

  close(): void {
    this.#unsubscribe();
    this.#liveOutput.close();
  }

  async #handleText(text: string): Promise<void> {
    const [rawCommand = "", ...argumentParts] = text.split(/\s+/u);
    const command = rawCommand.split("@", 1)[0]?.toLowerCase() ?? "";
    const argument = argumentParts.join(" ").trim();
    if (command === "/chats") {
      await this.#showConversationPage(0, "workspace");
      return;
    }
    if (command === "/workspaces" || command === "/workspace") {
      await this.#showWorkspaceHome();
      return;
    }
    if (command === "/sessions") {
      const diagnosticCwd = this.#core.workspaces.active?.path ?? this.#cwd;
      const sessions = await this.#core.sessions.discover(diagnosticCwd ? { cwd: diagnosticCwd } : {});
      if (!sessions.length) {
        await this.#send("No VS Code Codex sessions found.");
        return;
      }
      this.#onAudit({ type: "sessions.listed", count: sessions.length });
      const selected = this.#core.sessions.selected?.id;
      const lines = sessions.slice(0, 20).map((session) => {
        const marker = session.id === selected ? "*" : "-";
        return `${marker} ${session.id}\n  ${safeDetail(session.title, this.#secrets, 100)} [${session.status.type}${session.loaded ? ", loaded" : ""}]\n  Use: /use ${session.id}`;
      });
      await this.#send(lines.join("\n"));
      return;
    }
    if (command === "/use") {
      if (!argument) { await this.#send("Usage: /use <conversation title or exact thread ID>\nTip: /chats is easier."); return; }
      const folded = argument.toLowerCase();
      const knownExact = this.#core.sessions.known.some((session) =>
        session.id === argument || session.title === argument || session.title.toLowerCase() === folded);
      if (!knownExact) await this.#core.sessions.discover();
      const matches = this.#core.sessions.resolve(argument);
      if (!matches.length) { await this.#send("Conversation not found. Use /chats to browse recent conversations."); return; }
      if (matches.length > 1) {
        const titles = matches.slice(0, 8).map((session) => `- ${safeDetail(session.title, this.#secrets, 120)}`);
        await this.#send([`Multiple conversations match "${safeDetail(argument, this.#secrets, 120)}":`, "", ...titles, "", "Use /chats or enter a more specific title."].join("\n"));
        return;
      }
      await this.#selectConversation(matches[0]!.id);
      return;
    }
    if (command === "/status") {
      const session = this.#core.sessions.selected;
      const workspace = this.#core.workspaces.active;
      const mismatch = Boolean(session && workspace && !this.#core.workspaces.matches(session.cwd, workspace));
      await this.#send([
        "Active workspace:",
        workspace ? safeDetail(workspace.displayName, this.#secrets, 120) : "none",
        "",
        "Active conversation:",
        session ? safeDetail(session.title, this.#secrets, 200) : "none",
        ...(session ? [
          `Conversation workspace: ${safeDetail(path.basename(session.cwd), this.#secrets, 120)}`,
          `Runtime topology: ${session.topology}`,
          `Pocket control: ${this.#core.sessions.controlState(session.id) === "telegramTurnActive" ? "Telegram turn active" :
            this.#core.sessions.controlState(session.id) === "turnObserved" ? "turn observed" : "observer / idle"}`,
          "Writer: not exposed by App Server",
          `Direct input: ${session.canAcceptDirectInput === false ? "unavailable" : "available"}`,
          `Status: ${session.status.type}`,
          `Turns: ${session.turns.length}`,
          `Active turn: ${session.activeTurnId ?? "none"}`,
          `Pending approvals: ${this.#core.approvals.pending(session.id).length}`,
        ] : ["Select one with /chats."]),
        ...(mismatch ? ["", "WARNING: The selected conversation belongs to a different workspace. Tasks are blocked until you select a matching conversation."] : []),
      ].join("\n"));
      return;
    }
    if (command === "/stop") {
      try {
        const turnId = await this.#core.tasks.stop();
        this.#onAudit({ type: "task.stopRequested", turnId });
        await this.#send(`Interrupt requested for task ${turnId}.`);
      } catch (error) {
        await this.#send(safeDetail(error instanceof Error ? error.message : String(error), this.#secrets, 500));
      }
      return;
    }
    if (command === "/history") {
      const selected = this.#core.sessions.selected;
      if (!selected) {
        await this.#send("No active conversation. Use /workspaces, then /chats; Pocket will not guess.");
        return;
      }
      try {
        const preview = await this.#core.sessions.preview(selected.id, 1);
        const lastUser = preview.messages.findLastIndex((message) => message.role === "user");
        const task = lastUser >= 0 ? preview.messages[lastUser]!.text : null;
        const outputs = lastUser >= 0
          ? preview.messages.slice(lastUser + 1).filter((message) => message.role === "assistant").map((message) => message.text)
          : preview.messages.filter((message) => message.role === "assistant").map((message) => message.text);
        if (!task && outputs.length === 0) {
          await this.#send("Bu sohbette gösterilebilecek tamamlanmış bir task geçmişi yok.");
          return;
        }
        const sections = [
          "Son task",
          "",
          task ? redactDetail(task, this.#secrets) : "(Kullanıcı taskı bulunamadı.)",
          "",
          "Son output",
          "",
          outputs.length ? outputs.map((output) => redactDetail(output, this.#secrets)).join("\n\n") : "(Henüz tamamlanmış output yok.)",
        ];
        await this.#send(sections.join("\n"));
      } catch (error) {
        await this.#send(`Geçmiş okunamadı.\n\n${safeDetail(error instanceof Error ? error.message : String(error), this.#secrets, 500)}`);
      }
      return;
    }
    if (command === "/updates" || command === "/update") {
      if (!this.#core.runtimes) {
        await this.#send("Bu Pocket hostunda güncelleme denetimi kullanılamıyor.");
        return;
      }
      try {
        const status = command === "/update"
          ? await this.#core.runtimes.applyUpdate()
          : await this.#core.runtimes.checkForUpdates();
        const labels: Record<PocketUpdateStatus["state"], string> = {
          idle: "Güncelleme sistemi boşta.", checking: "Güncellemeler denetleniyor.", upToDate: "Pocket güncel.",
          updateAvailable: "Yeni bir Pocket runtime güncellemesi var.", downloading: "Güncelleme indiriliyor ve doğrulanıyor.",
          staged: "Güncelleme doğrulandı ve kuruluma hazır.", waitingForIdle: "Güncelleme hazır — Codex'in boşta kalması bekleniyor.",
          applying: "Güncelleme atomik olarak etkinleştiriliyor.", restarting: "Pocket kontrollü olarak yeniden başlatılıyor.",
          ready: "Pocket başarıyla güncellendi.", rollingBack: "Yeni runtime doğrulanamadı; önceki sürüme dönülüyor.",
          failed: status.rollbackSucceeded ? "Güncelleme başarısız — önceki sürüm geri yüklendi." : "Güncelleme başarısız.",
          incompatible: "Yeni Codex sürümü sabit VS Code tabanıyla uyumlu değil; otomatik güncelleme engellendi.",
        };
        await this.#send([
          labels[status.state],
          `Kurulu Codex uzantısı: ${status.currentVersion}`,
          `Resmî kararlı sürüm: ${status.availableVersion ?? "bilinmiyor"}`,
          `Denetleme zamanı: ${status.checkedAt}`,
          ...(status.candidateCliVersion ? [`Doğrulanan Codex CLI: ${status.candidateCliVersion}`] : []),
          ...(status.detail ? [`Durum: ${safeDetail(status.detail, this.#secrets, 500)}`] : []),
          ...(status.error ? [`Hata: ${safeDetail(status.error, this.#secrets, 500)}`] : []),
        ].join("\n"));
      } catch (error) {
        await this.#send(`Güncelleme denetlenemedi.\n\n${safeDetail(error instanceof Error ? error.message : String(error), this.#secrets, 500)}`);
      }
      return;
    }
    if (command === "/help" || text.startsWith("/")) {
      await this.#send([
        "Codex Pocket commands",
        "/workspaces — choose the active workspace",
        "/chats — browse and select a conversation",
        "/status — show the active conversation",
        "/history — show the last task and its output",
        "/updates — check the official Pocket runtime update source now",
        "/update — safely download, stage, and install when Codex is idle",
        "/stop — interrupt its active task",
        "/sessions — technical session diagnostics",
        "/use <title or exact thread ID> — direct selection",
        "Send normal text to start a task in the active conversation.",
      ].join("\n"));
      return;
    }
    if (!text) return;
    if (!this.#core.sessions.selected) {
      await this.#send("No active conversation. Use /workspaces, then /chats; Pocket will not guess.");
      return;
    }
    try {
      const turnId = await this.#core.tasks.send(text);
      this.#onAudit({ type: "task.submitted", turnId });
      await this.#send(`Task submitted: ${turnId}.`);
    } catch (error) {
      await this.#send(safeDetail(error instanceof Error ? error.message : String(error), this.#secrets, 500));
    }
  }

  async #handleCallback(update: Extract<TelegramUpdate, { type: "callback" }>): Promise<void> {
    const { callbackId, data } = update;
    if (data.startsWith("workspace:")) {
      const action = this.#workspaceCallbacks.consume(data, update.userId!, update.chatId);
      if (!action) {
        await this.#port.answerCallback(callbackId, "This workspace action expired. Open /workspaces again.", true);
        return;
      }
      await this.#handleWorkspaceAction(update, action);
      return;
    }
    if (data.startsWith("chat:")) {
      const action = this.#conversationCallbacks.consume(data, update.userId!, update.chatId);
      if (!action) {
        await this.#port.answerCallback(callbackId, "This conversation action expired. Open /chats again.", true);
        return;
      }
      await this.#handleConversationAction(update, action);
      return;
    }
    const match = /^approval:(approve|deny):(approval-\d+)$/u.exec(data);
    if (!match) {
      await this.#port.answerCallback(callbackId, "Invalid or expired action.", true);
      return;
    }
    const action = match[1] as "approve" | "deny";
    const approvalId = match[2]!;
    const approval = this.#core.approvals.pending().find((item) => item.id === approvalId);
    if (!approval) {
      await this.#expireMessage(approvalId, "Approval expired or already resolved.");
      await this.#port.answerCallback(callbackId, "Approval expired or already resolved.", true);
      return;
    }
    try {
      if (action === "approve") this.#core.approvals.approve(approvalId);
      else this.#core.approvals.deny(approvalId);
      this.#onAudit({ type: "approval.decided", approvalId, decision: action });
      const decision = action === "approve" ? "Approved" : "Denied";
      await this.#expireMessage(approvalId, `${decision}.`);
      await this.#port.answerCallback(callbackId, decision);
    } catch {
      await this.#expireMessage(approvalId, "Approval expired or already resolved.");
      await this.#port.answerCallback(callbackId, "Approval expired or already resolved.", true);
    }
  }

  async #showConversationPage(
    page: number,
    scope: ConversationScope,
    messageId?: number,
    callbackId?: string,
  ): Promise<void> {
    const sessions = await this.#core.conversations.list(scope);
    const workspace = this.#core.workspaces.active;
    const rendered = renderConversationPage({
      sessions: sessions.map((session) => ({
        ...session,
        title: safeDetail(session.title, this.#secrets, 200),
        preview: safeDetail(session.preview, this.#secrets, 200),
        cwd: safeDetail(session.cwd, this.#secrets, 500),
      })),
      page,
      scope,
      ...(workspace ? { workspaceName: safeDetail(workspace.displayName, this.#secrets, 120) } : {}),
      callback: (action) => this.#conversationCallbacks.create(action, this.#allowedUserId, this.#allowedUserId),
    });
    rendered.buttons.push([{
      text: "Change workspace",
      callbackData: this.#workspaceCallbacks.create({ type: "home" }, this.#allowedUserId, this.#allowedUserId),
    }]);
    if (messageId !== undefined) await this.#port.editMessage(this.#allowedUserId, messageId, rendered.text, rendered.buttons);
    else await this.#port.sendMessage(this.#allowedUserId, rendered.text, rendered.buttons);
    if (callbackId) await this.#port.answerCallback(callbackId, `Page ${rendered.page + 1} of ${rendered.pages}`);
  }

  async #handleConversationAction(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    action: ConversationAction,
  ): Promise<void> {
    if (action.type === "page") {
      await this.#showConversationPage(action.page, action.scope, update.messageId, update.callbackId);
      return;
    }
    const currentSessions = await this.#core.conversations.list(action.scope);
    const session = currentSessions.find((candidate) => candidate.id === action.threadId);
    if (!session) {
      await this.#port.answerCallback(update.callbackId, "Conversation no longer available. Open /chats again.", true);
      return;
    }
    if (action.type === "use" || action.type === "switchUse") {
      const selected = await this.#selectConversation(session.id, false, action.type === "switchUse");
      if (selected) {
        const joinedLive = selected.topology === "sharedLive";
        const text = [
          joinedLive ? "✓ Active live conversation" : "✓ Active conversation", "",
          safeDetail(selected.title, this.#secrets, 200), "",
          `Workspace: ${safeDetail(path.basename(selected.cwd), this.#secrets, 120)}`,
          `VS Code: ${joinedLive ? "connected through Pocket" : "stored conversation"}`,
          `${selected.turns.length} previous turns`,
          `Status: ${selected.status.type}`, "",
          "Send a normal message to continue this conversation.",
        ].join("\n");
        if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, text, []);
        else await this.#send(text);
        await this.#port.answerCallback(update.callbackId, "Conversation selected.");
      } else await this.#port.answerCallback(update.callbackId, "Conversation could not be attached safely.", true);
      return;
    }
    let preview = null;
    try { preview = await this.#core.sessions.preview(session.id); } catch { /* Metadata-only fallback is intentional. */ }
    const rendered = renderConversationPreview({
      session: {
        ...session,
        title: safeDetail(session.title, this.#secrets, 200),
        preview: safeDetail(session.preview, this.#secrets, 200),
        cwd: safeDetail(session.cwd, this.#secrets, 500),
      },
      preview: preview ? {
        ...preview,
        messages: preview.messages.map((message) => ({ ...message, text: safeDetail(message.text, this.#secrets, 2_000) })),
      } : null,
      page: action.page,
      scope: action.scope,
      relation: this.#core.conversations.relation(session),
      callback: (next) => this.#conversationCallbacks.create(next, update.userId!, update.chatId),
    });
    if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, rendered.text, rendered.buttons);
    else await this.#port.sendMessage(update.chatId, rendered.text, rendered.buttons);
    await this.#port.answerCallback(update.callbackId, "Conversation preview.");
  }

  async #selectConversation(sessionId: string, announce = true, switchWorkspace = false): Promise<ManagedSession | null> {
    try {
      const attached = await this.#core.conversations.select(sessionId, { switchWorkspace });
      this.#onAudit({ type: "session.selected", sessionId: attached.id, topology: attached.topology });
      if (announce) await this.#send([
        attached.topology === "sharedLive" ? "✓ Active live conversation" : "✓ Active conversation",
        "", safeDetail(attached.title, this.#secrets, 200), "",
        `VS Code: ${attached.topology === "sharedLive" ? "connected through Pocket" : "stored conversation"}`,
        `${attached.turns.length} previous turns`, `Status: ${attached.status.type}`, "",
        "Send a normal message to continue this conversation.",
      ].join("\n"));
      return attached;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const response = error instanceof ForeignActiveSessionError
        ? "This conversation is open in a Codex instance that is not connected through Codex Pocket.\n\nPocket can show its stored history, but cannot safely control the live conversation. For live control, start that VS Code through the Pocket shared-App-Server topology."
        : /different workspace/iu.test(message)
          ? "This conversation belongs to another workspace. Open /chats, choose All conversations, then use 'Switch workspace & use chat'."
        : `Unable to use conversation: ${safeDetail(message, this.#secrets, 500)}`;
      await this.#send(response);
      return null;
    }
  }

  async #showWorkspaceHome(messageId?: number, callbackId?: string): Promise<void> {
    const runtimes = await this.#core.runtimes?.listRuntimes() ?? [];
    const rendered = renderWorkspaceHome(
      this.#core.workspaces.state,
      (action) => this.#workspaceCallbacks.create(action, this.#allowedUserId, this.#allowedUserId),
      (value) => safeDetail(value, this.#secrets, 500),
      runtimes,
    );
    if (messageId !== undefined) await this.#port.editMessage(this.#allowedUserId, messageId, rendered.text, rendered.buttons);
    else await this.#port.sendMessage(this.#allowedUserId, rendered.text, rendered.buttons);
    if (callbackId) await this.#port.answerCallback(callbackId, "Workspaces");
  }

  async #handleWorkspaceAction(
    update: Extract<TelegramUpdate, { type: "callback" }>,
    action: WorkspaceAction,
  ): Promise<void> {
    try {
      if (action.type === "home") {
        await this.#showWorkspaceHome(update.messageId, update.callbackId);
        return;
      }
      if (action.type === "roots") {
        const rendered = renderWorkspaceRoots(
          await this.#core.workspaces.listRoots(),
          (next) => this.#workspaceCallbacks.create(next, update.userId!, update.chatId),
          (value) => safeDetail(value, this.#secrets, 500),
        );
        if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, rendered.text, rendered.buttons);
        else await this.#port.sendMessage(update.chatId, rendered.text, rendered.buttons);
        await this.#port.answerCallback(update.callbackId, "Computer");
        return;
      }
      if (action.type === "directory") {
        const rendered = renderWorkspaceDirectory(
          await this.#core.workspaces.listDirectory(action.path, action.page),
          (next) => this.#workspaceCallbacks.create(next, update.userId!, update.chatId),
          (value) => safeDetail(value, this.#secrets, 500),
        );
        if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, rendered.text, rendered.buttons);
        else await this.#port.sendMessage(update.chatId, rendered.text, rendered.buttons);
        await this.#port.answerCallback(update.callbackId, "Folder opened.");
        return;
      }
      if (action.type === "open") {
        if (!this.#core.runtimes) throw new Error("Pocket workspace runtime control is unavailable.");
        const runtime = await this.#core.runtimes.openWorkspace(action.path);
        const text = [
          "✓ Pocket VS Code connected", "", safeDetail(runtime.workspace.displayName, this.#secrets, 120), "",
          "VS Code runtime: connected through Pocket",
        ].join("\n");
        const buttons: InlineButton[][] = [[{
          text: "Browse conversations",
          callbackData: this.#conversationCallbacks.create({ type: "page", page: 0, scope: "workspace" }, update.userId!, update.chatId),
        }]];
        if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, text, buttons);
        else await this.#port.sendMessage(update.chatId, text, buttons);
        await this.#port.answerCallback(update.callbackId, "Pocket VS Code connected.");
        return;
      }
      const workspace = action.type === "browseSelect"
        ? await this.#core.workspaces.selectBrowsable(action.path)
        : await this.#core.workspaces.select(action.path);
      const runtime = await this.#core.runtimes?.findRuntimeForWorkspace(workspace) ?? null;
      const text = [
        "✓ Active workspace", "", safeDetail(workspace.displayName, this.#secrets, 120), "",
        `VS Code runtime: ${runtime?.state === "connected" ? "connected through Pocket" : "not connected"}`,
      ].join("\n");
      const buttons: InlineButton[][] = [
        [{
          text: "Browse conversations",
          callbackData: this.#conversationCallbacks.create({ type: "page", page: 0, scope: "workspace" }, update.userId!, update.chatId),
        }],
        [{
          text: "Change workspace",
          callbackData: this.#workspaceCallbacks.create({ type: "home" }, update.userId!, update.chatId),
        }],
      ];
      if (!runtime) buttons.splice(1, 0, [{
        text: "Open in Pocket VS Code",
        callbackData: this.#workspaceCallbacks.create({ type: "open", path: workspace.path }, update.userId!, update.chatId),
      }]);
      if (update.messageId !== undefined) await this.#port.editMessage(update.chatId, update.messageId, text, buttons);
      else await this.#port.sendMessage(update.chatId, text, buttons);
      await this.#port.answerCallback(update.callbackId, "Workspace selected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#port.answerCallback(update.callbackId, "Cannot open this folder.", true);
      await this.#send(`Cannot open this folder.\n\n${safeDetail(message, this.#secrets, 500)}\n\nOpen /workspaces to try another location.`);
    }
  }

  async #handleEvent(event: CodexEvent): Promise<void> {
    if (event.type === "approval.pending") {
      const approval = this.#core.approvals.pending(event.approval.sessionId)
        .find((candidate) => candidate.itemId === event.approval.itemId && candidate.turnId === event.approval.turnId);
      if (!approval || this.#approvalMessages.has(approval.id)) return;
      const session = this.#core.sessions.selected?.id === approval.sessionId ? this.#core.sessions.selected : null;
      const title = session?.title ?? path.basename(approval.cwd ?? approval.grantRoot ?? approval.sessionId);
      const text = approvalText(approval, title, this.#secrets);
      const sent = await this.#port.sendMessage(this.#allowedUserId, text, callbackButtons(approval.id));
      this.#approvalMessages.set(approval.id, { chatId: this.#allowedUserId, messageId: sent.messageId, text, sessionId: approval.sessionId });
      this.#onAudit({ type: "approval.presented", approvalId: approval.id });
      return;
    }
    if (event.type === "approval.resolved" || event.type === "task.completed" || event.type === "connection.closed") {
      const sessionId = event.type === "connection.closed" ? undefined : event.sessionId;
      for (const [id, message] of [...this.#approvalMessages]) {
        if (sessionId && message.sessionId !== sessionId) continue;
        if (this.#core.approvals.pending().some((approval) => approval.id === id)) continue;
        await this.#expireMessage(id, "Resolved outside this Telegram action.");
      }
    }
    const selected = this.#core.sessions.selected;
    if (!selected || !("sessionId" in event) || event.sessionId !== selected.id) return;
    if (event.type === "task.started") await this.#send(`Task started: ${event.turnId}.`);
    else if (event.type === "task.completed") {
      const label = event.status === "completed" ? "completed" : event.status === "interrupted" ? "interrupted" : `failed (${event.status})`;
      await this.#send(`Task ${event.turnId} ${label}.`);
    }
  }

  async #expireMessage(id: string, suffix: string): Promise<void> {
    const message = this.#approvalMessages.get(id);
    if (!message) return;
    this.#approvalMessages.delete(id);
    await this.#port.editMessage(message.chatId, message.messageId, `${message.text}\n\n${suffix}`);
  }

  async #send(text: string): Promise<void> {
    for (const segment of splitPlainText(text)) await this.#port.sendMessage(this.#allowedUserId, segment);
  }
}
