# Generated App Server contracts

Generated files come from the Codex executable bundled with VS Code extension `openai.chatgpt-26.814.41407-win32-x64` (`codex-cli 0.148.0-alpha.15`, SHA-256 `17E4FED6D6676AE0B894A7C39821DD1C50C1A786EEFB05362A3F9FDA678AF466`). Do not edit generated files by hand.

The complete experimental output is intentionally ignored because this CLI version emits more than a thousand generated files and roughly 170 MB. Generation remains a required local compatibility check before changing Codex versions.

Regenerate after deliberately selecting a new binary:

```powershell
$env:CODEX_POCKET_CODEX_EXE = 'C:\absolute\path\to\codex.exe'
npx pnpm@11.22.0 protocol:generate
```

Any version change requires rerunning typecheck, unit tests, the stdio smoke test, and the full two-client approval gate.
