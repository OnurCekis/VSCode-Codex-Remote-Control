#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"
FLUTTER_APP="$REPO_ROOT/apps/codex_pocket_ui"
VERSION="$(sed -n 's/^version: \([^+]*\).*/\1/p' "$FLUTTER_APP/pubspec.yaml")"
RUNTIME_VERSION="$(sed -n 's/^version: //p' "$FLUTTER_APP/pubspec.yaml")"
APP_NAME="VS Code Codex Remote Control"
OUTPUT_DIR="$REPO_ROOT/dist"
STAGE_DIR="$(mktemp -d)"
DMG="$OUTPUT_DIR/VSCode-Codex-Remote-Control-${VERSION}-macos-arm64-unsigned.dmg"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

if [[ "$(uname -m)" != "arm64" ]]; then
  print -u2 "ERROR: The current v1 macOS package supports Apple Silicon only."
  exit 1
fi

cd "$FLUTTER_APP"
flutter pub get
flutter analyze
flutter test
flutter build macos --release

APP="$FLUTTER_APP/build/macos/Build/Products/Release/$APP_NAME.app"
if [[ ! -d "$APP" ]]; then
  print -u2 "ERROR: Flutter did not produce $APP_NAME.app."
  exit 1
fi

NODE_SOURCE="$(command -v node)"
if [[ "$("$NODE_SOURCE" --version)" != "v24.19.0" ]] || ! file "$NODE_SOURCE" | grep -q "arm64"; then
  print -u2 "ERROR: Packaging requires the verified Apple Silicon Node v24.19.0 runtime."
  exit 1
fi

RUNTIME="$APP/Contents/Resources/pocket-runtime"
PROXY_TYPESCRIPT="$REPO_ROOT/tools/vscode-proxy/main.ts"
PROXY_TYPESCRIPT_SHA256="47c8b93e19fc5bb10cf50881098fc934c16c6b267ddf4d139818fb55e2fa64ad"
DENO_SOURCE="$REPO_ROOT/node_modules/.pnpm/deno@2.9.6/node_modules/deno/deno"
DENO_SHA256="b3ac3bd206e48c26026cadd80c1367e96c149f9c66130952382a642b09fa8a71"
PROXY_SOURCE="$STAGE_DIR/codex-pocket-proxy"
if [[ "$(shasum -a 256 "$PROXY_TYPESCRIPT" | awk '{print $1}')" != "$PROXY_TYPESCRIPT_SHA256" ]]; then
  print -u2 "ERROR: Pocket proxy source changed without a packaging review."
  exit 1
fi
if [[ ! -x "$DENO_SOURCE" ]] || [[ "$(shasum -a 256 "$DENO_SOURCE" | awk '{print $1}')" != "$DENO_SHA256" ]]; then
  print -u2 "ERROR: Packaging requires the verified Deno 2.9.6 Apple Silicon runtime."
  exit 1
fi
"$DENO_SOURCE" compile --quiet --no-config --node-modules-dir=none \
  --allow-env --allow-read --allow-write --allow-run --allow-net=127.0.0.1 \
  --output "$PROXY_SOURCE" "$PROXY_TYPESCRIPT"
PROXY_SHA256="$(shasum -a 256 "$PROXY_SOURCE" | awk '{print $1}')"
PROXY_SHA256_UPPER="${PROXY_SHA256:u}"
if [[ "$RUNTIME" != "$APP/Contents/Resources/pocket-runtime" ]] || [[ ! -d "$APP/Contents/Resources" ]]; then
  print -u2 "ERROR: Refusing unsafe runtime bundle destination."
  exit 1
fi
/bin/rm -rf "$RUNTIME"
mkdir -p "$RUNTIME/bin" "$RUNTIME/apps/ipc-probe" "$RUNTIME/apps/pocket-cli" \
  "$RUNTIME/apps/telegram-bot" "$RUNTIME/apps/pocket-ui-bridge" "$RUNTIME/tools" "$RUNTIME/artifacts"
cp "$NODE_SOURCE" "$RUNTIME/bin/node"
chmod 700 "$RUNTIME/bin/node"
ditto "$REPO_ROOT/apps/ipc-probe/src" "$RUNTIME/apps/ipc-probe/src"
ditto "$REPO_ROOT/apps/pocket-cli/src" "$RUNTIME/apps/pocket-cli/src"
ditto "$REPO_ROOT/apps/telegram-bot/src" "$RUNTIME/apps/telegram-bot/src"
ditto "$REPO_ROOT/apps/telegram-bot/node_modules" "$RUNTIME/apps/telegram-bot/node_modules"
ditto "$REPO_ROOT/apps/pocket-ui-bridge/src" "$RUNTIME/apps/pocket-ui-bridge/src"
ditto "$REPO_ROOT/packages" "$RUNTIME/packages"
ditto "$REPO_ROOT/tools/vscode-proxy" "$RUNTIME/tools/vscode-proxy"
ditto "$REPO_ROOT/node_modules" "$RUNTIME/node_modules"
# The Cloudflare-only workspace is not used by the desktop runtime. Its pnpm
# workspace link points outside the app bundle and must not enter the signed app.
if [[ -L "$RUNTIME/node_modules/.pnpm/node_modules/@codex-pocket/relay" ]]; then
  /bin/rm "$RUNTIME/node_modules/.pnpm/node_modules/@codex-pocket/relay"
fi
cp "$REPO_ROOT/package.json" "$RUNTIME/package.json"
sed -i '' "s/export const MACOS_PROXY_SHA256 = \"[A-F0-9]*\";/export const MACOS_PROXY_SHA256 = \"$PROXY_SHA256_UPPER\";/" \
  "$RUNTIME/apps/pocket-cli/src/macos-vscode-runtime.ts"
if ! grep -q "MACOS_PROXY_SHA256 = \"$PROXY_SHA256_UPPER\"" "$RUNTIME/apps/pocket-cli/src/macos-vscode-runtime.ts"; then
  print -u2 "ERROR: Failed to pin the compiled Pocket proxy in the packaged runtime."
  exit 1
fi
cp "$PROXY_SOURCE" "$RUNTIME/artifacts/codex-pocket-proxy"
chmod 700 "$RUNTIME/artifacts/codex-pocket-proxy"
print "$RUNTIME_VERSION" > "$RUNTIME/runtime-version.txt"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p "$OUTPUT_DIR" "$STAGE_DIR/$APP_NAME"
cp -R "$APP" "$STAGE_DIR/$APP_NAME/"
ln -s /Applications "$STAGE_DIR/$APP_NAME/Applications"
cp "$REPO_ROOT/docs/macos-installation.md" "$STAGE_DIR/$APP_NAME/READ ME.md"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE_DIR/$APP_NAME" -ov -format UDZO "$DMG"

print "Created: $DMG"
shasum -a 256 "$DMG"
