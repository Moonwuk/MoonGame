// Force the WebView activity to landscape after `cap add android`.
//
// The province map is wide (a 13×4 lattice), so in portrait it collapses into a
// thin horizontal strip with huge empty margins — unplayable. Locking the app to
// landscape makes the map fill the screen, the way map-heavy strategy games ship.
//
// The generated android/ project is gitignored and re-created on every build, so
// this runs each time and is idempotent. Capacitor's `cap sync` never rewrites the
// manifest, so a single post-add patch sticks through the rest of the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(
  new URL('./android/app/src/main/AndroidManifest.xml', import.meta.url),
);
let xml = readFileSync(manifest, 'utf8');

if (xml.includes('android:screenOrientation')) {
  console.log('AndroidManifest already pins screenOrientation — leaving it as-is.');
} else {
  const before = xml;
  // Inject the attribute right before the MainActivity name so it lands inside that
  // activity's opening tag (Capacitor's template lists android:name=".MainActivity").
  xml = xml.replace(
    /(\s*)android:name="\.MainActivity"/,
    '$1android:screenOrientation="sensorLandscape"$1android:name=".MainActivity"',
  );
  if (xml === before) {
    throw new Error('patch-android: could not find .MainActivity in AndroidManifest to lock orientation');
  }
  writeFileSync(manifest, xml);
  console.log('patch-android: locked MainActivity to sensorLandscape');
}
