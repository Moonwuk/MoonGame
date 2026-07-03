import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MatchRegistry } from './matchRegistry';

/**
 * SV-2.4 — the minimal match create/join HTTP API, so players can actually enter a match
 * on the authenticated path: create a match, then exchange your identity for a join token
 * that gates the WebSocket handshake (SE-0.1).
 *
 * Identity comes through the optional `identify` hook. When wired (login+password accounts,
 * SE-1.x — see authApi.ts), BOTH routes require a valid `Authorization: Bearer <session>`:
 * create is a logged-in action, and join claims the seat for the SESSION'S account (its
 * login is the nick) — a `?nick=` query can no longer impersonate anyone. Without `identify`
 * (dev harness), the legacy first-come `?nick=` behaviour applies, which is NOT an
 * authorization boundary. Upgrading to external identity (OIDC) stays a later brick.
 */

export interface CreatedMatch {
  matchId: string;
  /** The seat player ids a client can `join` (e.g. `['green', 'red']`). */
  seats: string[];
}

export interface JoinResult {
  playerId: string;
  /** A short-lived join token to pass as `?token=` on the WS handshake. */
  token: string;
}

/** A stable failure from `join`, mapped to an HTTP status by the route. */
export type JoinFailure = { error: 'E_NO_MATCH' | 'E_MATCH_FULL' | 'E_AUTH_DISABLED' };

/** An authenticated caller, as resolved by the `identify` hook. */
export interface Identity {
  accountId: string;
  login: string;
}

export interface MatchApiDeps {
  /** Seed + persist a new match; returns its id and seat player ids. */
  createMatch(): Promise<CreatedMatch>;
  /** Resolve `nick` to a seat in `matchId` and mint its join token, or a stable failure:
   *  the match does not exist, every seat is taken, or token auth is not configured.
   *  `accountId` is stamped into the join token when the caller is authenticated. */
  join(matchId: string, nick: string, accountId?: string): Promise<JoinResult | JoinFailure>;
  /** Resolve the caller's identity from the request (session token), or null when the
   *  request carries no valid session. Wired ⇒ create/join REQUIRE identity (401 E_AUTH)
   *  and the session's login IS the nick. Absent ⇒ legacy `?nick=` dev behaviour. */
  identify?(request: FastifyRequest): Promise<Identity | null>;
}

const STATUS: Record<JoinFailure['error'], number> = {
  E_NO_MATCH: 404,
  E_MATCH_FULL: 409,
  E_AUTH_DISABLED: 501,
};

export function registerMatchApi(app: FastifyInstance, deps: MatchApiDeps): void {
  const identify = deps.identify;

  app.post('/matches', async (request: FastifyRequest, reply: FastifyReply) => {
    if (identify && !(await identify(request))) {
      void reply.code(401);
      return { error: 'E_AUTH' as const };
    }
    return deps.createMatch();
  });

  app.get('/matches/:id/join', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (identify) {
      // Authenticated path: the seat belongs to the SESSION's account — a query nick
      // is ignored, so nobody joins as somebody else.
      const who = await identify(request);
      if (!who) {
        void reply.code(401);
        return { error: 'E_AUTH' as const };
      }
      const result = await deps.join(id, who.login, who.accountId);
      if ('error' in result) void reply.code(STATUS[result.error]);
      return result;
    }
    const nick = (request.query as { nick?: string }).nick;
    if (typeof nick !== 'string' || nick.trim() === '') {
      void reply.code(400);
      return { error: 'E_NICK_REQUIRED' as const };
    }
    const result = await deps.join(id, nick.trim());
    if ('error' in result) void reply.code(STATUS[result.error]);
    return result;
  });
}

/**
 * The match-browser read-model + archive intents (docs/main-menu.md §2), served beside
 * the create/join API. A server projection — the client only reads it (A10/fog rule);
 * archive is fail-secure per-player (participants only, stable codes).
 */
export function registerBrowserApi(app: FastifyInstance, registry: MatchRegistry): void {
  // A repeated `?nick=a&nick=b` parses to an array — treat anything non-string as
  // absent (fail-secure: anonymous view / E_FORBIDDEN), like the join route's check.
  const nickOf = (request: FastifyRequest): string | null => {
    const nick = (request.query as { nick?: unknown }).nick;
    return typeof nick === 'string' ? nick : null;
  };

  // The three tabs (available/active/archived) for one viewer (`?nick=`).
  app.get('/matches', (request: FastifyRequest) => registry.list(nickOf(request)));

  const archive = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const { id, intent } = request.params as { id: string; intent: string };
    const nick = nickOf(request) ?? '';
    const result =
      intent === 'archive'
        ? await registry.archive(id, nick)
        : await registry.unarchive(id, nick);
    if (!result.ok) void reply.code(result.code === 'E_NO_MATCH' ? 404 : 403);
    return result;
  };
  app.post('/matches/:id/:intent(archive|unarchive)', archive);
}
