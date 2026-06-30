// Let the WebView activity rotate, and handle rotation in-place after `cap add android`.
//
// The UI is responsive (phones in portrait, tablets and landscape get the wider
// layout), so we allow all user-permitted orientations instead of pinning portrait.
// `android:configChanges` is the important half: without it Android RECREATES the
// activity on every rotation, which reloads the WebView and throws away an in-progress
// match. Declaring the config changes makes the activity keep running (the page just
// reflows via CSS/JS), so rotating never drops game state.
//
// The generated android/ project is gitignored and re-created on every build, so this
// runs each time and is idempotent. Capacitor's `cap sync` never rewrites the manifest,
// so a single post-add patch sticks through the rest of the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(
  new URL('./android/app/src/main/AndroidManifest.xml', import.meta.url),
);
let xml = readFileSync(manifest, 'utf8');

if (xml.includes('android:screenOrientation')) {
  console.log('AndroidManifest already sets screenOrientation — leaving it as-is.');
} else {
  const before = xml;
  // Capacitor's MainActivity template ALREADY declares `android:configChanges` (it keeps
  // the activity alive across config changes). Injecting a second one makes the manifest
  // merger fail with a duplicate-attribute error, so only add it when Capacitor didn't.
  const hasConfigChanges = xml.includes('android:configChanges');
  // Inject right before the MainActivity name so the attrs land inside that activity's
  // opening tag. `fullUser` = every orientation the user's auto-rotate allows (so a user
  // who locked portrait still gets portrait); `configChanges` keeps state across rotation.
  xml = xml.replace(
    /(\s*)android:name="\.MainActivity"/,
    '$1android:screenOrientation="fullUser"' +
      (hasConfigChanges
        ? ''
        : '$1android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden"') +
      '$1android:name=".MainActivity"',
  );
  if (xml === before) {
    throw new Error('patch-android: could not find .MainActivity in AndroidManifest to set orientation');
  }
  writeFileSync(manifest, xml);
  console.log(
    `patch-android: set screenOrientation=fullUser${hasConfigChanges ? ' (configChanges already present)' : ' + in-place config changes'}`,
  );
}
