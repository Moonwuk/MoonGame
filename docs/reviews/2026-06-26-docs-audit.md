# Аудит документации — 2026-06-26

> Проход по **всем 27 докам** (`docs/*.md`, `docs/security/*.md`, `bearer.yml`): роадмапы
> на пригодность, описания на соответствие реальному коду/данным/CI. Каждое конкретное
> утверждение сверялось с источником (Read/Grep). Базовая линия: гейт зелёный, **282 теста
> / 37 файлов**; **11** базовых модулей в `index.ts`; сервер шлёт per-player видимые дельты
> с фильтрацией тумана (`matchRoom.ts:181,303-345`).
>
> **Главный вывод:** код почти нигде не выдумывает несуществующего. Доминирующий сбой —
> обратный: доки **отстали от кода** (under-claim) по туману-на-отправке, и **переобещают**
> (over-claim) в трёх местах (движок трейтов, боевой API в GDD, security-CI на GitHub).

## Вердикт по пригодности (роадмапы как набор)

- ✅ Структура мастер-плана (Этапы 0→7) и зависимостный граф — связны и реалистичны.
- ✅ `architecture.md`/`modulesystem.md` по шине/ядру/детерминизму — высоко-конформны;
  `backlog.md` — самый дисциплинированный (✅-метки совпадают с кодом).
- 🔴 **Фрагментация:** 15 файлов `*-roadmap.md`; «кирпичи» с двойной нумерацией
  (fan-out = SV-4.1 = OPS-2.1; drain = SV-2.2 = OPS-1.1; JWT = SE-0.1 = AC-1.3 = F7) —
  одно изменение надо синхронизировать в нескольких местах.
- 🔴 **План опережает код:** сервер — in-memory срез, а 7 форвард-роадмапов уже описывают
  PostgreSQL hot/cold-тиры, мульти-регион, A/B, GDPR-экспорт.
- 🟡 **Несинхронный пивот стека:** `persistence-roadmap.md:58` фиксирует «pg-boss по
  умолчанию», мастер `roadmap.md:115` всё ещё «Redis + BullMQ».

## Сводка несоответствий

| ID      | Сев.  | Стат. | Тема                                                  | Где                                                         |
| ------- | ----- | ----- | ---------------------------------------------------- | ---------------------------------------------------------- |
| OVR-1   | HIGH  | 🔴    | Движок трейтов/эффектов описан как готовый            | architecture.md, modulesystem.md:49, gdd.md                |
| OVR-2   | HIGH  | 🔴    | Боевой API GDD не существует (resolveBattle/computeX) | gdd.md:214,169,292                                          |
| OVR-3   | HIGH  | 🔴    | Security-CI на GitHub отсутствует                     | secure-sdlc-roadmap.md:36, CLAUDE.md                       |
| OVR-4   | MED   | 🔴    | Правило артиллерии не совпадает с TIER_ORDER          | gdd.md:226                                                  |
| OVR-5   | MED   | 🔴    | Герои/адмиралы поданы как хук-система                 | gdd.md:184-191,257                                          |
| UND-1   | HIGH  | 🔴    | Туман-на-отправке готов, но 6+ доков зовут pending    | multiplayer.md, server-roadmap, cross-platform, …          |
| UND-2   | MED   | 🔴    | captureOnArrivalModule невидим в перечислениях        | core-roadmap.md:11, state.md:75,307, multiplayer.md:151    |
| UND-3   | MED   | 🔴    | «full-state broadcast» — на деле дельты               | roadmap.md:116, server-roadmap, deep-technical:259         |
| UND-4   | MED   | 🔴    | victoryModule в dev-сервере уже подключён             | matchmaking-roadmap MM-0.2, metagame.md:60                 |
| UND-5   | MED   | 🔴    | engineering-review.md устарел целиком                 | engineering-review.md:3,360,91                              |
| NUM-1   | HIGH  | 🔴    | Счётчик тестов: 4 разных числа, ни одно не верно      | state.md, backlog.md, sprint-1.md, engineering-review.md   |
| NUM-2   | HIGH  | 🔴    | Карта файлов в state.md неполна/неверна               | state.md:64-81,108,307                                      |
| ROAD-1  | MED   | 🔴    | Внутреннее противоречие по Этапу 2                    | roadmap.md:245 vs :255                                      |
| CI-1    | MED   | 🔴    | «Ratcheting»-гейт описан, реализован zero-tolerance   | pipeline.md:42, secure-sdlc-roadmap.md                     |
| CI-2    | MED   | 🔴    | Gitleaks задублирован и раз-пинен                     | .gitlab-ci.yml:177 vs :226                                  |
| FRAG-1  | MED   | 🔴    | Фрагментация роадмапов / двойная нумерация            | весь набор *-roadmap.md                                     |

---

## А. Over-claims (доки обещают то, чего в коде нет)

