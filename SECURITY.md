# Security Policy · Политика безопасности

Void Dominion (MoonGame) is a real-time, massively-multiplayer strategy game in
active development. We take the security and integrity of the game, its servers,
and its players seriously. Void Dominion — realtime MMO-стратегия в активной
разработке; безопасность и целостность игры и игроков для нас первостепенны.

## Reporting a vulnerability · Как сообщить об уязвимости

**Please do NOT open a public issue, PR, or discussion for a security
vulnerability.** **Пожалуйста, НЕ создавайте публичный issue / PR / discussion
для уязвимости** — это раскроет её раньше, чем выйдет исправление.

Use GitHub's **private vulnerability reporting**:
the repository **Security** tab → **Report a vulnerability**
(Security → Advisories → “Report a vulnerability”). See
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>.
It opens a private advisory visible only to you and the maintainers.

If private reporting is not yet enabled on the repository, please ask a
maintainer to turn it on via any non-public channel rather than disclosing
details publicly. Если приватные отчёты ещё не включены — попросите maintainer'а
активировать их непубличным способом.

Please include, where possible:

- affected component (file path / HTTP endpoint / action type) and the
  version or commit SHA;
- impact and a minimal reproduction (PoC);
- for **game-integrity** exploits (cheat / resource duplication / economy
  abuse / anti-bot bypass) — reproduction steps plus the match/account context.

## Scope · Область

**In scope:**

- Server (`packages/server`), the action gate (`packages/action-layer`), the
  deterministic simulation (`packages/shared-core`), the client
  (`packages/client`, `prototype/`), the Android wrapper (`mobile/`), and the
  CI/CD workflows + infrastructure-as-code under `.github/` and `deploy/`.
- Game-integrity issues: server-authority bypass, fog-of-war / hidden-state
  leaks, resource or item duplication, economy abuse, anti-bot / anti-alliance
  bypass, and action-gate / idempotency / sequence-gate bypass.

**Out of scope** (unless chained into real, cross-account impact):

- Issues only reachable by tampering with your OWN local client, `localStorage`,
  or session (self-XSS);
- purely informational scanner/best-practice notes;
- volumetric DDoS, social engineering, and physical attacks.

## Response · Реакция

We are a small team on a pre-release project, so we work best-effort: expect an
acknowledgement within a few days. We triage, fix on a private branch, ship the
release, and — with your consent — credit you in the published advisory. There is
no paid bounty program yet, but coordinated disclosure is genuinely appreciated.

## Our security posture · Наша защита

Security is a first-class track in this repository, not an afterthought:

- **Fail-secure core** (OWASP A10) and **server authority** — the client sends
  intent, never state; any error becomes a typed rejection.
- **Continuous scanning** on every push with a deliberately diverse toolset —
  Semgrep, CodeQL, Trivy (fs + image), OSV-Scanner, Gitleaks, TruffleHog,
  zizmor, and OpenSSF Scorecard. See
  [`.github/workflows/security.yml`](.github/workflows/security.yml) and
  [`docs/security/pipeline.md`](docs/security/pipeline.md).
- **Supply-chain integrity** — GitHub Actions are SHA-pinned and scanner Docker
  images are digest-pinned; see [`docs/security/image-pinning.md`](docs/security/image-pinning.md).
- **Program & roadmaps** — [`docs/security/`](docs/security/),
  [`docs/secure-sdlc-roadmap.md`](docs/secure-sdlc-roadmap.md),
  [`docs/secure-environment-roadmap.md`](docs/secure-environment-roadmap.md),
  and [`docs/game-integrity-roadmap.md`](docs/game-integrity-roadmap.md).

Thank you for helping keep Void Dominion and its players safe.
