import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  createKernel,
  pairKey,
  type GameState,
  type Planet,
  type Player,
} from '@void/shared-core';
import { MatchRoom, type RoomPeer } from './matchRoom';
import { DEV_MODULES, loadShippedData } from './scenario';

/**
 * Session chat is an EPHEMERAL server relay (same family as ally pings): the room
 * stamps id/at, clamps the text and decides recipients server-side — `session`
 * reaches everyone, `coalition` the sender's live allies (static team OR an
 * in-state alliance), `dm` exactly the two parties. A bounded back-log replays to
 * a (re)joining peer. These tests assert the privacy boundary, the join replay,
 * the clamp and the (wall-clock) rate limit.
 */

interface WireMsg {
  type: string;
  code?: string;
  message?: { id: string; from: string; channel: string; to?: string; text: string; at: number };
}

class Peer implements RoomPeer {
  readonly msgs: WireMsg[] = [];
  send(data: string): void {
    this.msgs.push(JSON.parse(data) as WireMsg);
  }
  close(): void {}
  ofType(type: string): WireMsg[] {
    return this.msgs.filter((m) => m.type === type);
  }
  chatTexts(): string[] {
    return this.ofType('chat.msg').map((m) => m.message!.text);
  }
}

const planet = (id: string, owner: string, x: number): Planet => ({
  id,
  owner,
  position: { x, y: 0 },
  links: [],
  resources: {},
  buildings: [],
  garrison: [],
  traits: [],
});

function makeRoom(
  opts: { teams?: Record<string, string>; alliance?: [string, string]; now?: () => number } = {},
): MatchRoom {
  const data = loadShippedData();
  const base = createInitialState({
    seed: 'chat',
    version: { data: data.version, manifest: '1' },
    time: 0,
  });
  const players: Record<string, Player> = {
    green: { id: 'green', name: 'G', faction: 'vanguard', status: 'active', resources: {} },
    blue: { id: 'blue', name: 'B', faction: 'vanguard', status: 'active', resources: {} },
    red: { id: 'red', name: 'R', faction: 'vanguard', status: 'active', resources: {} },
  };
  const planets: Record<string, Planet> = {
    home_green: planet('home_green', 'green', 0),
    home_blue: planet('home_blue', 'blue', 100),
    home_red: planet('home_red', 'red', 900),
  };
  const state: GameState = { ...base, players, planets };
  if (opts.alliance) {
    state.diplomacy = { [pairKey(opts.alliance[0], opts.alliance[1])]: 'alliance' };
  }
  return new MatchRoom({
    id: 't',
    initialState: state,
    kernel: createKernel(DEV_MODULES),
    data,
    now: opts.now ?? (() => 0),
    teams: opts.teams,
  });
}

const say = (channel: string, text: string, to?: string): string =>
  JSON.stringify(to === undefined ? { type: 'chat.send', channel, text } : { type: 'chat.send', channel, to, text });

describe('session chat relay', () => {
  it('session channel reaches every seat, including the sender (the echo renders it)', async () => {
    const room = makeRoom();
    const g = new Peer();
    const b = new Peer();
    const r = new Peer();
    room.addPeer('green', g);
    room.addPeer('blue', b);
    room.addPeer('red', r);

    await room.receive('green', g, say('session', 'gl hf'));

    for (const peer of [g, b, r]) expect(peer.chatTexts()).toEqual(['gl hf']);
    const msg = g.ofType('chat.msg')[0]!.message!;
    expect(msg.from).toBe('green');
    expect(msg.channel).toBe('session');
    expect(msg.id).toMatch(/^chat:green:/);
  });

  it('coalition reaches static-team allies and LIVE in-state alliances — never enemies', async () => {
    // green+blue allied through the diplomacy stance map (no static teams at all)
    const room = makeRoom({ alliance: ['green', 'blue'] });
    const g = new Peer();
    const b = new Peer();
    const r = new Peer();
    room.addPeer('green', g);
    room.addPeer('blue', b);
    room.addPeer('red', r);

    await room.receive('green', g, say('coalition', 'push mid'));

    expect(g.chatTexts()).toEqual(['push mid']); // own echo
    expect(b.chatTexts()).toEqual(['push mid']); // live ally
    expect(r.chatTexts()).toEqual([]); // enemy is never sent it
  });

  it('a dm reaches exactly the two parties; a bad addressee is E_CHAT_TARGET', async () => {
    const room = makeRoom();
    const g = new Peer();
    const b = new Peer();
    const r = new Peer();
    room.addPeer('green', g);
    room.addPeer('blue', b);
    room.addPeer('red', r);

    await room.receive('green', g, say('dm', 'nice opening', 'blue'));
    expect(g.chatTexts()).toEqual(['nice opening']);
    expect(b.chatTexts()).toEqual(['nice opening']);
    expect(r.chatTexts()).toEqual([]);

    await room.receive('green', g, say('dm', 'to nobody', 'ghost'));
    await room.receive('green', g, say('dm', 'to myself', 'green'));
    expect(g.ofType('error').filter((m) => m.code === 'E_CHAT_TARGET')).toHaveLength(2);
  });

  it('replays the visible back-log on join — dm to its parties, coalition never to enemies', async () => {
    const room = makeRoom({ alliance: ['green', 'blue'] });
    const g = new Peer();
    room.addPeer('green', g);
    await room.receive('green', g, say('session', 'hello all'));
    await room.receive('green', g, say('coalition', 'ally plan'));
    await room.receive('green', g, say('dm', 'for blue only', 'blue'));

    const b = new Peer();
    room.addPeer('blue', b); // ally + dm addressee, joins AFTER the talk
    expect(b.chatTexts()).toEqual(['hello all', 'ally plan', 'for blue only']);

    const r = new Peer();
    room.addPeer('red', r); // enemy: session history only
    expect(r.chatTexts()).toEqual(['hello all']);
  });

  it('clamps oversized text and refuses an empty line (E_CHAT_TEXT)', async () => {
    const room = makeRoom();
    const g = new Peer();
    room.addPeer('green', g);

    await room.receive('green', g, say('session', 'x'.repeat(1000)));
    expect(g.chatTexts()[0]).toHaveLength(240);

    await room.receive('green', g, say('session', '   '));
    expect(g.ofType('error').some((m) => m.code === 'E_CHAT_TEXT')).toBe(true);
  });

  it('rate-limits a flood on the WALL clock (keeps working in a frozen lobby)', async () => {
    const room = makeRoom(); // now() is frozen at 0 — like a lobby-frozen match clock
    const g = new Peer();
    room.addPeer('green', g);
    for (let i = 0; i < 7; i++) await room.receive('green', g, say('session', `line ${i}`));
    expect(g.chatTexts()).toHaveLength(6);
    expect(g.ofType('error').some((m) => m.code === 'E_CHAT_RATE')).toBe(true);
  });
});
