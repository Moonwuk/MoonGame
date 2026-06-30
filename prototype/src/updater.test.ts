import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLabel,
  checkForUpdate,
  currentBuild,
  isNewer,
  parseRelease,
  type UpdateInfo,
} from './updater';

interface GlobalWithBuild {
  __BUILD__?: { versionCode?: unknown; sha?: unknown };
}
const g = globalThis as GlobalWithBuild;

function setBuild(b: { versionCode?: unknown; sha?: unknown } | undefined): void {
  if (b === undefined) delete g.__BUILD__;
  else g.__BUILD__ = b;
}

/** A realistic GitHub release payload for tag `alpha`. */
function release(versionCode: number, sha: string): unknown {
  return {
    tag_name: 'alpha',
    body: `Rolling alpha — the latest debug APK built from main (${sha}).\n\n<!-- void:versionCode=${versionCode} void:sha=${sha} -->\nInstall on Android: download below.`,
    assets: [
      { name: 'void-dominion-alpha.apk', browser_download_url: 'https://github.com/x/y/releases/download/alpha/void-dominion-alpha.apk' },
    ],
  };
}

function fetchOk(payload: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
}

afterEach(() => setBuild(undefined));

describe('currentBuild', () => {
  it('reads a baked build identity', () => {
    setBuild({ versionCode: 42, sha: 'abc1234' });
    expect(currentBuild()).toEqual({ versionCode: 42, sha: 'abc1234' });
  });
  it('is null in the browser / dev build (no __BUILD__)', () => {
    setBuild(undefined);
    expect(currentBuild()).toBeNull();
  });
  it('rejects a malformed versionCode', () => {
    setBuild({ versionCode: 'nope', sha: 'x' });
    expect(currentBuild()).toBeNull();
  });
  it('tolerates a missing sha', () => {
    setBuild({ versionCode: 7 });
    expect(currentBuild()).toEqual({ versionCode: 7, sha: '' });
  });
});

describe('parseRelease', () => {
  it('extracts versionCode, sha and the apk url from the body marker + assets', () => {
    expect(parseRelease(release(99, 'deadbee'))).toEqual({
      versionCode: 99,
      sha: 'deadbee',
      apkUrl: 'https://github.com/x/y/releases/download/alpha/void-dominion-alpha.apk',
      notes: expect.stringContaining('void:versionCode=99'),
    });
  });
  it('returns null when the version marker is absent', () => {
    expect(parseRelease({ body: 'no marker here', assets: [{ name: 'void-dominion-alpha.apk', browser_download_url: 'u' }] })).toBeNull();
  });
  it('returns null when the apk asset is missing', () => {
    expect(parseRelease({ body: '<!-- void:versionCode=5 -->', assets: [{ name: 'other.txt', browser_download_url: 'u' }] })).toBeNull();
  });
  it('returns null on a non-object', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease('string')).toBeNull();
  });
});

describe('isNewer', () => {
  const remote = (vc: number): UpdateInfo => ({ versionCode: vc, sha: '', apkUrl: 'u', notes: '' });
  it('true only when the remote versionCode is strictly higher', () => {
    expect(isNewer({ versionCode: 10, sha: '' }, remote(11))).toBe(true);
    expect(isNewer({ versionCode: 10, sha: '' }, remote(10))).toBe(false);
    expect(isNewer({ versionCode: 10, sha: '' }, remote(9))).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns the update when the release is newer', async () => {
    setBuild({ versionCode: 41, sha: 'old1234' });
    const u = await checkForUpdate(fetchOk(release(42, 'new5678')));
    expect(u).not.toBeNull();
    expect(u!.versionCode).toBe(42);
    expect(u!.apkUrl).toContain('void-dominion-alpha.apk');
  });
  it('returns null when the release is the same version', async () => {
    setBuild({ versionCode: 42, sha: 'same' });
    expect(await checkForUpdate(fetchOk(release(42, 'same')))).toBeNull();
  });
  it('returns null in the browser / dev build (no baked build) without even fetching', async () => {
    setBuild(undefined);
    let called = false;
    const spy = (async () => {
      called = true;
      return { ok: true, json: async () => release(99, 'x') };
    }) as unknown as typeof fetch;
    expect(await checkForUpdate(spy)).toBeNull();
    expect(called).toBe(false);
  });
  it('returns null when the network throws (offline)', async () => {
    setBuild({ versionCode: 1, sha: 'x' });
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate(boom)).toBeNull();
  });
  it('returns null on a non-ok response (e.g. rate-limited)', async () => {
    setBuild({ versionCode: 1, sha: 'x' });
    const rate = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await checkForUpdate(rate)).toBeNull();
  });
});

describe('buildLabel', () => {
  it('prefers the alpha-sha form', () => {
    expect(buildLabel({ versionCode: 42, sha: 'abc1234' })).toBe('alpha-abc1234');
  });
  it('falls back to the versionCode when no sha', () => {
    expect(buildLabel({ versionCode: 42, sha: '' })).toBe('сборка 42');
  });
});
