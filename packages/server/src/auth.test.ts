import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { hmacSecret, signJoinToken, verifyJoinToken, type JoinClaim } from './auth';

// SE-2.1 — the join-token trust anchor. These pin the security contract: a valid token
// yields the claim; EVERY abuse (none-alg, algorithm confusion, expired, wrong iss/aud,
// tampered signature, missing claim, wrong key) is rejected with a stable E_AUTH and no
// leaked reason.

const secret = hmacSecret('dev-secret-please-change');
const verifyCfg = { key: secret, algorithms: ['HS256'], issuer: 'void', audience: 'match' };
const signCfg = { key: secret, algorithm: 'HS256', issuer: 'void', audience: 'match' };
const claim: JoinClaim = { matchId: 'm1', playerId: 'green', accountId: 'acct-1' };

describe('SE-2.1 · verifyJoinToken', () => {
  it('accepts a valid token and returns the claim', async () => {
    const token = await signJoinToken(claim, signCfg, { ttlSeconds: 300 });
    const result = await verifyJoinToken(token, verifyCfg);
    expect(result).toEqual({ ok: true, claim });
  });

  it('omits accountId when the token carries none', async () => {
    const token = await signJoinToken({ matchId: 'm1', playerId: 'green' }, signCfg, {
      ttlSeconds: 300,
    });
    const result = await verifyJoinToken(token, verifyCfg);
    expect(result).toEqual({ ok: true, claim: { matchId: 'm1', playerId: 'green' } });
  });

  it('rejects an alg=none token (no allowlist entry, and jose bans none)', async () => {
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = enc({ alg: 'none', typ: 'JWT' });
    const body = enc({
      matchId: 'm1',
      playerId: 'green',
      iss: 'void',
      aud: 'match',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const noneToken = `${header}.${body}.`;
    expect(await verifyJoinToken(noneToken, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects algorithm confusion (HS256 token when only RS256 is allowed)', async () => {
    const token = await signJoinToken(claim, signCfg, { ttlSeconds: 300 });
    const result = await verifyJoinToken(token, { ...verifyCfg, algorithms: ['RS256'] });
    expect(result).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects an expired token', async () => {
    const token = await signJoinToken(claim, signCfg, { ttlSeconds: -60 }); // exp in the past
    expect(await verifyJoinToken(token, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects a wrong issuer and a wrong audience', async () => {
    const token = await signJoinToken(claim, signCfg, { ttlSeconds: 300 });
    expect(await verifyJoinToken(token, { ...verifyCfg, issuer: 'evil' })).toEqual({
      ok: false,
      code: 'E_AUTH',
    });
    expect(await verifyJoinToken(token, { ...verifyCfg, audience: 'other-match' })).toEqual({
      ok: false,
      code: 'E_AUTH',
    });
  });

  it('rejects a token signed with a different key', async () => {
    const token = await new SignJWT({ matchId: 'm1', playerId: 'green' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('void')
      .setAudience('match')
      .setExpirationTime('5m')
      .sign(hmacSecret('a-different-secret'));
    expect(await verifyJoinToken(token, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects a tampered token', async () => {
    const token = await signJoinToken(claim, signCfg, { ttlSeconds: 300 });
    const parts = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ matchId: 'm1', playerId: 'red', iss: 'void', aud: 'match' }),
    ).toString('base64url');
    const tampered = `${parts[0]}.${forgedBody}.${parts[2]}`;
    expect(await verifyJoinToken(tampered, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects a well-signed token that is missing the match/player claims', async () => {
    const token = await new SignJWT({ accountId: 'acct-1' }) // no matchId / playerId
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('void')
      .setAudience('match')
      .setExpirationTime('5m')
      .sign(secret);
    expect(await verifyJoinToken(token, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });

  it('rejects a token with no expiration', async () => {
    const token = await new SignJWT({ matchId: 'm1', playerId: 'green' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('void')
      .setAudience('match')
      .sign(secret); // no setExpirationTime
    expect(await verifyJoinToken(token, verifyCfg)).toEqual({ ok: false, code: 'E_AUTH' });
  });
});
