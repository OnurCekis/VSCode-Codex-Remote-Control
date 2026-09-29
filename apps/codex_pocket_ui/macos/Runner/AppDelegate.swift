import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private let pocketRuntime = PocketRuntimeManager()

  override func applicationDidFinishLaunching(_ notification: Notification) {
    pocketRuntime.start()
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    pocketRuntime.shutdown {
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}

private final class PocketRuntimeManager {
  private static var mobileRelayURL: String? {
    let configured = ProcessInfo.processInfo.environment["CODEX_POCKET_RELAY_URL"]
      ?? Bundle.main.object(forInfoDictionaryKey: "PocketRelayURL") as? String
    guard let configured,
          let url = URL(string: configured),
          url.scheme == "wss",
          url.host?.isEmpty == false else { return nil }
    return configured
  }
  private let files = FileManager.default
  private let queue = DispatchQueue(label: "dev.codexpocket.runtime", qos: .userInitiated)
  private var setupProcess: Process?
  private var hostProcess: Process?
  private var botProcess: Process?
  private var bridgeProcess: Process?
  private var stopped = false

  private lazy var supportRoot: URL = {
    let base = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return base.appendingPathComponent("Codex Pocket", isDirectory: true)
  }()
  private lazy var runtimeRoot = supportRoot.appendingPathComponent("runtime", isDirectory: true)
  private lazy var stateRoot = runtimeRoot.appendingPathComponent(".codex-pocket", isDirectory: true)
  private lazy var statusFile = supportRoot.appendingPathComponent("desktop-runtime-status.json")

  func start() {
    queue.async { [weak self] in
      guard let self else { return }
      do {
        guard let template = Bundle.main.resourceURL?.appendingPathComponent("pocket-runtime", isDirectory: true),
              self.files.fileExists(atPath: template.path) else {
          self.writeStatus(state: "externalBridge", detail: "Bundled runtime is unavailable; development bridge mode is active.")
          return
        }
        try self.installRuntime(from: template)
        try? self.files.removeItem(at: self.supportRoot.appendingPathComponent("connection.json"))
        if self.configurationIsValid() {
          try self.startProduction()
        } else {
          try self.startSetup()
        }
      } catch {
        self.cleanupAfterStartupFailure()
        self.writeStatus(state: "failed", detail: self.safe(error))
      }
    }
  }

  private func installRuntime(from template: URL) throws {
    try files.createDirectory(at: supportRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try files.createDirectory(at: runtimeRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let packagedVersion = try String(contentsOf: template.appendingPathComponent("runtime-version.txt"), encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let installedVersionFile = runtimeRoot.appendingPathComponent("runtime-version.txt")
    let installedVersion = try? String(contentsOf: installedVersionFile, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if installedVersion == packagedVersion { return }

    let ownedEntries = ["apps", "packages", "tools", "node_modules", "bin", "artifacts", "package.json", "runtime-version.txt"]
    for entry in ownedEntries {
      let destination = runtimeRoot.appendingPathComponent(entry)
      if files.fileExists(atPath: destination.path) { try files.removeItem(at: destination) }
      let source = template.appendingPathComponent(entry)
      if files.fileExists(atPath: source.path) { try files.copyItem(at: source, to: destination) }
    }
    try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtimeRoot.appendingPathComponent("bin/node").path)
    let bundledProxy = runtimeRoot.appendingPathComponent("artifacts/codex-pocket-proxy")
    let proxy = runtimeRoot.appendingPathComponent(".codex-pocket/phase-0-7/macos-proxy/codex-pocket-proxy")
    try files.createDirectory(at: proxy.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if files.fileExists(atPath: proxy.path) { try files.removeItem(at: proxy) }
    try files.copyItem(at: bundledProxy, to: proxy)
    try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: proxy.path)
    let welcome = runtimeRoot.appendingPathComponent("Welcome", isDirectory: true)
    try files.createDirectory(at: welcome, withIntermediateDirectories: true)
  }

  private func configurationIsValid() -> Bool {
    guard let text = try? String(contentsOf: runtimeRoot.appendingPathComponent(".env"), encoding: .utf8) else { return false }
    let token = try? NSRegularExpression(pattern: "(?m)^\\s*TELEGRAM_BOT_TOKEN\\s*=\\s*\\d+:[A-Za-z0-9_-]{30,}\\s*$")
    let user = try? NSRegularExpression(pattern: "(?m)^\\s*TELEGRAM_ALLOWED_USER_ID\\s*=\\s*[1-9]\\d*\\s*$")
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return token?.firstMatch(in: text, range: range) != nil && user?.firstMatch(in: text, range: range) != nil
  }

  private func startSetup() throws {
    writeStatus(state: "setup", detail: "Waiting for verified Telegram configuration.")
    setupProcess = try launch(["--import", "tsx", "apps/pocket-ui-bridge/src/setup-main.ts"], envFile: false)
    while !stopped && !configurationIsValid() {
      if setupProcess?.isRunning != true { throw RuntimeError("Setup bridge stopped unexpectedly.") }
      Thread.sleep(forTimeInterval: 0.5)
    }
    if stopped { return }
    try startProduction(keepingSetupAlive: true)
  }

  private func startProduction(keepingSetupAlive: Bool = false) throws {
    writeStatus(state: "startingHost", detail: "Preparing verified VS Code and Codex runtime. First launch may take several minutes.")
    hostProcess = try launch(["--import", "tsx", "apps/pocket-cli/src/macos-host.ts"], envFile: false)
    try waitForReady(
      stateRoot.appendingPathComponent("phase-1/host-status.json"),
      process: hostProcess!, expectedHostPID: nil, timeout: 900
    )
    writeStatus(state: "startingTelegram", detail: "Connecting the verified Telegram bot.")
    botProcess = try launch(["--import", "tsx", "apps/telegram-bot/src/main.ts"], envFile: true)
    try waitForReady(
      stateRoot.appendingPathComponent("phase-2/bot-status.json"),
      process: botProcess!, expectedHostPID: hostProcess!.processIdentifier, timeout: 90
    )
    if keepingSetupAlive {
      setupProcess?.terminate()
      setupProcess?.waitUntilExit()
      setupProcess = nil
    }
    writeStatus(state: "startingBridge", detail: "Connecting the desktop interface.")
    bridgeProcess = try launch(["--import", "tsx", "apps/pocket-ui-bridge/src/main.ts"], envFile: false)
    try waitForDescriptor(timeout: 60)
    writeStatus(state: "ready", detail: "VS Code Codex Remote Control is ready.")
  }

  private func launch(_ arguments: [String], envFile: Bool) throws -> Process {
    let process = Process()
    process.executableURL = runtimeRoot.appendingPathComponent("bin/node")
    process.arguments = (envFile ? ["--env-file=\(runtimeRoot.appendingPathComponent(".env").path)"] : []) + arguments
    process.currentDirectoryURL = runtimeRoot
    var environment = ProcessInfo.processInfo.environment
    environment["CODEX_POCKET_ROOT"] = runtimeRoot.path
    environment["CODEX_POCKET_INITIAL_WORKSPACE"] = runtimeRoot.appendingPathComponent("Welcome").path
    environment["CODEX_POCKET_TEST_PROFILE"] = supportRoot.appendingPathComponent("vscode-profile").path
    if let relayURL = Self.mobileRelayURL {
      environment["CODEX_POCKET_RELAY_URL"] = relayURL
    } else {
      environment.removeValue(forKey: "CODEX_POCKET_RELAY_URL")
    }
    // V1 performs read-only version checks; automatic download/apply remains out of scope.
    environment["CODEX_POCKET_TEST_DISABLE_AUTOMATIC_UPDATES"] = "1"
    process.environment = environment
    let logs = supportRoot.appendingPathComponent("logs", isDirectory: true)
    try files.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let log = logs.appendingPathComponent("desktop-runtime.log")
    if !files.fileExists(atPath: log.path) { files.createFile(atPath: log.path, contents: nil) }
    let handle = try FileHandle(forWritingTo: log)
    handle.seekToEndOfFile()
    process.standardOutput = handle
    process.standardError = handle
    try process.run()
    return process
  }

  private func waitForReady(_ file: URL, process: Process, expectedHostPID: Int32?, timeout: TimeInterval) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline && !stopped {
      if !process.isRunning { throw RuntimeError("A Pocket runtime component exited before readiness.") }
      if let data = try? Data(contentsOf: file),
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         json["state"] as? String == "ready",
         (json["ownerPid"] as? NSNumber)?.int32Value == process.processIdentifier {
        if expectedHostPID == nil || (json["hostOwnerPid"] as? NSNumber)?.int32Value == expectedHostPID { return }
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    throw RuntimeError("Timed out waiting for Pocket runtime readiness.")
  }

  private func waitForDescriptor(timeout: TimeInterval) throws {
    let descriptor = supportRoot.appendingPathComponent("connection.json")
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline && !stopped {
      if bridgeProcess?.isRunning != true { throw RuntimeError("Desktop bridge exited before readiness.") }
      if files.fileExists(atPath: descriptor.path) { return }
      Thread.sleep(forTimeInterval: 0.2)
    }
    throw RuntimeError("Timed out waiting for the desktop bridge.")
  }

  private func writeStatus(state: String, detail: String) {
    let value: [String: Any] = ["state": state, "detail": detail, "updatedAt": ISO8601DateFormatter().string(from: Date())]
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    try? data.write(to: statusFile, options: .atomic)
    try? files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statusFile.path)
  }

  private func safe(_ error: Error) -> String {
    String(describing: error).replacingOccurrences(of: NSHomeDirectory(), with: "<HOME>").prefix(500).description
  }

  func shutdown(completion: @escaping () -> Void) {
    stopped = true
    queue.async { [weak self] in
      guard let self else { completion(); return }
      self.bridgeProcess?.terminate()
      self.setupProcess?.terminate()
      self.requestStop(self.stateRoot.appendingPathComponent("phase-2/bot-stop"), process: self.botProcess)
      self.requestStop(self.stateRoot.appendingPathComponent("phase-1/host-stop"), process: self.hostProcess)
      for process in [self.bridgeProcess, self.setupProcess, self.botProcess, self.hostProcess].compactMap({ $0 }) {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
      }
      self.writeStatus(state: "stopped", detail: "Owned Pocket processes stopped.")
      DispatchQueue.main.async { completion() }
    }
  }

  private func requestStop(_ file: URL, process: Process?) {
    guard process?.isRunning == true else { return }
    try? files.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data("stop\n".utf8).write(to: file, options: .atomic)
    let deadline = Date().addingTimeInterval(10)
    while process?.isRunning == true && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
  }

  private func cleanupAfterStartupFailure() {
    bridgeProcess?.terminate()
    setupProcess?.terminate()
    requestStop(stateRoot.appendingPathComponent("phase-2/bot-stop"), process: botProcess)
    requestStop(stateRoot.appendingPathComponent("phase-1/host-stop"), process: hostProcess)
    for process in [bridgeProcess, setupProcess, botProcess, hostProcess].compactMap({ $0 }) {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
    bridgeProcess = nil
    setupProcess = nil
    botProcess = nil
    hostProcess = nil
  }

  private struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
  }
}
