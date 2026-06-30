# Void Dominion — Android APK (Capacitor)

Packages the **prototype** (`prototype/dist/void-dominion.html`, a self-contained
offline HTML game) into an installable Android APK by wrapping it in a Capacitor
WebView. No hosting needed — the HTML ships inside the app. The app is **branded**
(diamond crest icon + splash) and **rotates freely** — the responsive layout serves
phones in portrait and tablets / landscape with the wider framing. Standalone project
(not in the pnpm workspace); uses `npm`.

This is `cross-platform-roadmap.md` CP6.2 (Capacitor route — pulled forward ahead of
the CP6.1 TWA route to enable the multiplayer-via-APK test). The wrapped prototype
now ships **net mode**: its connect overlay can join a live session served by
`pnpm dev:proto-server`. See `docs/multiplayer.md` → "Two phones, one session" for
the friend-test runbook (server + `wss://` tunnel → sideload → both connect).

## Install on a phone (easiest)

Every push to `main` that touches the game refreshes a rolling **`alpha`** prerelease
with the latest build, at a stable link:

- **Releases page:** https://github.com/Moonwuk/Nygame/releases/tag/alpha
- **Direct APK:** https://github.com/Moonwuk/Nygame/releases/download/alpha/void-dominion-alpha.apk

On the phone: open the direct link → download → open the APK → allow "install from
unknown sources" if prompted → launch. **Single-player runs fully offline**; rotate
freely on a phone or tablet.

It is a **debug** APK, signed with a **committed debug keystore** (`mobile/debug.keystore`,
standard `android`/`android` credentials — not a secret) so every build shares one
signature and updates install over the previous build. A Play-Store release/AAB still
needs a real (secret) keystore — a later step.

### If the install fails

- **"App not installed — it conflicts with another package"** — you have an older build
  installed that was signed with a *different* key (older builds regenerated the debug
  key each time). **Uninstall Void Dominion once**, then install this build; from now on
  the signature is stable, so future updates install straight over the top.
- **Google Play Protect "blocked for your protection"** — expected for a sideloaded
  debug APK from an unverified developer. Tap **Подробнее → Установить всё равно**
  (More details → Install anyway). It's the same code you build here.

## In-app auto-update

Install once; after that the app updates itself — no need to keep re-downloading from
the release page. On launch (when online) and via **«Проверить обновления»** on the
welcome screen, the app checks the rolling `alpha` release and, if a newer build exists,
shows a **«Доступна новая сборка»** banner. Tapping **«Обновить»** downloads the new APK
in-app and opens the system installer; because every build shares the committed debug
signature, it installs straight over the top, keeping your data.

How it's wired (all four pieces ship together so the running build and the published
build are compared on the same integer):

- **versionCode = git commit count** (monotonic), `versionName = alpha-<sha>` — stamped
  into the APK by `patch-updater.mjs` and baked into the web layer as `window.__BUILD__`
  by `inject-build.mjs` (CI `Compute build version` step → `$GITHUB_ENV`).
- The release **body** carries a machine marker `<!-- void:versionCode=N void:sha=X -->`.
- `prototype/src/updater.ts` reads `window.__BUILD__`, fetches the release via the
  CORS-enabled GitHub REST API, compares versionCode, and surfaces the banner. It is
  **dormant in the browser / dev build** (no `__BUILD__`), where content is always live.
- The native side (`patch-updater.mjs` → `MainActivity.java`) adds
  `REQUEST_INSTALL_PACKAGES` + a `FileProvider`, intercepts the APK download via the
  WebView `DownloadListener` → `DownloadManager`, and fires the install intent on
  completion. The download notification stays visible as a manual fallback if a device
  blocks the auto-launched installer.

> Authenticity caveat: the debug keystore is committed (public), so the signature proves
> only "built by this pipeline's key", not a secret identity. Fine for an alpha; a real
> (secret) release keystore is the Play-Store step.

## Get the APK as a CI artifact (any branch build)

Each run also uploads the APK as an artifact (handy for `claude/*` branch builds that
don't publish a release):

1. Actions tab → "Android APK (prototype)" → open the run (or **Run workflow**).
2. Download the **`void-dominion-debug-apk`** artifact.
3. Sideload `app-debug.apk` (enable "install from unknown sources").

## Build locally (needs JDK 17 + Android SDK)

```bash
cd mobile
npm install
npm run www          # builds the prototype and stages www/index.html
npx cap add android  # generates the native android/ project (first time only)
npm run apk          # sync → brand (icon/splash + landscape) → ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run apk` runs `npm run brand` between sync and the Gradle build:
`capacitor-assets generate --android` (icons + splash from `assets/`), then
`node patch-android.mjs` (enables rotation — `fullUser` + in-place `configChanges`
so rotating never reloads the WebView / drops game state), then `node patch-updater.mjs`
(wires the in-app updater: install permission + FileProvider + MainActivity download/
install hook, and stamps `versionCode`/`versionName` from `VOID_VC`/`VOID_VN` when set).
A local build leaves `versionCode 1` and ships no `window.__BUILD__`, so its updater stays
dormant — those are injected by CI from the git commit count; the native hook still
compiles locally, which is the point of running it here.

Requirements: JDK 17, Android SDK (set `ANDROID_HOME`), and accepted SDK licenses.
`gradlew` downloads its own Gradle. Capacitor 6 ⇒ JDK 17.

## Notes

- `www/` and `android/` are generated (gitignored); only the config + scripts +
  `assets/` source art are tracked.
- Brand art lives in `assets/` (`icon-only` / `icon-foreground` / `icon-background`
  at 1024², `splash` / `splash-dark` at 2732²); regenerate with the scratch
  generator if the crest changes. `@capacitor/assets` fans them out to every density.
- App id `com.voiddominion.prototype`, name "Void Dominion".
- CI action versions are tag-pinned for now; SHA-pin them with the pipeline-hardening
  brick (SD-6.1) alongside the other workflows.
