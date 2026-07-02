import { ActionGate } from '@void/action-layer';
import { isValidActionPayload } from '@void/shared-core';
import { hmacSecret, signJoinToken, type JoinTokenVerifyConfig } from './auth';

/**
 * The server's security composition, derived from the environment — extracted from the
 * `main.ts` entrypoint (which boots on import) so it is unit-testable. All three switches
 * are OFF by default, so a bare `pnpm dev:server` is the insecure dev harness:
 *
 *   AUTH_JWT_SECRET  → require a verified join token at the handshake (+ mint tokens for
 *                      the create/join API). AUTH_ISSUER / AUTH_AUDIENCE tune the claims.
 *   ALLOWED_ORIGINS  → comma-separated Origin allowlist (CSWSH defence).
 *   GATE=1           → require validated action.v1 envelopes.
 *
 * `signToken` uses the SAME secret/alg/iss/aud as `auth` verifies with, so a minted token
 * round-trips — the property serverConfig.test.ts pins.
 */
export interface ServerConfig {
  auth?: JoinTokenVerifyConfig;
  allowedOrigins?: string[];
  /** Mint a join token for a seat (the /join API). Present iff auth is configured. */
  signToken?: (matchId: string, playerId: string) => Promise<string>;
  /** Build a fresh per-match ActionGate. Present iff GATE is enabled. */
  gateFactory?: () => ActionGate;
}

/** Join tokens ride in the WS URL, so keep the leaked-token window small; the verify side
 *  also caps age from `iat` (maxTokenAgeSec) as defence-in-depth. */
const JOIN_TOKEN_TTL_SEC = 15 * 60;

export function configFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
  const authSecret = env.AUTH_JWT_SECRET;
  const issuer = env.AUTH_ISSUER ?? 'void-dominion';
  const audience = env.AUTH_AUDIENCE ?? 'match';

  const auth: JoinTokenVerifyConfig | undefined = authSecret
    ? { key: hmacSecret(authSecret), algorithms: ['HS256'], issuer, audience, maxTokenAgeSec: JOIN_TOKEN_TTL_SEC }
    : undefined;
  const signToken = authSecret
    ? (matchId: string, playerId: string): Promise<string> =>
        signJoinToken(
          { matchId, playerId },
          { key: hmacSecret(authSecret), algorithm: 'HS256', issuer, audience },
          { ttlSeconds: JOIN_TOKEN_TTL_SEC },
        )
    : undefined;

  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : undefined;

  // A FACTORY, not one instance: each match needs its own gate (per-match sequence + receipts).
  const gateEnabled = env.GATE === '1' || env.GATE === 'true';
  const gateFactory = gateEnabled
    ? (): ActionGate => new ActionGate({ payloadValidator: isValidActionPayload })
    : undefined;

  return { auth, allowedOrigins, signToken, gateFactory };
}
