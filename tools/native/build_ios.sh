#!/usr/bin/env bash
# Build the Skywright iPad app and put it on the iPad.
#
#   tools/native/build_ios.sh                  copy the site in, sync the Xcode project, open it in Xcode
#                                              (then pick the iPad at the top and press Run, ⌘R)
#   TEAM=ABCDE12345 tools/native/build_ios.sh --install
#                                              build from the command line and install on the connected iPad
#   tools/native/build_ios.sh --lite           bundle the offline copy without assets/real (smaller app)
#
# TEAM is your Apple development team id (Xcode > Settings > Accounts > your Apple ID > the team's id, or the
# 10-character id Xcode shows under Signing & Capabilities). Needs Node/npm and Xcode: see native/README.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATIVE="$ROOT/native"
INSTALL=0; WWW_ARGS=()
for a in "$@"; do case "$a" in
  --install) INSTALL=1 ;;
  --lite) WWW_ARGS+=(--lite) ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) echo "unknown option: $a" >&2; exit 2 ;;
esac; done
fail() { echo; echo "✗ $1" >&2; shift; for l in "$@"; do echo "  $l" >&2; done; exit 1; }

# --- prerequisites ---
[ "$(uname)" = Darwin ] || fail "iOS apps can only be built on a Mac."
command -v node >/dev/null && command -v npm >/dev/null || fail "Node.js is missing." "brew install node"
if ! xcodebuild -version >/dev/null 2>&1; then
  if [ -d /Applications/Xcode.app ]; then
    fail "Xcode is installed but not selected (or its first-launch setup hasn't run)." \
      "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" "sudo xcodebuild -runFirstLaunch" "then open Xcode once and accept the licence."
  fi
  fail "Xcode is missing (the Command Line Tools alone can't build iOS apps)." "Install Xcode from the Mac App Store, open it once, then:" \
    "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
fi
xcodebuild -showsdks 2>/dev/null | grep -q iphoneos || fail "Xcode has no iOS platform installed." \
  "Xcode > Settings > Components (or Platforms) > iOS: Get.   Or: xcodebuild -downloadPlatform iOS"

# --- sync ---
cd "$NATIVE"
[ -d node_modules/@capacitor/cli ] || { echo "→ npm install (native/)"; npm install --no-audit --no-fund; }
echo "→ copying the site into native/www (the offline fallback)"
node scripts/sync-www.mjs "${WWW_ARGS[@]+"${WWW_ARGS[@]}"}"
npx cap sync ios

if [ "$INSTALL" = 0 ]; then
  echo "→ opening Xcode. First time: select the App target > Signing & Capabilities > Team: your Apple ID."
  echo "  Then choose your iPad in the device menu at the top and press Run (⌘R)."
  npx cap open ios
  exit 0
fi

# --- command-line build + install ---
[ -n "${TEAM:-}" ] || fail "--install needs your Apple team id in TEAM." \
  "Find it in Xcode > Settings > Accounts (select your Apple ID; the Personal Team's id), then:" \
  "TEAM=ABCDE12345 tools/native/build_ios.sh --install" "Or run without --install and press Run in Xcode instead."
DEVICE="$(xcrun devicectl list devices 2>/dev/null | awk '/connected|available \(paired\)/ && /iPad|iPhone/ {for(i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F-]+$/) {print $i; exit}}')"
[ -n "$DEVICE" ] || fail "No iPad found." "Connect it by cable, unlock it, tap Trust, and turn on Settings > Privacy & Security > Developer Mode." \
  "Check with: xcrun devicectl list devices"
OUT="$NATIVE/ios/build"
echo "→ xcodebuild (team $TEAM)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination "id=$DEVICE" \
  -derivedDataPath "$OUT" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" build \
  || fail "xcodebuild failed (see above). Signing errors: open the project in Xcode once (run this script without --install) and set the Team."
APP="$(ls -d "$OUT"/Build/Products/Debug-iphoneos/App.app)"
echo "→ installing on $DEVICE"
xcrun devicectl device install app --device "$DEVICE" "$APP" || fail "Install failed (is the iPad unlocked?)."
echo "✓ installed. First launch: Settings > General > VPN & Device Management > trust your developer profile."
echo "  With a free Apple ID the app stops opening after 7 days: run this again to renew it."
