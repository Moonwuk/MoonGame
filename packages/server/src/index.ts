// Authoritative game server — Stage 3 of docs/roadmap.md.
//
// Will host: Fastify, PostgreSQL (JSONB GameState), Redis + BullMQ (event
// scheduler), the WebSocket diff layer, the per-player action queue, and
// fog-of-war filtering. It consumes @void/shared-core as the single source of
// simulation truth (server-authority — docs/architecture.md §5).
//
// Intentionally empty until Stage 2 (action layer) is in place.
export {};
