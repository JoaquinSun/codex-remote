#!/usr/bin/env bash
# Build the native macOS client into macos/build/Codex Remote Server.app.
# Usage: bash scripts/build-macos.sh [--no-zip]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="${ROOT}/macos"
APP_NAME="Codex Remote Server"
BUILD_DIR="${PACKAGE}/build"
APP="${BUILD_DIR}/${APP_NAME}.app"
INFO_PLIST="${PACKAGE}/Resources/Info.plist"
ICON="${PACKAGE}/Assets/AppIcon.icns"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${INFO_PLIST}")"
ARCH="$(uname -m)"
ARCHIVE="${BUILD_DIR}/CodexRemoteServer-${VERSION}-macOS-${ARCH}.zip"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS client can only be built on macOS." >&2
  exit 1
fi

for command in swift ditto codesign; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "missing build tool: ${command}" >&2
    exit 1
  fi
done

SWIFT_ARGS=(build --package-path "${PACKAGE}" -c release -debug-info-format none
  -Xswiftc -file-prefix-map -Xswiftc "${ROOT}=."
  -Xswiftc -debug-prefix-map -Xswiftc "${ROOT}=.")
if [[ "${CODEX_REMOTE_SWIFT_NO_SANDBOX:-0}" == "1" ]]; then
  # Needed in sandboxed CI/agent environments where nested sandbox-exec is denied.
  SWIFT_ARGS+=(--disable-sandbox)
fi

echo "==> Building Swift package (release)"
BIN_DIR="$(swift "${SWIFT_ARGS[@]}" --show-bin-path)"
swift "${SWIFT_ARGS[@]}"

echo "==> Assembling ${APP}"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources/bridge"
cp "${BIN_DIR}/CodexRemote" "${APP}/Contents/MacOS/CodexRemote"
# Avoid shipping local build paths and debugger symbols in the public binary.
strip -S "${APP}/Contents/MacOS/CodexRemote"
cp "${INFO_PLIST}" "${APP}/Contents/Info.plist"
printf 'APPL????' > "${APP}/Contents/PkgInfo"
if [[ -f "${ICON}" ]]; then
  cp "${ICON}" "${APP}/Contents/Resources/AppIcon.icns"
fi

# The bridge is bundled so the .app works without a separate checkout.
cp -R "${ROOT}/bin" "${APP}/Contents/Resources/bridge/bin"
cp -R "${ROOT}/src" "${APP}/Contents/Resources/bridge/src"
cp -R "${ROOT}/public" "${APP}/Contents/Resources/bridge/public"
chmod +x "${APP}/Contents/Resources/bridge/bin/codex-remote"

# Remove Finder metadata so an ad-hoc signature is deterministic.
xattr -cr "${APP}" 2>/dev/null || true
codesign --force --deep --sign - "${APP}" >/dev/null
codesign --verify --deep --strict "${APP}"

if [[ "${1:-}" != "--no-zip" ]]; then
  echo "==> Creating zip"
  ditto -c -k --norsrc --noextattr --noqtn --noacl --keepParent "${APP}" "${ARCHIVE}"
  (
    cd "${BUILD_DIR}"
    shasum -a 256 "$(basename "${ARCHIVE}")" > SHA256SUMS.txt
  )
  echo "Archive: ${ARCHIVE}"
fi

echo
echo "Built: ${APP}"
echo "Open : open \"${APP}\""
echo "Note : first launch may require right-click → Open (ad-hoc signature)."
