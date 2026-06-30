// In-app APK auto-update for the sideloaded Android build.
//
// This is DORMANT in the browser / dev build: only the packaged APK carries a baked
// build identity (`window.__BUILD__`, injected into index.html at package time by CI —
// see mobile/inject-build.mjs). In the browser the content is always live, so there is
// nothing to update and every entry point below short-circuits to "no update".
//
// Flow (APK only):
//   1. read our own build  → window.__BUILD__ = { versionCode, sha }
//   2. fetch the rolling "alpha" GitHub release via the CORS-enabled REST API
//      (api.github.com sends Access-Control-Allow-Origin: *, so the WebView can read it;
//       the release *asset* download endpoints do not, which is why we read the version
//       out of the release BODY rather than fetching a separate version.json asset)
//   3. compare versionCode → if the release is strictly newer, surface it
//   4. "Обновить" navigates the WebView to the APK asset URL. GitHub serves the asset
//      with Content-Disposition: attachment, so the WebView treats it as a download and
//      fires the native DownloadListener (MainActivity), which downloads it and launches
//      the system installer. Outside the APK that navigation is just a browser download.
//
// CI bakes a monotonic versionCode (commit count) and the short SHA into BOTH the APK
// (mobile/patch-updater.mjs → build.gradle) and the release body marker, so the running
// build and the published build are compared on the same integer.

export interface BuildInfo {
  /** Monotonic Android versionCode (commit count at build time). */
  versionCode: number;
  /** Short git SHA, for display ("alpha-<sha>"). */
  sha: string;
}

export interface UpdateInfo extends BuildInfo {
  /** Direct download URL of the rolling release's APK asset. */
  apkUrl: string;
  /** Full release body (shown to the player as "what's new"). */
  notes: string;
}

/** Rolling "alpha" prerelease — a stable tag whose APK asset URL never changes. */
const RELEASE_API = 'https://api.github.com/repos/moonwuk/nygame/releases/tags/alpha';
const APK_ASSET = 'void-dominion-alpha.apk';

interface GlobalWithBuild {
  __BUILD__?: { versionCode?: unknown; sha?: unknown };
}

/** Our own build identity, injected into the APK's index.html at package time. */
export function currentBuild(): BuildInfo | null {
  const b = (globalThis as GlobalWithBuild).__BUILD__;
  if (!b || typeof b.versionCode !== 'number' || !Number.isFinite(b.versionCode)) return null;
  return { versionCode: b.versionCode, sha: typeof b.sha === 'string' ? b.sha : '' };
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/**
 * Parse the GitHub release JSON into the fields we need, or null if it is unusable.
 * The versionCode is read from a machine marker the build embeds in the release body
 * (`void:versionCode=<n>`); the APK URL from the asset named `void-dominion-alpha.apk`.
 */
export function parseRelease(release: unknown): UpdateInfo | null {
  if (!release || typeof release !== 'object') return null;
  const r = release as { body?: unknown; assets?: unknown };
  const body = typeof r.body === 'string' ? r.body : '';

  const vcMatch = /void:versionCode=(\d+)/.exec(body) ?? /versionCode[^\d]{0,6}(\d+)/i.exec(body);
  if (!vcMatch) return null;
  const versionCode = Number(vcMatch[1]);
  if (!Number.isFinite(versionCode)) return null;

  const shaMatch = /void:sha=([0-9a-f]+)/i.exec(body) ?? /\b([0-9a-f]{7,40})\b/.exec(body);
  const sha = shaMatch ? shaMatch[1]! : '';

  const assets: ReleaseAsset[] = Array.isArray(r.assets) ? (r.assets as ReleaseAsset[]) : [];
  const apk = assets.find(
    (a) => !!a && a.name === APK_ASSET && typeof a.browser_download_url === 'string',
  );
  if (!apk) return null;

  return { versionCode, sha, apkUrl: apk.browser_download_url as string, notes: body };
}

/** True when `remote` is a strictly newer build than `local`. */
export function isNewer(local: BuildInfo, remote: UpdateInfo): boolean {
  return remote.versionCode > local.versionCode;
}

/**
 * Check the rolling release for a newer build. Returns the update if one is available,
 * else null — and null on EVERY failure path (no baked build = browser/dev, offline,
 * rate-limited, bad JSON, older-or-equal release). The updater must never throw into the
 * boot path, so all errors collapse to "no update".
 */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  const local = currentBuild();
  if (!local) return null; // browser / dev build — content is always live
  try {
    const res = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const remote = parseRelease(await res.json());
    if (!remote) return null;
    return isNewer(local, remote) ? remote : null;
  } catch {
    return null;
  }
}

/** Human label for a build ("alpha-1a2b3c4", or "сборка N" when no SHA). */
export function buildLabel(b: BuildInfo): string {
  return b.sha ? `alpha-${b.sha}` : `сборка ${b.versionCode}`;
}
