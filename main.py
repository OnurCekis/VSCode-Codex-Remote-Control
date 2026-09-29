"""Startup supervisor for the existing TypeScript Codex Pocket runtime."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Callable, Mapping, TextIO


NODE_VERSION = "24.19.0"
HOST_MARKER = "apps/pocket-cli/src/vscode-host.ts"
MACOS_HOST_MARKER = "apps/pocket-cli/src/macos-host.ts"
BOT_MARKER = "apps/telegram-bot/src/main.ts"
TOKEN_PATTERN = re.compile(r"^\d+:[A-Za-z0-9_-]{30,}$")
USER_PATTERN = re.compile(r"^[1-9]\d*$")


class StartupError(RuntimeError):
    """A safe, user-facing startup failure without secret values."""


def discover_repository_root(start: Path) -> Path:
    candidate = start.resolve()
    if candidate.is_file():
        candidate = candidate.parent
    for directory in (candidate, *candidate.parents):
        if (directory / "package.json").is_file() and (directory / "pnpm-workspace.yaml").is_file():
            return directory
    raise StartupError("ERROR: Codex Pocket repository root could not be located.")


def _parse_env_value(raw: str, line_number: int) -> str:
    value = raw.strip()
    if not value:
        return ""
    if value[0] in {"'", '"'}:
        quote = value[0]
        if len(value) < 2 or value[-1] != quote:
            raise StartupError(f"ERROR: Malformed .env entry on line {line_number}.")
        return value[1:-1]
    match = re.match(r"^(.*?)(?:\s+#.*)?$", value)
    return (match.group(1) if match else value).strip()


def parse_env_file(env_path: Path) -> dict[str, str]:
    if not env_path.is_file():
        raise StartupError("ERROR: Repository-root .env file is missing.")
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(env_path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not match:
            raise StartupError(f"ERROR: Malformed .env entry on line {line_number}.")
        values[match.group(1)] = _parse_env_value(match.group(2), line_number)
    return values


def validate_configuration(env_path: Path, process_environment: Mapping[str, str] | None = None) -> None:
    file_values = parse_env_file(env_path)
    environment = process_environment if process_environment is not None else os.environ

    def effective(name: str) -> str:
        return environment[name] if name in environment else file_values.get(name, "")

    if not TOKEN_PATTERN.fullmatch(effective("TELEGRAM_BOT_TOKEN")):
        raise StartupError("ERROR: TELEGRAM_BOT_TOKEN is missing or invalid.")
    raw_user = effective("TELEGRAM_ALLOWED_USER_ID")
    if not USER_PATTERN.fullmatch(raw_user):
        raise StartupError("ERROR: TELEGRAM_ALLOWED_USER_ID must be a positive numeric ID.")
    if int(raw_user) > 9_007_199_254_740_991:
        raise StartupError("ERROR: TELEGRAM_ALLOWED_USER_ID exceeds the safe integer range.")


def resolve_node_runtime(root: Path, environment: Mapping[str, str] | None = None) -> Path:
    environment = environment if environment is not None else os.environ
    explicit = environment.get("CODEX_POCKET_NODE_EXE")
    if explicit:
        candidate = Path(explicit).resolve()
    else:
        cache_root = Path(environment.get("LOCALAPPDATA", "")) / "npm-cache" / "_npx"
        cached_candidates = sorted(
            cache_root.glob("*/node_modules/node/bin/node.exe"),
            key=lambda item: item.stat().st_mtime if item.exists() else 0,
            reverse=True,
        ) if cache_root.is_dir() else []
        for cached in cached_candidates:
            try:
                cached_version = subprocess.run(
                    [str(cached), "--version"], cwd=root, capture_output=True, text=True, timeout=15, check=True,
                ).stdout.strip()
                if cached_version == f"v{NODE_VERSION}":
                    candidate = cached.resolve()
                    break
            except (OSError, subprocess.SubprocessError):
                continue
        else:
            candidate = None
    if not explicit and candidate is None:
        path_node = shutil.which("node", path=environment.get("PATH"))
        if path_node:
            try:
                path_version = subprocess.run(
                    [path_node, "--version"], cwd=root, capture_output=True, text=True, timeout=15, check=True,
                ).stdout.strip()
                if path_version == f"v{NODE_VERSION}":
                    candidate = Path(path_node).resolve()
            except (OSError, subprocess.SubprocessError):
                pass
    if not explicit and candidate is None:
        npx = shutil.which("npx.cmd") or shutil.which("npx")
        if not npx:
            raise StartupError("ERROR: Required Node 24.19.0 runtime could not be started.")
        try:
            resolved = subprocess.run(
                [npx, "--yes", "--package", f"node@{NODE_VERSION}", "--call", 'node -p "process.execPath"'],
                cwd=root,
                env=dict(environment),
                capture_output=True,
                text=True,
                timeout=120,
                check=True,
            )
            lines = [line.strip() for line in resolved.stdout.splitlines() if line.strip()]
            candidate = Path(lines[-1]).resolve()
        except (OSError, subprocess.SubprocessError, IndexError):
            raise StartupError("ERROR: Required Node 24.19.0 runtime could not be started.") from None
    try:
        version = subprocess.run(
            [str(candidate), "--version"], cwd=root, capture_output=True, text=True, timeout=15, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise StartupError("ERROR: Required Node 24.19.0 runtime could not be started.") from None
    if version != f"v{NODE_VERSION}":
        raise StartupError("ERROR: Required Node 24.19.0 runtime could not be started.")
    return candidate


def validate_node_configuration(root: Path, node: Path, env_path: Path) -> None:
    try:
        result = subprocess.run(
            [str(node), f"--env-file={env_path}", "--import", "tsx", "apps/telegram-bot/src/config-check.ts"],
            cwd=root,
            env=dict(os.environ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        raise StartupError("ERROR: Telegram configuration validation could not run.") from None
    if result.returncode != 0:
        raise StartupError("ERROR: Telegram configuration is invalid.")


def platform_process_matches(pid: int, marker: str) -> bool:
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            result = subprocess.run(
                ["ps", "-p", str(pid), "-o", "command="],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return result.returncode == 0 and marker in result.stdout
        except (OSError, subprocess.SubprocessError):
            return False
    escaped = marker.replace("'", "''")
    command = (
        f"$p=Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction SilentlyContinue; "
        f"if($p -and $p.CommandLine -like '*{escaped}*'){{exit 0}}else{{exit 1}}"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    return result.returncode == 0


@dataclass
class Component:
    name: str
    pid: int
    owned: bool
    process: subprocess.Popen[str] | None = None


class PocketSupervisor:
    def __init__(
        self,
        root: Path,
        node: Path,
        *,
        process_matches: Callable[[int, str], bool] = platform_process_matches,
        popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
        output: TextIO = sys.stdout,
        readiness_timeout: float = 180.0,
        platform: str = sys.platform,
    ) -> None:
        self.root = root
        self.node = node
        self.process_matches = process_matches
        self.popen = popen
        self.output = output
        self.readiness_timeout = readiness_timeout
        self.platform = platform
        self.host_marker = MACOS_HOST_MARKER if platform == "darwin" else HOST_MARKER
        self.host_topology = "sharedAppServer"
        self.host: Component | None = None
        self.bot: Component | None = None
        self._drainers: list[threading.Thread] = []

    @property
    def host_status(self) -> Path:
        return self.root / ".codex-pocket" / "phase-1" / "host-status.json"

    @property
    def connection_file(self) -> Path:
        return self.root / ".codex-pocket" / "phase-1" / "connection.json"

    @property
    def host_stop(self) -> Path:
        return self.root / ".codex-pocket" / "phase-1" / "host-stop"

    @property
    def bot_status(self) -> Path:
        return self.root / ".codex-pocket" / "phase-2" / "bot-status.json"

    @property
    def bot_stop(self) -> Path:
        return self.root / ".codex-pocket" / "phase-2" / "bot-stop"

    @property
    def update_root(self) -> Path:
        return self.root / ".codex-pocket" / "updates"

    @property
    def update_restart(self) -> Path:
        return self.update_root / "restart-request.json"

    @property
    def update_pointer(self) -> Path:
        return self.update_root / "active-extension.json"

    @property
    def update_status(self) -> Path:
        return self.update_root / "status.json"

    def _read_status(self, path: Path) -> dict[str, object] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None

    def _write_json_atomic(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)

    def _existing(self, status_path: Path, marker: str, *, require_connection: bool = False) -> Component | None:
        status = self._read_status(status_path)
        pid = status.get("ownerPid") if status else None
        if not status or status.get("state") != "ready" or not isinstance(pid, int):
            return None
        if require_connection:
            connection = self._read_status(self.connection_file)
            if not connection or connection.get("ownerPid") != pid:
                return None
            verified_at = status.get("verifiedAtMs")
            if (
                status.get("topology") != self.host_topology
                or not isinstance(verified_at, (int, float))
                or time.time() * 1000 - verified_at > 5_000
            ):
                return None
        return Component(marker, pid, False) if self.process_matches(pid, marker) else None

    def _spawn(self, name: str, script: str, *, env_file: bool = False) -> Component:
        arguments = [str(self.node)]
        if env_file:
            arguments.append(f"--env-file={self.root / '.env'}")
        arguments.extend(["--import", "tsx", script])
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        popen_options: dict[str, object] = {}
        if os.name != "nt":
            popen_options["start_new_session"] = True
        process = self.popen(
            arguments,
            cwd=self.root,
            env=dict(os.environ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            creationflags=creationflags,
            **popen_options,
        )
        component = Component(name, process.pid, True, process)
        for stream in (process.stdout, process.stderr):
            if stream is None:
                continue
            thread = threading.Thread(target=self._drain, args=(name, stream), daemon=True)
            thread.start()
            self._drainers.append(thread)
        return component

    def _drain(self, name: str, stream: TextIO) -> None:
        del name
        for _line in stream:
            # Child text is intentionally not printed: it may contain remote API diagnostics.
            pass

    def _wait_ready(self, component: Component, status_path: Path, *, require_connection: bool = False) -> None:
        deadline = time.monotonic() + self.readiness_timeout
        while time.monotonic() < deadline:
            if component.process is not None and component.process.poll() is not None:
                raise StartupError(f"ERROR: {component.name} exited before readiness.")
            status = self._read_status(status_path)
            if status and status.get("state") == "ready" and status.get("ownerPid") == component.pid:
                if not require_connection or self.connection_file.is_file():
                    return
            time.sleep(0.1)
        raise StartupError(f"ERROR: Timed out waiting for {component.name} readiness.")

    def start_or_reuse_host(self) -> Component:
        existing = self._existing(self.host_status, self.host_marker, require_connection=True)
        if existing:
            self.host = existing
            return existing
        self.host = self._spawn("Pocket host", self.host_marker)
        self._wait_ready(self.host, self.host_status, require_connection=True)
        return self.host

    def start_or_reuse_bot(self) -> Component:
        status = self._read_status(self.bot_status)
        pid = status.get("ownerPid") if status else None
        if status and status.get("state") == "ready" and isinstance(pid, int) and self.process_matches(pid, BOT_MARKER):
            if not self.host or status.get("hostOwnerPid") != self.host.pid:
                raise StartupError("ERROR: Existing Telegram bot belongs to a different Pocket host.")
            self.bot = Component("Telegram bot", pid, False)
            return self.bot
        self.bot = self._spawn("Telegram bot", BOT_MARKER, env_file=True)
        self._wait_ready(self.bot, self.bot_status)
        return self.bot

    def start(self) -> None:
        host = self.start_or_reuse_host()
        self.output.write(f"[2/4] Pocket host .......... {'READY' if host.owned else 'ALREADY RUNNING'}\n")
        if self.platform == "darwin":
            self.output.write(f"[3/4] macOS VS Code runtime  {'READY' if host.owned else 'ALREADY RUNNING'}\n")
        else:
            self.output.write(f"[3/4] VS Code .............. {'READY' if host.owned else 'ALREADY RUNNING'}\n")
        bot = self.start_or_reuse_bot()
        self.output.write(f"[4/4] Telegram bot ......... {'CONNECTED' if bot.owned else 'ALREADY RUNNING'}\n")
        self.output.flush()

    def monitor(self) -> None:
        while True:
            if self.platform == "darwin" and self.update_restart.is_file():
                request = self._read_status(self.update_restart)
                not_before = request.get("notBeforeMs") if request else None
                if not isinstance(not_before, (int, float)) or time.time() * 1000 >= not_before:
                    self._perform_update_restart()
            for component in (self.host, self.bot):
                if component and component.owned and component.process and component.process.poll() is not None:
                    raise StartupError(f"ERROR: {component.name} stopped unexpectedly.")
                if component and not component.owned and not self.process_matches(
                    component.pid, self.host_marker if component is self.host else BOT_MARKER
                ):
                    raise StartupError(f"ERROR: Reused {component.name} is no longer running.")
            time.sleep(0.5)

    def _update_record(self, state: str, current: str, available: str, *, previous: str | None = None,
                       rollback_succeeded: bool | None = None, error: str | None = None) -> None:
        existing = self._read_status(self.update_status) or {}
        status = existing.get("status") if isinstance(existing.get("status"), dict) else {}
        status = dict(status)
        status.update({
            "state": state,
            "currentVersion": current,
            "availableVersion": available,
            "checkedAt": status.get("checkedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
            "source": "visualStudioMarketplace",
            "restartRequired": state not in {"ready", "failed", "upToDate"},
        })
        if previous is not None:
            status["previousVersion"] = previous
        if rollback_succeeded is not None:
            status["rollbackSucceeded"] = rollback_succeeded
        if error is not None:
            status["error"] = error[:500]
        else:
            status.pop("error", None)
        self._write_json_atomic(self.update_status, {**existing, "status": status})

    def _restore_update_pointer(self, previous: object) -> None:
        if previous is None:
            self.update_pointer.unlink(missing_ok=True)
            return
        if not isinstance(previous, dict) or previous.get("version") != 1:
            raise StartupError("ERROR: Updater rollback metadata is invalid; manual recovery is required.")
        self._write_json_atomic(self.update_pointer, previous)

    def _verify_updated_host(self, expected_version: str) -> None:
        status = self._read_status(self.host_status)
        if (
            not status
            or status.get("state") != "ready"
            or status.get("extensionVersion") != expected_version
            or status.get("vscodeVersion") != "1.133.0"
            or status.get("vscodeCommit") != "a5b500951314efd502d07465bd138dfbd714a960"
            or status.get("platform") != "darwin-arm64"
            or status.get("topology") != "sharedAppServer"
            or not isinstance(status.get("appServerPid"), int)
            or not isinstance(status.get("bridgePid"), int)
        ):
            raise StartupError("ERROR: Updated Pocket runtime did not pass the full macOS readiness boundary.")

    def _start_fresh_components(self, expected_version: str) -> None:
        self.host = self._spawn("Pocket host", self.host_marker)
        self._wait_ready(self.host, self.host_status, require_connection=True)
        self._verify_updated_host(expected_version)
        self.bot = self._spawn("Telegram bot", BOT_MARKER, env_file=True)
        self._wait_ready(self.bot, self.bot_status)
        bot_status = self._read_status(self.bot_status)
        if not bot_status or bot_status.get("hostOwnerPid") != self.host.pid:
            raise StartupError("ERROR: Telegram did not reconnect to the updated Pocket host.")

    def _perform_update_restart(self) -> None:
        request = self._read_status(self.update_restart)
        candidate = request.get("candidateVersion") if request else None
        previous = request.get("previousVersion") if request else None
        previous_pointer = request.get("previousPointer") if request else None
        requested_by = request.get("requestedByPid") if request else None
        candidate_id = request.get("candidateId") if request else None
        not_before = request.get("notBeforeMs") if request else None
        if (
            not request or request.get("version") != 1 or not isinstance(candidate, str)
            or not isinstance(previous, str) or not isinstance(requested_by, int)
            or not isinstance(candidate_id, str)
            or not re.fullmatch(r"\d+(?:\.\d+)+-[0-9a-f]{16}", candidate_id)
            or not isinstance(not_before, (int, float))
        ):
            raise StartupError("ERROR: Invalid Pocket updater restart request.")
        if not self.host or not self.host.owned or self.host.pid != requested_by or not self.bot or not self.bot.owned:
            self._restore_update_pointer(previous_pointer)
            self._update_record("failed", previous, candidate, rollback_succeeded=True,
                                error="Updater refused restart because exact process ownership was not proven.")
            self.update_restart.unlink(missing_ok=True)
            return
        self._update_record("restarting", previous, candidate, previous=previous)
        try:
            self._stop_owned(self.bot, self.bot_stop)
            self._stop_owned(self.host, self.host_stop)
            self.bot = None
            self.host = None
            self._start_fresh_components(candidate)
            self._update_record("ready", candidate, candidate, previous=previous)
            self.update_restart.unlink(missing_ok=True)
        except Exception:
            self._update_record("rollingBack", previous, candidate, previous=previous,
                                error="Updated runtime failed readiness; restoring previous known-good runtime.")
            try:
                self._stop_owned(self.bot, self.bot_stop)
                self._stop_owned(self.host, self.host_stop)
                self.bot = None
                self.host = None
                self._restore_update_pointer(previous_pointer)
                self._start_fresh_components(previous)
                self._update_record("failed", previous, candidate, previous=previous, rollback_succeeded=True,
                                    error="Update failed readiness; previous known-good runtime was restored.")
                self.update_restart.unlink(missing_ok=True)
            except Exception as rollback_error:
                self._update_record("failed", previous, candidate, previous=previous, rollback_succeeded=False,
                                    error="Update and rollback readiness failed; manual recovery is required.")
                raise StartupError("ERROR: Pocket update rollback could not be proven; manual recovery is required.") from rollback_error

    def _stop_owned(self, component: Component | None, stop_path: Path) -> None:
        if not component or not component.owned or not component.process:
            return
        poll = getattr(component.process, "poll", None)
        if callable(poll) and poll() is not None:
            return
        stop_path.parent.mkdir(parents=True, exist_ok=True)
        stop_path.write_text("stop\n", encoding="utf-8")
        try:
            component.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            component.process.terminate()
            try:
                component.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                component.process.kill()
                component.process.wait(timeout=10)

    def shutdown(self) -> None:
        self.output.write("\nStopping Telegram...\n")
        self._stop_owned(self.bot, self.bot_stop)
        self.output.write("Stopping owned Pocket processes...\n")
        self._stop_owned(self.host, self.host_stop)
        self.output.write("Cleaning owned lifecycle state...\nDone.\n")
        self.output.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Start Codex Pocket's existing TypeScript runtime.")
    parser.parse_args(argv)
    supervisor: PocketSupervisor | None = None
    try:
        root = discover_repository_root(Path(__file__))
        env_path = root / ".env"
        output = sys.stdout
        output.write("Codex Pocket\n" + "─" * 32 + "\n\n")
        validate_configuration(env_path)
        node = resolve_node_runtime(root)
        validate_node_configuration(root, node, env_path)
        output.write("[1/4] Configuration ........ OK\n")
        supervisor = PocketSupervisor(root, node, output=output)
        supervisor.start()
        output.write("\nCodex Pocket is running.\n\nOpen Telegram and use:\n/workspaces\n\nPress Ctrl+C to stop.\n")
        output.flush()
        supervisor.monitor()
    except KeyboardInterrupt:
        return 0
    except StartupError as error:
        sys.stderr.write(f"{error}\n")
        return 1
    finally:
        if supervisor:
            supervisor.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
