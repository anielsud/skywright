# Skywright apps (Android + iPad)

Capacitor shells that turn Skywright into real apps for **our own tablets**: no Play Store, no App Store.
The web app one folder up stays a no-build site; everything native lives here, with its own `package.json`
(`node_modules/` and `www/` are git-ignored).

## How it works (and how updates flow)

The app is a full-screen web view that **runs the live site**, `https://anielsud.github.io/skywright/`
(`server.url` in `capacitor.config.json`). So:

- **Every release reaches the apps automatically.** Merge to `main` → the Pages deploy runs → the app picks it up
  exactly like the browser does (the in-game update check reloads within a minute or on next launch). No app rebuild.
- **Offline works the same way as the installed web app.** The site's service worker (`sw.js`) caches the game on
  first launch, so later launches work with no network. Service workers run in the Android WebView, and on iOS
  WKWebView once the site is an *App-Bound Domain* (set up in `ios/App/App/Info.plist` + `capacitor.config.json`).
- **Bundled fallback.** The app also carries a copy of the whole site (`native/www`, made by `scripts/sync-www.mjs`).
  It is shown only if the live site can't load *at all*: very first launch with no network, or the offline cache
  was cleared. Android serves it from `https://appassets.androidplatform.net/` (see `MainActivity.java`), iOS from
  `capacitor://localhost/` (Capacitor's `server.errorPath`). Once the network is back, close the app fully and
  reopen it to return to the live site.
  - The fallback is a different web origin, so it has its **own saved vehicles and settings** (normally empty).
    That's why it is only a safety net.
  - It's as new as the last app build. Rebuild the app now and then (or never; the live site is what's normally used).
- **Saves are per app.** Vehicles saved in the browser or the home-screen web app don't appear in the app (and the
  other way round): each has its own storage. Use the game's share/export to move a vehicle across.

Why not bundle the site and push updates into it instead? That needs a live-update plugin, a zip of every release
built in CI, and the bundle would run from `localhost`, where the game's own update check and the service worker
are turned off. Running the live site reuses the update and offline machinery the web app already has.

### What the shell adds

| | Android | iPad |
|---|---|---|
| Landscape only | `sensorLandscape` (manifest) | Info.plist + `UIRequiresFullScreen` |
| Full screen | immersive: bars hidden, swipe from an edge to peek | no status bar, home indicator auto-hides, edge swipes need two swipes |
| Screen stays on | while the app is in front | while the app is in front |
| Sound | media may play without a user gesture; the game's audio starts on the first touch as before | same |
| WebGL2 / GPU | hardware-accelerated WebView | WKWebView (WebGL2 since iOS 15) |
| Back button | close a dialog → open/close the pause menu in flight → deselect in the hangar (never quits) | — |
| Safe areas | WebView insets → `env(safe-area-inset-*)` | edge-to-edge web view (`contentInset: never`), `env(safe-area-inset-*)` |
| Analytics | user agent tagged `SkywrightApp/android` → PostHog `native_app: "android"`, `installed: true` | `SkywrightApp/ios` |

App id `com.anielsud.skywright`, name **Skywright**, icon and splash rendered from `../icon.svg`
(`npm run assets`; the PNG sources are in `assets/`, the generated sizes are committed in `android/` and `ios/`).

## One-time setup (Mac)

```sh
brew install node                       # if `node -v` doesn't work
cd native && npm install                # Capacitor (the build scripts also do this)
```

**Android** (either the command-line tools *or* Android Studio):

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0"
```

`tools/native/build_android.sh` finds the Homebrew JDK and SDK by itself (or set `JAVA_HOME` / `ANDROID_HOME`),
and installs a missing `platforms;android-NN` with `sdkmanager`. With Android Studio instead: install it, open it
once to let it download the SDK, and the script picks up `~/Library/Android/sdk` and Studio's bundled JDK.

**iPad**:

1. Install **Xcode** from the Mac App Store, open it once (accept the licence, let it install the iOS platform), then
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
2. Xcode → Settings → Accounts → **+** → Apple ID. A free Apple ID is enough (it creates a "Personal Team").
3. On the iPad: connect by cable, tap **Trust**, then Settings → Privacy & Security → **Developer Mode** → on (restarts).

## Android: build and install

```sh
tools/native/build_android.sh            # → native/android/app/build/outputs/apk/debug/app-debug.apk (~110 MB)
tools/native/build_android.sh --install  # ...and install it over USB
tools/native/build_android.sh --lite     # leave the real-world places (assets/real, ~80 MB) out of the offline fallback
```

Getting it onto the tablet, either way:

- **USB (adb)**: on the tablet, Settings → About tablet → tap *Build number* 7 times → Developer options →
  **USB debugging** on. Plug in, accept the prompt, then `adb install -r native/android/app/build/outputs/apk/debug/app-debug.apk`
  (or `--install` above). `adb devices` should list the tablet.
- **Copy the file**: put `app-debug.apk` on the tablet (USB file transfer, Google Drive, email…), tap it in Files,
  and allow *Install unknown apps* for that app when asked.

It's debug-signed with this Mac's debug key (`~/.android/debug.keystore`): later builds from the same Mac install
over the top and keep the saves. A build from another machine has a different key: uninstall first (that wipes saves).
Android debug builds don't expire.

## iPad: build and run

```sh
tools/native/build_ios.sh                # syncs, then opens Xcode
```

First time in Xcode: select the **App** project → **App** target → *Signing & Capabilities* → *Team*: your Personal
Team. (If Xcode says the bundle id is taken, change it to something like `com.anielsud.skywright.ipad`.)
Pick the iPad in the device menu at the top and press **Run** (⌘R). On the iPad, the first launch is blocked until you
trust the developer: Settings → General → VPN & Device Management → your Apple ID → Trust.

After that, the command line works too: `TEAM=<your team id> tools/native/build_ios.sh --install`.

**The 7-day limit:** with a free Apple ID, the app's provisioning profile expires after **7 days**, and the app then
won't open (its data stays). Re-run from Xcode (or `build_ios.sh --install`) with the iPad connected to renew it for
another 7 days. Free accounts also allow only 3 sideloaded apps per device. A paid **Apple Developer Program**
membership ($99/year) makes the profile last **1 year**, and adds TestFlight / ad-hoc installs without a cable.

Remember the expiry is only for the app shell: the game itself still updates from Pages by itself, every release.

## When to rebuild the apps

Almost never. Rebuild only to change the shell (this folder), to refresh the bundled offline fallback, or after
a Capacitor upgrade. Game releases need nothing here.

## Files

- `capacitor.config.json`: app id/name, the live URL (`server.url`), fallback (`server.errorPath`), per-platform settings.
- `scripts/sync-www.mjs`: copies the site into `www/` (no `sw.js`; stamps `COMMIT`/`BUILT` like the deploy does).
- `scripts/make-assets.mjs`: renders icon/splash sources from `../icon.svg`; `npm run assets` regenerates all sizes.
- `android/app/src/main/java/com/anielsud/skywright/MainActivity.java`: immersive mode, keep-awake, back button, offline fallback.
- `ios/App/App/SceneDelegate.swift` (`SkywrightViewController`), `ios/App/App/Info.plist`: fullscreen, keep-awake, landscape, App-Bound Domains.
- `../tools/native/build_android.sh`, `../tools/native/build_ios.sh`: one-command builds with prerequisite checks.

Debugging: both builds allow remote inspection: Chrome `chrome://inspect` for Android, Safari → Develop → iPad for iOS.