### OVR-1 · 🔴 HIGH · Движок трейтов/эффектов
`architecture.md:73-81,540` и `modulesystem.md:49` («ядро *содержит* движок трейтов/
эффектов»); `gdd.md:168-171` строит на нём тактики/героев. Реально: есть **только**
`EffectRuleSchema` + `data/events.json` (`schemas.ts:119`), **ни один** файл не
интерпретирует `trigger→effect`. Механизма нет — есть форма данных. Пометить аспирационным.

### OVR-2 · 🔴 HIGH · Боевой API в GDD
`gdd.md:214,276`: `resolveBattle(fleetA,fleetB,seed)→BattleResult`. Реальный бой —
stateful, по раундам `combat.tick` (`combat.ts:583-643`), такой функции нет. Хуки
`computeDamage/computeHP/computeScore/computeSpeed` (`gdd.md:169,292`) не существуют:
реальные — `combat.damage`/`fleet.speed`/`economy.production`/`construction.requirement`.
`computeHP`/`computeScore`-конвейеров нет (HP/счёт считаются напрямую: счёт — прямой tally
в `victory.ts:25-72`).

### OVR-3 · 🔴 HIGH · Security/quality CI на GitHub отсутствует
`secure-sdlc-roadmap.md:36` («SEC-0 ✅ GitHub Actions build+audit»), CLAUDE.md («CI runs
lint+typecheck+test+audit»). На **GitHub только `android.yml`** (сборка APK). Весь гейт
качества/безопасности (lint/typecheck/test/audit + Semgrep/Bearer/Grype/Gitleaks/Trivy/SBOM)
живёт **исключительно в `.gitlab-ci.yml`**. Контрибьютор на GitHub PR-проверках не получает
ничего, кроме on-demand APK. (Bearer SAST реально запускается — но на GitLab.)

### OVR-4 · 🔴 MED · Правило артиллерии
`gdd.md:226-229`: артиллерия уязвима при потере **передней+средней** линий. Код:
`TIER_ORDER = ['front','mid','rear','artillery']` (`combat.ts:17`) — нужны **front+mid+rear**.

### OVR-5 · 🔴 MED · Герои (Адмирал/Губернатор/Генерал)
`gdd.md:184-191,257` — поданы как система с хук-бонусами («бонусы адмирала (хук)»). В коде
герой/admiral/general/governor отсутствует; есть лишь комментарий-намёк на точку расширения
в `combat.ts:489`. Незастроенная механика, описанная как действующая.

_Доп.: модель счёта в `gdd.md §8` («пустой узел = 1 очко») расходится с кодом
(`CONTROL_BASE = 10` + planetType/sector scoreValue + Σ building.scoreValue×level +
super-units; `victory.ts:7,32-69`)._

---

## Б. Under-claims (код опередил доки — доминирующая проблема)

### UND-1 · 🔴 HIGH · Туман-на-отправке готов, но описан как pending в 6+ доках
`matchRoom.ts:181,303-345` шлёт per-player видимые дельты + фильтрует события
(`eventVisibleTo`); есть e2e anti-leak тест (`scenario.test.ts` «F6»). Зовут «ещё не
сделано»: `multiplayer.md:3,198,220,227` (×4), `server-roadmap.md:15`/SV-3.1,
`cross-platform-roadmap.md:60`/CP1.4, `game-integrity-roadmap.md:16,25`,
`deep-technical-roadmap.md:259,537,579`, `tech-research.md §5`. **Самый большой системный
разрыв** — клиентская «честный туман» гейтится на том, что уже истинно.

### UND-2 · 🔴 MED · captureOnArrivalModule невидим в перечислениях
Существует, экспортируется (`index.ts:148`), тестируется, в кернеле прототипа
(`game.ts:607`) и dev-сервера (`scenario.ts:61`). Но `core-roadmap.md:11` пишет «9
модулей» (реально 11), `state.md:75,307` его опускает, а `multiplayer.md:151-156`
утверждает «walk-in capture — client-only, не в MP» — неверно.

### UND-3 · 🔴 MED · «full-state broadcast»
`roadmap.md:116`, `server-roadmap.md`, `deep-technical-roadmap.md:259` — на деле **дельты**
(`diffState` против видимого baseline; full state только на join/resync).

### UND-4 · 🔴 MED · victoryModule в dev-сервере уже подключён
`scenario.ts:15,65` (`DEV_MODULES`) включает `victoryModule`, но `matchmaking-roadmap.md`
MM-0.2 зовёт это «будущим (прототип и сервер)», а `metagame.md:60` относит победу/счёт к
«будущим модулям». (В прототипе — да, хардкод `checkEnd()`, `main.ts:1169`.)

### UND-5 · 🔴 MED · engineering-review.md устарел целиком
Шапка «209 тестов», сервер описан плейсхолдером, туман открыт — всё устарело (сервер
реальный, туман на отправке есть). Стопгап §8.1 «оккупация без гарнизона / переместить
`capturePlanet` перед `releaseOrDestroyFleet`» — **уже исправлено** (`combat.ts:351-364`).
Ещё валидны: §8.3 `isBombarded` O(fleets), §8.4 Dijkstra distance-matrix cache, §10
`fleet.launch` только в прототипе.

