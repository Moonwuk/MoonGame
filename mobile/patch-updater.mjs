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

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.File;

/**
 * Capacitor host activity, augmented with a one-tap in-app updater for the sideloaded APK.
 *
 * The web layer (updater.ts) checks the rolling GitHub release and, when a newer build
 * exists, shows "Обновить" as a link to the APK asset URL. GitHub serves that asset with
 * Content-Disposition: attachment, so navigating to it makes the WebView fire this
 * DownloadListener instead of trying to render it. We hand the URL to the system
 * DownloadManager and, on completion, launch the package installer through a FileProvider
 * URI. The download notification stays visible as a manual install fallback.
 */
public class MainActivity extends BridgeActivity {
    private static final String APK_FILE = "void-dominion-update.apk";
    private long downloadId = -1L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        this.bridge.getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                return;
            }
            // Drop any stale copy so the installer always reads the freshly downloaded build.
            File prior = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_FILE);
            if (prior.exists()) {
                prior.delete();
            }
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType("application/vnd.android.package-archive");
            req.setTitle("Void Dominion — обновление");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, APK_FILE);
            downloadId = dm.enqueue(req);
        });

        ContextCompat.registerReceiver(
            this,
            onDownloadComplete,
            new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        );
    }

    private final BroadcastReceiver onDownloadComplete = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            if (downloadId == -1L || id != downloadId) {
                return;
            }
            try {
                File apk = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_FILE);
                if (!apk.exists()) {
                    return;
                }
                Uri uri = FileProvider.getUriForFile(context, getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(install);
            } catch (Exception ignored) {
                // The visible DownloadManager notification remains as a manual install fallback.
            }
        }
    };

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(onDownloadComplete);
        } catch (Exception ignored) {
            // never registered / already gone — nothing to do.
        }
        super.onDestroy();
    }
}
`;
  if (!existsSync(mainActivityPath)) {
    throw new Error(`patch-updater: MainActivity not found at ${mainActivityPath}`);
  }
  writeFileSync(mainActivityPath, java);
  console.log('patch-updater: MainActivity.java — installed the updater download/install hook.');
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
