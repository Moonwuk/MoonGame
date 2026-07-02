import { describe, expect, it } from 'vitest';
import {
  createWelcomeModel,
  resolveWelcomeAction,
  nextCallsign,
  ruStrings,
  CALLSIGNS,
  type AuthProviderId,
} from './welcomeScreen';

describe('createWelcomeModel', () => {
  it('describes the screen from the default (RU) strings', () => {
    const m = createWelcomeModel();
    expect(m.title).toBe('VOID DOMINION');
    expect(m.tagline).toBe(ruStrings.tagline);
    expect(m.language).toBe('ru');
    expect(m.legal.map((l) => l.id)).toEqual(['imprint', 'terms', 'privacy', 'support']);
  });

  it('exposes Google + Apple as not-yet-available stubs (no Facebook)', () => {
    const m = createWelcomeModel();
    expect(m.providers.map((p) => p.id)).toEqual(['google', 'apple']);
    expect(m.providers.every((p) => !p.available)).toBe(true);
  });

  it('is i18n-driven — a custom strings bundle flows through', () => {
    const m = createWelcomeModel({
      ...ruStrings,
      title: 'VD',
      newPlayer: 'New',
      providerLabels: { google: 'G', apple: 'A' },
    });
    expect(m.title).toBe('VD');
    expect(m.newPlayerLabel).toBe('New');
    expect(m.providers.map((p) => p.label)).toEqual(['G', 'A']);
  });

  it('produces a JSON-serialisable model', () => {
    const m = createWelcomeModel();
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe('resolveWelcomeAction', () => {
  const model = createWelcomeModel();

  it('routes a new player into the browser to be assigned a callsign', () => {
    expect(resolveWelcomeAction({ kind: 'newPlayer' }, model)).toEqual({
      ok: true,
      route: 'browse',
      mode: 'new',
    });
  });

  it('routes single-player to the local skirmish', () => {
    expect(resolveWelcomeAction({ kind: 'singlePlayer' }, model)).toEqual({
      ok: true,
      route: 'single',
    });
  });

  it('treats a stubbed provider as guest entry with a localisable notice', () => {
    const out = resolveWelcomeAction({ kind: 'signIn', provider: 'google' }, model);
    expect(out).toEqual({
      ok: true,
      route: 'browse',
      mode: 'new',
      noticeKey: 'guest_stub',
      provider: 'google',
    });
  });

  it('routes an available provider as a returning sign-in', () => {
    const live = createWelcomeModel();
    live.providers = live.providers.map((p) =>
      p.id === 'apple' ? { ...p, available: true } : p,
    );
    expect(resolveWelcomeAction({ kind: 'signIn', provider: 'apple' }, live)).toEqual({
      ok: true,
      route: 'browse',
      mode: 'returning',
      provider: 'apple',
    });
  });

  it('fail-secure: rejects an unknown provider with a stable code', () => {
    const out = resolveWelcomeAction(
      { kind: 'signIn', provider: 'facebook' as AuthProviderId },
      model,
    );
    expect(out).toEqual({ ok: false, code: 'E_UNKNOWN_PROVIDER' });
  });

  it('fail-secure: rejects an empty / whitespace login nick', () => {
    expect(resolveWelcomeAction({ kind: 'login', nick: '' }, model)).toEqual({
      ok: false,
      code: 'E_NO_NICK',
    });
    expect(resolveWelcomeAction({ kind: 'login', nick: '   ' }, model)).toEqual({
      ok: false,
      code: 'E_NO_NICK',
    });
  });

  it('routes a returning login with the trimmed nick', () => {
    expect(resolveWelcomeAction({ kind: 'login', nick: '  Alice ' }, model)).toEqual({
      ok: true,
      route: 'browse',
      mode: 'returning',
      nick: 'Alice',
    });
  });
});

describe('nextCallsign', () => {
  it('is deterministic: word cycles, suffix counts up from 1', () => {
    expect(nextCallsign(0)).toBe('Носорог-1');
    expect(nextCallsign(1)).toBe('Комета-2');
    expect(nextCallsign(CALLSIGNS.length)).toBe('Носорог-9');
  });

  it('stays in range for any sequence number', () => {
    for (let n = 0; n < 50; n++) {
      expect(nextCallsign(n).endsWith(`-${n + 1}`)).toBe(true);
    }
  });
});