_Доп. устаревшие статус-маркеры:_ `core-roadmap.md:65` CR-2.1 ⏳ vs `backlog.md:39` A1m ✅
(память тумана сделана); `architecture.md:482` AOI «⏳ ждёт тумана» — устарело;
`secure-environment-roadmap.md:31-33` «visibleState ещё не применяется на отправке» —
устарело (`matchRoom.ts:181`).

---

## В. Числовой дрейф и state.md

### NUM-1 · 🔴 HIGH · Счётчик тестов
Живой гейт = **282 / 37**. Доки: **255** (`state.md:9,401`, `backlog.md:30`,
`map-roadmap.md:80`), **239** (`sprint-1.md:47,89`), **217** (`backlog.md:62,118`), **209**
(`engineering-review.md:3`). `state.md` — назначенный «якорь контекста» (на него ссылается
CLAUDE.md), но он сам неверен → ошибку наследуют все. Нужен один источник правды.

### NUM-2 · 🔴 HIGH · Карта файлов в state.md
`state.md:64-81` неполна: не размечены файлы `action-layer`; в `state/` пропущены
`route.ts/delta.ts/hash.ts/buildFromMap.ts/sectorKind.ts`; в `modules/` нет
`captureOnArrival`; в `data/` нет `sectorKinds.json` и `maps/`. Кернел прототипа
(`state.md:307`) опускает `captureOnArrival`; строка «порядок модулей» (`state.md:108`)
описывает порядок, которого нет ни в одном кернеле репо.

### ROAD-1 · 🔴 MED · Противоречие по Этапу 2 в roadmap.md
Стр. 245 «Этапы 2–7 — ⏳ запланировано» против стр. 255 «Этап 2 — 🧪 начат» (буллет висит
**ниже** финального футера стр. 253). Action-layer существует и тестируется → верна стр. 255.

---

## Г. CI / безопасность

### CI-1 · 🔴 MED · «Ratcheting»-гейт описан, но не реализован
`pipeline.md:42-48` и `secure-sdlc-roadmap.md` обещают diff-aware/baseline-планку.
Реально `security-gate-and-feedback` (`.gitlab-ci.yml`) — **zero-tolerance без baseline**
(любой error/warning рушит MR), ровно то, чего доки велят избегать.

### CI-2 · 🔴 MED · Gitleaks задублирован и раз-пинен
Два ключа `secrets-gitleaks:` (`.gitlab-ci.yml:177` `:v8.18.4` запиненный, blocking;
`:226` `:latest` с комментарием «👇 ЗАМЕНИТЕ СТАРУЮ СТРОКУ»). Второй молча перетирает первый
и **раз-пинит** сканер — нарушает собственное правило SD-6.1 (SHA-pin).

_Хорошо:_ `bearer.yml` корректен и реально запускается (`.gitlab-ci.yml:108`);
`secure-environment-roadmap.md`, `accounts-roadmap.md`, `game-integrity-roadmap.md`,
`metrics-roadmap.md` — самые точные, «факт»-секции сходятся с кодом.

---

## Д. Пригодность / фрагментация

### FRAG-1 · 🔴 MED · Фрагментация роадмапов
**15** файлов `*-roadmap.md`; многие «кирпичи» с двойной нумерацией (fan-out = SV-4.1 =
OPS-2.1; drain = SV-2.2 = OPS-1.1; observability в operations *и* metrics; JWT в
accounts/server/secure-env). Доки управляют этим «=»-кросс-метками, но дубль-нумерация
требует синхронизировать одно изменение в нескольких местах. Плюс несинхронный шедулер-пивот
(pg-boss vs Redis+BullMQ, `persistence-roadmap.md:58` vs `roadmap.md:115`).

---

## Предлагаемые синхронизации (от большого к малому)

1. **Один источник правды для статуса:** обновить `state.md` (282/37, карта файлов,
   кернелы, порядок модулей); остальные доки ссылаются на него, не дублируют числа.
2. **Закрыть «туман-на-отправке» как ✅** в `multiplayer.md`, `server-roadmap`,
   `cross-platform`, `game-integrity`, `deep-technical`, `roadmap.md:116`.
3. **Развести over-claims:** пометить трейты/героев аспирационными; поправить GDD
   (`combat.tick` вместо `resolveBattle`, реальные имена хуков, правило артиллерии, формула
   счёта).
4. **CI-правда:** явно написать, что гейт качества/SAST — на GitLab; решить про зеркальный
   GitHub-workflow; починить дубль Gitleaks; согласовать «ratcheting» в коде или доке.
5. **Снять фрагментацию:** свести двойную нумерацию, согласовать pg-boss vs Redis.
6. Поправить `captureOnArrival` во всех перечислениях модулей; `victoryModule` —
   как подключённый в dev-сервере; `roadmap.md` Этап 2 — единый статус.
