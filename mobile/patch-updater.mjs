// Wire the in-app one-tap updater into the freshly-generated Android project.
//
// Runs AFTER `cap add android` / `cap sync` / brand / patch-android.mjs, and is
// idempotent + defensive: the android/ project is gitignored and regenerated every
// build, and we cannot run the Android SDK in dev, so each step checks before it edits
// and tolerates whatever Capacitor's template already provides.
//
// It does four things:
//   1. AndroidManifest.xml — add REQUEST_INSTALL_PACKAGES; ensure a FileProvider exists.
//   2. res/xml/file_paths.xml — ensure an <external-files-path> the FileProvider can serve.
//   3. MainActivity.java — replace with a version that intercepts the APK download (the
//      updater navigates the WebView to the APK asset URL), hands it to DownloadManager,
//      and fires the system installer via the FileProvider URI on completion.
//   4. app/build.gradle — stamp versionCode/versionName (from env VOID_VC / VOID_VN) so
//      Android treats each rolling build as a strictly newer update.
//
// The download notification stays visible, so if the auto-launched installer is blocked
// on a device the player can still tap it to install — the graceful fallback.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(p, 'utf8');

const appId = JSON.parse(read(here('./capacitor.config.json'))).appId;
if (!appId) throw new Error('patch-updater: appId missing from capacitor.config.json');
const pkgPath = appId.replace(/\./g, '/');

const manifestPath = here('./android/app/src/main/AndroidManifest.xml');
const filePathsPath = here('./android/app/src/main/res/xml/file_paths.xml');
const mainActivityPath = here(`./android/app/src/main/java/${pkgPath}/MainActivity.java`);
const buildGradlePath = here('./android/app/build.gradle');

// --- 1. AndroidManifest.xml -------------------------------------------------
{
  let xml = read(manifestPath);
  const before = xml;

  // REQUEST_INSTALL_PACKAGES: lets the app launch the package installer for the new APK.
  if (!xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    xml = xml.replace(
      /(<application\b)/,
      '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    $1',
    );
  }

  // FileProvider: Capacitor's template normally ships one with this exact authority. Only
  // add it when absent, so we never create a duplicate-authority manifest-merge failure.
  if (!xml.includes('.fileprovider')) {
    const provider =
      '    <provider\n' +
      '        android:name="androidx.core.content.FileProvider"\n' +
      '        android:authorities="${applicationId}.fileprovider"\n' +
      '        android:exported="false"\n' +
      '        android:grantUriPermissions="true">\n' +
      '        <meta-data\n' +
      '            android:name="android.support.FILE_PROVIDER_PATHS"\n' +
      '            android:resource="@xml/file_paths" />\n' +
      '    </provider>\n';
    xml = xml.replace(/(\s*)<\/application>/, `\n${provider}$1</application>`);
  }

  if (xml !== before) {
    writeFileSync(manifestPath, xml);
    console.log('patch-updater: manifest — added install permission / ensured FileProvider.');
  } else {
    console.log('patch-updater: manifest — permission + FileProvider already present.');
  }
}

// --- 2. res/xml/file_paths.xml ----------------------------------------------
{
  const entry = '    <external-files-path name="void_updates" path="." />';
  if (!existsSync(filePathsPath)) {
    mkdirSync(dirname(filePathsPath), { recursive: true });
    writeFileSync(
      filePathsPath,
      '<?xml version="1.0" encoding="utf-8"?>\n<paths>\n' + entry + '\n</paths>\n',
    );
    console.log('patch-updater: file_paths.xml — created with external-files-path.');
  } else {
    let xml = read(filePathsPath);
    if (!xml.includes('external-files-path')) {
      xml = xml.replace(/<\/paths>/, entry + '\n</paths>');
      writeFileSync(filePathsPath, xml);
      console.log('patch-updater: file_paths.xml — added external-files-path.');
    } else {
      console.log('patch-updater: file_paths.xml — external-files-path already present.');
    }
  }
}

// --- 3. MainActivity.java ---------------------------------------------------
{
  const java = `package ${appId};

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host activity + a tiny native bridge for the in-app updater.
 *
 * The earlier build tried to download AND install the update APK itself (a WebView
 * DownloadListener → DownloadManager → FileProvider install intent). That path proved
 * unreliable across devices (the auto-launched installer often never appeared). The
 * updater now does the robust thing instead: it hands the APK asset URL to the SYSTEM
 * BROWSER via window.VoidNative.open(url). The browser downloads it and offers to install
 * from the download — which works everywhere, with no DownloadManager/FileProvider
 * plumbing or extra install permission to misfire.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Exposed to the bundled web app (local content only) as window.VoidNative.
        this.bridge.getWebView().addJavascriptInterface(new UpdaterBridge(getApplicationContext()), "VoidNative");
    }

    public static class UpdaterBridge {
        private final Context ctx;
        UpdaterBridge(Context c) {
            this.ctx = c;
        }

        /** Open a URL in the external browser (used to fetch the update APK). */
        @JavascriptInterface
        public void open(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
            } catch (Exception ignored) {
                // The web layer keeps a plain-link fallback, so nothing more to do here.
            }
        }
    }
}
`;
  if (!existsSync(mainActivityPath)) {
    throw new Error(`patch-updater: MainActivity not found at ${mainActivityPath}`);
  }
  writeFileSync(mainActivityPath, java);
  console.log('patch-updater: MainActivity.java — installed the VoidNative browser-open bridge.');
}

// --- 4. app/build.gradle (versionCode / versionName) ------------------------
{
  const vc = process.env.VOID_VC;
  const vn = process.env.VOID_VN;
  if (!vc || !/^\d+$/.test(vc)) {
    console.log('patch-updater: VOID_VC unset/invalid — leaving build.gradle versionCode as-is.');
  } else {
    let gradle = read(buildGradlePath);
    if (!/versionCode\s+\d+/.test(gradle)) {
      // Check presence (not whether a change happened): on a re-run the value may already
      // equal the target, which is a successful no-op, not a missing-anchor failure.
      throw new Error('patch-updater: could not find versionCode in app/build.gradle');
    }
    gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${vc}`);
    if (vn) gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${vn}"`);
    writeFileSync(buildGradlePath, gradle);
    console.log(`patch-updater: build.gradle — versionCode ${vc}${vn ? ` / versionName "${vn}"` : ''}.`);
  }
}
