from __future__ import annotations

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import main


VALID_TOKEN = "123456:" + "A" * 35


class FakeProcess:
    def __init__(self, pid: int = 9001) -> None:
        self.pid = pid
        self.wait_calls: list[float | None] = []
        self.terminated = False
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        return 0

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


class MainConfigurationTests(unittest.TestCase):
    def test_repository_root_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "package.json").write_text("{}", encoding="utf-8")
            (root / "pnpm-workspace.yaml").write_text("packages: []", encoding="utf-8")
            nested = root / "a" / "b"
            nested.mkdir(parents=True)
            self.assertEqual(main.discover_repository_root(nested), root)

    def test_missing_env_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(main.StartupError, r"\.env file is missing"):
                main.validate_configuration(Path(temporary) / ".env", {})

    def test_missing_token_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env_path = Path(temporary) / ".env"
            env_path.write_text("TELEGRAM_ALLOWED_USER_ID=42\n", encoding="utf-8")
            with self.assertRaisesRegex(main.StartupError, "TELEGRAM_BOT_TOKEN"):
                main.validate_configuration(env_path, {})

    def test_missing_or_malformed_user_id_fails_closed(self) -> None:
        for raw_user in ("", "name", "0", "-1"):
            with self.subTest(raw_user=raw_user), tempfile.TemporaryDirectory() as temporary:
                env_path = Path(temporary) / ".env"
                env_path.write_text(
                    f"TELEGRAM_BOT_TOKEN={VALID_TOKEN}\nTELEGRAM_ALLOWED_USER_ID={raw_user}\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(main.StartupError, "TELEGRAM_ALLOWED_USER_ID"):
                    main.validate_configuration(env_path, {})

    def test_explicit_environment_takes_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            env_path = Path(temporary) / ".env"
            env_path.write_text(
                f"TELEGRAM_BOT_TOKEN={VALID_TOKEN}\nTELEGRAM_ALLOWED_USER_ID=bad\n",
                encoding="utf-8",
            )
            main.validate_configuration(env_path, {"TELEGRAM_ALLOWED_USER_ID": "424242"})

    def test_secret_value_is_never_in_validation_error(self) -> None:
        secret = "987654:" + "S" * 35
        with tempfile.TemporaryDirectory() as temporary:
            env_path = Path(temporary) / ".env"
            env_path.write_text(
                f"TELEGRAM_BOT_TOKEN={secret}\nTELEGRAM_ALLOWED_USER_ID=invalid\n",
                encoding="utf-8",
            )
            try:
                main.validate_configuration(env_path, {})
            except main.StartupError as error:
                self.assertNotIn(secret, str(error))
            else:
                self.fail("Expected invalid configuration to fail.")

    def test_cached_exact_node_is_reused_without_npx(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cached = root / "npm-cache" / "_npx" / "fixture" / "node_modules" / "node" / "bin" / "node.exe"
            cached.parent.mkdir(parents=True)
            cached.write_bytes(b"fixture")
            completed = Mock(stdout=f"v{main.NODE_VERSION}\n")
            with patch("main.subprocess.run", return_value=completed) as run, patch("main.shutil.which") as which:
                result = main.resolve_node_runtime(root, {"LOCALAPPDATA": str(root)})
            self.assertEqual(result, cached.resolve())
            self.assertEqual(run.call_count, 2)
            which.assert_not_called()

    def test_exact_node_on_path_is_reused_on_macos_without_npx(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            node = root / "bin" / "node"
            node.parent.mkdir()
            node.write_bytes(b"fixture")
            completed = Mock(stdout=f"v{main.NODE_VERSION}\n")
            with patch("main.subprocess.run", return_value=completed) as run, patch("main.shutil.which", return_value=str(node)) as which:
                result = main.resolve_node_runtime(root, {"PATH": str(node.parent)})
            self.assertEqual(result, node.resolve())
            self.assertEqual(run.call_count, 2)
            which.assert_called_once_with("node", path=str(node.parent))


class MainSupervisorTests(unittest.TestCase):
    def supervisor(self, root: Path, **options: object) -> main.PocketSupervisor:
        return main.PocketSupervisor(
            root,
            Path("C:/node24/node.exe"),
            output=io.StringIO(),
            platform="win32",
            **options,  # type: ignore[arg-type]
        )

    def test_child_startup_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.supervisor(Path(temporary))
            order: list[str] = []
            host = main.Component("Pocket host", 1, True)
            bot = main.Component("Telegram bot", 2, True)
            supervisor.start_or_reuse_host = Mock(side_effect=lambda: (order.append("host"), host)[1])  # type: ignore[method-assign]
            supervisor.start_or_reuse_bot = Mock(side_effect=lambda: (order.append("bot"), bot)[1])  # type: ignore[method-assign]
            supervisor.start()
            self.assertEqual(order, ["host", "bot"])

    def test_host_failure_prevents_bot_start(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.supervisor(Path(temporary))
            supervisor.start_or_reuse_host = Mock(side_effect=main.StartupError("host failed"))  # type: ignore[method-assign]
            supervisor.start_or_reuse_bot = Mock()  # type: ignore[method-assign]
            with self.assertRaisesRegex(main.StartupError, "host failed"):
                supervisor.start()
            supervisor.start_or_reuse_bot.assert_not_called()

    def test_existing_owned_host_is_reused_without_spawning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = root / ".codex-pocket" / "phase-1" / "host-status.json"
            connection = status.parent / "connection.json"
            status.parent.mkdir(parents=True)
            status.write_text(json.dumps({
                "state": "ready", "ownerPid": 77, "topology": "sharedAppServer",
                "verifiedAtMs": __import__("time").time() * 1000,
            }), encoding="utf-8")
            connection.write_text(json.dumps({"ownerPid": 77}), encoding="utf-8")
            spawn = Mock(side_effect=AssertionError("must not spawn"))
            supervisor = self.supervisor(root, process_matches=lambda pid, marker: pid == 77 and marker == main.HOST_MARKER, popen=spawn)
            component = supervisor.start_or_reuse_host()
            self.assertFalse(component.owned)
            self.assertEqual(component.pid, 77)
            spawn.assert_not_called()

    def test_stale_host_status_is_not_reused_as_vscode_ready(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = root / ".codex-pocket" / "phase-1" / "host-status.json"
            connection = status.parent / "connection.json"
            status.parent.mkdir(parents=True)
            status.write_text(json.dumps({
                "state": "ready", "ownerPid": 77, "topology": "sharedAppServer", "verifiedAtMs": 1,
            }), encoding="utf-8")
            connection.write_text(json.dumps({"ownerPid": 77}), encoding="utf-8")
            supervisor = self.supervisor(root, process_matches=lambda pid, marker: True)
            self.assertIsNone(supervisor._existing(status, main.HOST_MARKER, require_connection=True))

    def test_existing_bot_is_reused_only_for_the_same_host(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = root / ".codex-pocket" / "phase-2" / "bot-status.json"
            status.parent.mkdir(parents=True)
            status.write_text(
                json.dumps({"state": "ready", "ownerPid": 88, "hostOwnerPid": 77}), encoding="utf-8",
            )
            spawn = Mock(side_effect=AssertionError("must not spawn"))
            supervisor = self.supervisor(root, process_matches=lambda pid, marker: pid == 88 and marker == main.BOT_MARKER, popen=spawn)
            supervisor.host = main.Component("Pocket host", 77, False)
            component = supervisor.start_or_reuse_bot()
            self.assertFalse(component.owned)
            self.assertEqual(component.pid, 88)
            spawn.assert_not_called()

    def test_shutdown_targets_only_launcher_owned_components(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            supervisor = self.supervisor(root)
            bot_process = FakeProcess()
            supervisor.bot = main.Component("Telegram bot", bot_process.pid, True, bot_process)  # type: ignore[arg-type]
            supervisor.host = main.Component("Pocket host", 1234, False)
            supervisor.shutdown()
            self.assertTrue(supervisor.bot_stop.is_file())
            self.assertFalse(supervisor.host_stop.exists())
            self.assertEqual(bot_process.wait_calls, [30])
            self.assertFalse(bot_process.terminated)

    def test_daily_vscode_is_never_a_shutdown_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.supervisor(Path(temporary))
            daily_code = FakeProcess(pid=555)
            supervisor.host = main.Component("Daily VS Code", daily_code.pid, False, daily_code)  # type: ignore[arg-type]
            supervisor.shutdown()
            self.assertEqual(daily_code.wait_calls, [])
            self.assertFalse(daily_code.terminated)
            self.assertFalse(daily_code.killed)

    def test_child_output_is_drained_without_printing_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = io.StringIO()
            supervisor = main.PocketSupervisor(Path(temporary), Path("C:/node24/node.exe"), output=output)
            supervisor._drain("child", io.StringIO(f"remote error with {VALID_TOKEN}\n"))
            self.assertNotIn(VALID_TOKEN, output.getvalue())

    def test_macos_reports_vscode_ready_and_then_starts_telegram(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = io.StringIO()
            supervisor = main.PocketSupervisor(
                Path(temporary), Path("/node24/bin/node"), output=output, platform="darwin",
            )
            supervisor.start_or_reuse_host = Mock(return_value=main.Component("Pocket host", 1, True))  # type: ignore[method-assign]
            supervisor.start_or_reuse_bot = Mock(return_value=main.Component("Telegram bot", 2, True))  # type: ignore[method-assign]
            supervisor.start()
            supervisor.start_or_reuse_bot.assert_called_once()
            self.assertIn("Pocket host .......... READY", output.getvalue())
            self.assertIn("macOS VS Code runtime  READY", output.getvalue())

    def test_posix_process_match_requires_the_expected_command_marker(self) -> None:
        completed = Mock(returncode=0, stdout="node --import tsx apps/pocket-cli/src/macos-host.ts\n")
        with patch("main.os.name", "posix"), patch("main.subprocess.run", return_value=completed):
            self.assertTrue(main.platform_process_matches(42, main.MACOS_HOST_MARKER))
            self.assertFalse(main.platform_process_matches(42, main.HOST_MARKER))

    def updater_supervisor(self, root: Path) -> main.PocketSupervisor:
        return main.PocketSupervisor(root, Path("/node24/bin/node"), output=io.StringIO(), platform="darwin")

    def write_restart(self, supervisor: main.PocketSupervisor, *, owner: int = 101) -> None:
        supervisor.update_root.mkdir(parents=True)
        supervisor.update_pointer.write_text(json.dumps({
            "version": 1, "candidateId": "26.904.1-aaaaaaaaaaaaaaaa", "extensionVersion": "26.904.1",
        }), encoding="utf-8")
        supervisor.update_restart.write_text(json.dumps({
            "version": 1, "requestedByPid": owner, "candidateVersion": "26.904.1",
            "candidateId": "26.904.1-aaaaaaaaaaaaaaaa", "previousVersion": "26.903.61454",
            "notBeforeMs": 0,
            "previousPointer": None,
        }), encoding="utf-8")
        supervisor.update_status.write_text(json.dumps({"status": {
            "state": "restarting", "currentVersion": "26.903.61454", "availableVersion": "26.904.1",
            "checkedAt": "2026-09-10T00:00:00Z", "source": "visualStudioMarketplace", "restartRequired": True,
        }}), encoding="utf-8")

    def test_owned_update_restart_stops_telegram_and_host_then_reconnects(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.updater_supervisor(Path(temporary))
            self.write_restart(supervisor)
            host_process = FakeProcess(101)
            bot_process = FakeProcess(102)
            supervisor.host = main.Component("Pocket host", 101, True, host_process)  # type: ignore[arg-type]
            supervisor.bot = main.Component("Telegram bot", 102, True, bot_process)  # type: ignore[arg-type]
            supervisor._start_fresh_components = Mock(side_effect=lambda version: setattr(  # type: ignore[method-assign]
                supervisor, "host", main.Component("Pocket host", 201, True, FakeProcess(201))
            ))
            supervisor._perform_update_restart()
            self.assertEqual(bot_process.wait_calls, [30])
            self.assertEqual(host_process.wait_calls, [30])
            supervisor._start_fresh_components.assert_called_once_with("26.904.1")
            self.assertEqual(json.loads(supervisor.update_status.read_text())["status"]["state"], "ready")
            self.assertFalse(supervisor.update_restart.exists())

    def test_failed_new_runtime_restores_previous_pointer_and_proves_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.updater_supervisor(Path(temporary))
            self.write_restart(supervisor)
            supervisor.host = main.Component("Pocket host", 101, True, FakeProcess(101))  # type: ignore[arg-type]
            supervisor.bot = main.Component("Telegram bot", 102, True, FakeProcess(102))  # type: ignore[arg-type]
            calls: list[str] = []

            def restart(version: str) -> None:
                calls.append(version)
                if len(calls) == 1:
                    raise main.StartupError("candidate readiness failed")
                supervisor.host_status.parent.mkdir(parents=True, exist_ok=True)
                supervisor.host_status.write_text(json.dumps({
                    "state": "ready", "extensionVersion": version,
                    "vscodeVersion": "1.133.0",
                    "vscodeCommit": "a5b500951314efd502d07465bd138dfbd714a960",
                    "platform": "darwin-arm64", "topology": "sharedAppServer",
                    "appServerPid": 401, "bridgePid": 402,
                }), encoding="utf-8")
                supervisor._verify_updated_host(version)
                supervisor.host = main.Component("Pocket host", 301, True, FakeProcess(301))  # type: ignore[arg-type]
                supervisor.bot = main.Component("Telegram bot", 302, True, FakeProcess(302))  # type: ignore[arg-type]

            supervisor._start_fresh_components = Mock(side_effect=restart)  # type: ignore[method-assign]
            supervisor._perform_update_restart()
            self.assertEqual(calls, ["26.904.1", "26.903.61454"])
            self.assertEqual(supervisor.host.pid, 301)
            self.assertEqual(supervisor.bot.pid, 302)
            self.assertFalse(supervisor.update_pointer.exists())
            status = json.loads(supervisor.update_status.read_text())["status"]
            self.assertEqual(status["state"], "failed")
            self.assertTrue(status["rollbackSucceeded"])
            self.assertFalse(supervisor.update_restart.exists())

    def test_rollback_failure_is_fail_closed_and_requires_manual_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.updater_supervisor(Path(temporary))
            self.write_restart(supervisor)
            supervisor.host = main.Component("Pocket host", 101, True, FakeProcess(101))  # type: ignore[arg-type]
            supervisor.bot = main.Component("Telegram bot", 102, True, FakeProcess(102))  # type: ignore[arg-type]
            supervisor._start_fresh_components = Mock(side_effect=main.StartupError("not ready"))  # type: ignore[method-assign]
            with self.assertRaisesRegex(main.StartupError, "manual recovery"):
                supervisor._perform_update_restart()
            status = json.loads(supervisor.update_status.read_text())["status"]
            self.assertEqual(status["state"], "failed")
            self.assertFalse(status["rollbackSucceeded"])

    def test_update_refuses_restart_without_exact_host_and_bot_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            supervisor = self.updater_supervisor(Path(temporary))
            self.write_restart(supervisor)
            supervisor.host = main.Component("Pocket host", 101, False)
            supervisor.bot = main.Component("Telegram bot", 102, False)
            supervisor._perform_update_restart()
            status = json.loads(supervisor.update_status.read_text())["status"]
            self.assertEqual(status["state"], "failed")
            self.assertTrue(status["rollbackSucceeded"])
            self.assertFalse(supervisor.update_pointer.exists())


if __name__ == "__main__":
    unittest.main()
