#!/usr/bin/env bash
# Build the Skywright Android app (debug-signed APK for sideloading) and optionally install it.
#
#   tools/native/build_android.sh            build native/android/app/build/outputs/apk/debug/app-debug.apk
#   tools/native/build_android.sh --install  ...and adb install it on the connected tablet (USB debugging on)
#   tools/native/build_android.sh --lite     bundle the offline copy without assets/real (smaller APK)
#   tools/native/build_android.sh --release  release APK signed with the permanent key (SKYWRIGHT_KEYSTORE* env, or
#                                            ~/.config/skywright/android-release.env); CI does this, see .github/workflows/android.yml
#
# Needs: Node/npm, a JDK 21 and the Android SDK (see native/README.md, "One-time setup").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NATIVE="$ROOT/native"
INSTALL=0; RELEASE=0; WWW_ARGS=()
for a in "$@"; do case "$a" in
  --install) INSTALL=1 ;;
  --lite) WWW_ARGS+=(--lite) ;;
  --release) RELEASE=1 ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  *) echo "unknown option: $a" >&2; exit 2 ;;
esac; done
fail() { echo; echo "✗ $1" >&2; shift; for l in "$@"; do echo "  $l" >&2; done; exit 1; }

# --- prerequisites ---
command -v node >/dev/null && command -v npm >/dev/null || fail "Node.js is missing." "brew install node"

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  for c in /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
           "/Applications/Android Studio.app/Contents/jbr/Contents/Home" "$(/usr/libexec/java_home -v 21 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c/bin/java" ]; then export JAVA_HOME="$c"; break; fi
  done
fi
[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ] || fail "No JDK found (need Java 21)." \
  "brew install openjdk@21      (or install Android Studio, which bundles one)" "or set JAVA_HOME to a JDK 21."
JV="$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
[ "$JV" -ge 21 ] 2>/dev/null || fail "JAVA_HOME ($JAVA_HOME) is Java $JV; Gradle for this project needs Java 21." "brew install openjdk@21"

if [ -z "${ANDROID_HOME:-}" ]; then
  for c in "${ANDROID_SDK_ROOT:-}" /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools "$HOME/Library/Android/sdk"; do
    if [ -n "$c" ] && [ -d "$c/platform-tools" -o -d "$c/cmdline-tools" ]; then export ANDROID_HOME="$c"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ] || fail "No Android SDK found." \
  "brew install --cask android-commandlinetools   (or install Android Studio and open it once)" "or set ANDROID_HOME to your SDK folder."
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# SDK packages the project compiles against (compileSdkVersion in native/android/variables.gradle)
COMPILE_SDK="$(sed -nE 's/.*compileSdkVersion *= *([0-9]+).*/\1/p' "$NATIVE/android/variables.gradle")"
if [ ! -d "$ANDROID_HOME/platforms/android-$COMPILE_SDK" ]; then
  SDKM="$(command -v sdkmanager || ls "$ANDROID_HOME"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -1 || true)"
  [ -n "$SDKM" ] || fail "Android platform $COMPILE_SDK is not installed and sdkmanager wasn't found." "Install 'Android SDK Platform $COMPILE_SDK' from Android Studio's SDK Manager."
  echo "→ installing Android SDK platform $COMPILE_SDK (one time)"
  yes | "$SDKM" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
  "$SDKM" --sdk_root="$ANDROID_HOME" "platforms;android-$COMPILE_SDK" "platform-tools" || fail "sdkmanager couldn't install platforms;android-$COMPILE_SDK."
fi
echo "sdk.dir=$ANDROID_HOME" > "$NATIVE/android/local.properties"

# --- build ---
cd "$NATIVE"
[ -d node_modules/@capacitor/cli ] || { echo "→ npm install (native/)"; npm install --no-audit --no-fund; }
echo "→ copying the site into native/www (the offline fallback)"
node scripts/sync-www.mjs "${WWW_ARGS[@]+"${WWW_ARGS[@]}"}"
npx cap sync android
if [ "$RELEASE" = 1 ]; then
  if [ -z "${SKYWRIGHT_KEYSTORE:-}" ] && [ -f "$HOME/.config/skywright/android-release.env" ]; then set -a; . "$HOME/.config/skywright/android-release.env"; set +a; fi
  [ -n "${SKYWRIGHT_KEYSTORE:-}" ] && [ -f "$SKYWRIGHT_KEYSTORE" ] || fail "No release key (SKYWRIGHT_KEYSTORE)." "Expected ~/.config/skywright/android-release.env, or build without --release for a debug APK."
  echo "→ gradle assembleRelease"
  (cd android && ./gradlew --no-daemon assembleRelease) || fail "Gradle build failed (see the output above)."
  APK="$NATIVE/android/app/build/outputs/apk/release/app-release.apk"
else
  echo "→ gradle assembleDebug"
  (cd android && ./gradlew --no-daemon assembleDebug) || fail "Gradle build failed (see the output above)."
  APK="$NATIVE/android/app/build/outputs/apk/debug/app-debug.apk"
fi
[ -f "$APK" ] || fail "Build finished but $APK is missing."
echo; echo "✓ APK: $APK ($(du -h "$APK" | cut -f1))"

if [ "$INSTALL" = 1 ]; then
  ADB="$(command -v adb || echo "$ANDROID_HOME/platform-tools/adb")"
  [ -x "$ADB" ] || fail "adb not found." "sdkmanager platform-tools  (or brew install --cask android-platform-tools)"
  [ -n "$("$ADB" devices | sed 1d | grep -w device || true)" ] || fail "No Android device connected." \
    "Plug the tablet in by USB, turn on Developer options > USB debugging, and accept the prompt on the tablet." "Check with: adb devices"
  "$ADB" install -r "$APK" && echo "✓ installed on the tablet"
else
  echo "  Install: adb install -r \"$APK\"   (or run this script with --install, or copy the APK to the tablet)"
fi
