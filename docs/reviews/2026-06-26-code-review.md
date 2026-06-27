# Код-ревью — 2026-06-26

> Проход по всем подсистемам `packages/*` (баги, стандартизация, упрощение). Каждая
> находка прошла состязательную верификацию против инвариантов проекта (детерминизм,
> чистота/иммутабельность, «модули — только через шину», fail-secure, server-authority,
> детерминизм порядка модулей). Базовая линия: гейт зелёный, **282 теста / 37 файлов**.
>
> Итог прохода: 17 находок, 15 подтверждено, 2 отклонено верификацией. Код **здоровый**:
> инварианты соблюдаются, баги в основном латентные — кроме серверного `SRV-1`.
>
> Статус всех находок ниже: 🔴 Open (по коду пока ничего не менялось — это отчёт).

## Сводка

| ID         | Сев.  | Стат. | Файл                                   | Категория      | Заголовок                                                       |
| ---------- | ----- | ----- | -------------------------------------- | -------------- | -------------------------------------------------------------- |
| SRV-1      | HIGH  | 🔴    | server/src/matchRoom.ts:245            | bug            | Отклонённое действие коммитит advance, но не рассылает события  |
| KRN-1      | MED   | 🔴    | shared-core/kernel/kernel.ts:203       | bug            | advanceTo диспетчит устаревшую голову расписания после accrue   |
| CON-1      | MED   | 🔴    | shared-core/modules/construction.ts:311| standardization| Ре-дефер стройки под бомбардировкой игнорирует timeScale         |
| KRN-2      | LOW   | 🔴    | shared-core/kernel/kernel.ts:287       | bug            | schedule() клампит по устаревшему draft.time, а не stepTime      |
| CMB-1      | LOW   | 🔴    | shared-core/modules/combat.ts:378      | bug            | Орбитальный победитель → far, но bombarding не сброшен           |
| MOV-1      | LOW   | 🔴    | shared-core/modules/movement.ts:285    | bug            | toEdge в текущий узел отдаёт E_NO_ROUTE вместо E_SAME_LOCATION   |
| MOV-2      | LOW   | 🔴    | shared-core/modules/movement.ts:295    | bug            | fleet.departed from/to неточны при развороте / марше в точку     |
| DLT-1      | LOW   | 🔴    | shared-core/state/delta.ts             | bug            | diffState/applyDelta теряют top-level `fog` (round-trip контракт)|
| SRV-2      | LOW   | 🔴    | server/src/matchRoom.ts:223            | bug            | Resync сбрасывает общий per-player baseline, а шлётся 1 peer     |
| TEC-1      | LOW   | 🔴    | shared-core/modules/technology.ts:8    | standardization| Локальная MS_PER_HOUR вместо импорта из util/time               |
| VIC-1      | LOW   | 🔴    | shared-core/modules/victory.ts:15      | standardization| Локальная addUnits затеняет util/stacks addUnits                |
| SEC-1      | LOW   | 🔴    | shared-core/modules/sector.ts:55       | standardization| Деление на (1+hpBonus) без гарда 1+bonus>0                       |
| SCH-1      | LOW   | 🔴    | shared-core/data/mapSchema.ts:50       | standardization| Инлайн resource-bag вместо ResourceBagSchema                    |
| ACT-1      | LOW   | 🔴    | action-layer/src/errors.ts:5           | simplification | Мёртвый код E_DUPLICATE (никогда не производится)               |
| CMB-2      | LOW   | 🔴    | shared-core/modules/combat.ts:256      | simplification | Недостижимая ветка `if (at === null)` в assaultPlanet           |

Плюс две заметки из ручного чтения (см. в конце): `NOTE-1` (мёртвые `isBuildable`/`hasOrbit`),
`NOTE-2` (устаревший счётчик тестов в `docs/state.md`).

---

## SRV-1 · 🔴 HIGH · bug · server/src/matchRoom.ts:245

**Отклонённое действие коммитит продвижение мира, но никогда его не рассылает.**

`submitAction` сначала вызывает `advance(serverNow)`, который **коммитит** продвинутый
мир в `this.stateValue` (`matchRoom.ts:280`) и возвращает поток сработавших событий в
`advanced.events`. Затем — `kernel.applyAction`. Если действие **отклонено**
(`matchRoom.ts:245` — частый случай: невалидный/нелегальный приказ), функция пишет
receipt, шлёт rejection и выходит **без** `broadcastState`.

Последствия:

1. Все доменные события из `advance` (`fleet.arrived`, `battle.resolved`,
   `planet.captured`, `unit.died`, `time.advanced`…) **безвозвратно теряются** — ни один
   peer их не получит (нигде не переотправляются: `advanceTo` сплайсит событие из
   `scheduled` при срабатывании).
2. **Тик-лупа нет** (`advance`/`broadcastState` зовутся только внутри `submitAction`/
   add/removePeer), поэтому клиенты **не видят продвинувшийся мир** до следующего
   *успешного* действия любого игрока — а это могут быть часы игрового времени и
   разрешённые бои.

Нарушает контракт «`advanceTo` эмитит непрерывный поток событий, на который полагаются
потребители».

**Фикс:** на ветке отказа `applyAction` всё равно сбросить продвижение перед выходом:
`if (advanced.events.length > 0) this.broadcastState(advanced.events);` перед
`recordReceipt`/`sendRejection`. Идемпотентно (стейт уже продвинут и действием не
изменён), `broadcastState` пересчитывает per-player baseline. Добавить тест: запланировать
due-событие (прибытие/бой), отправить заведомо отклоняемое действие, проверить, что peer
получил дельту с событиями продвижения.

_Прим.: существующий тест «rejects cross-player spoofed actions without broadcasting state»
покрывает PRE-advance отказ (`matchRoom.ts:229`, до `advance`) и остаётся валиден — это
другой, POST-advance путь._

---

## KRN-1 · 🔴 MED · bug · shared-core/kernel/kernel.ts:203

**`advanceTo` диспетчит устаревшую захваченную голову расписания после `accrue`.**

`next` захватывается из головы `committed.scheduled` (стр. 203) **до** `accrue` (стр. 207).
`accrue` эмитит шаг `time.advanced {from,to}`, чьи подписчики могут легитимно вызвать
`h.schedule(at, …)`. Из-за `KRN-2` пол клампа = `draft.time` (= старый `from`), поэтому
обработчик может вставить **новое** событие с `from <= at < next.at`; sorted-insert ставит
его в индекс 0, а исходный `next` сдвигается в индекс 1. Дальше код считает, что в индексе 0
по-прежнему `next`: `base.scheduled = committed.scheduled.slice(1)` **выкидывает новое
(более раннее) событие**, а `runStep` диспетчит **устаревший** `next.type/next.payload` в
`next.at`. Итог: раннее событие молча теряется, события идут не по порядку `(at,seq)` —
нарушение задокументированного контракта.

Сейчас **недостижимо** через имеющиеся модули (все шедулят `now + Δ`, а во время `accrue`
`ctx.now = next.at`, так что все попадают после головы). Но это дыра на задокументированной
точке расширения: модуль, шедулящий по абсолютному/`from`-производному инстанту, её зацепит.

**Фикс:** не переносить захваченный `next` через границу `accrue`. Когда `next.at >
committed.time` — выполнить `accrue` и `continue`, чтобы цикл перечитал `earliestDue` против
(возможно, обновлённой) головы. Только когда `accrue` не нужен (`head.at === committed.time`)
— читать голову заново и слайсить её.

---

## CON-1 · 🔴 MED · standardization · shared-core/modules/construction.ts:311

**Ре-дефер достроенного-под-бомбардировкой здания игнорирует `timeScale`.**

`construction.complete` под бомбардировкой переносит себя через `h.ctx.now + MS_PER_HOUR`
— сырой реальный час **без** деления на `timeScaleOf`. Все остальные длительности в
кодовой базе масштабируются: `scheduleCompletion` тут же (`construction.ts:53`) делает
`(hours * MS_PER_HOUR) / timeScaleOf(h.ctx)`, а `combat.ts:24` так же делит даже частоту
тиков. На ускоренном матче (`timeScale > 1`) готовое здание может «висеть» недоставленным
до реального часа после снятия бомбардировки. Это рассинхрон с тайм-компрессией матча, не
только косметика.

**Фикс:** `h.schedule(h.ctx.now + MS_PER_HOUR / timeScaleOf(h.ctx), 'construction.complete', p)`
(`timeScaleOf` уже импортирован).

---

## KRN-2 · 🔴 LOW · bug · shared-core/kernel/kernel.ts:287

**`schedule()` клампит `at` по устаревшему `draft.time` вместо инстанта шага.**

`const safeAt = at < draft.time ? draft.time : at;` — но `draft.time` стампится в `stepTime`
только в **конце** `runStep` (стр. 338); во время обработчика он ещё равен `base.time`. При
`applyAction` без предшествующего `advanceTo` к тому же инстанту (`state.time < ctx.now`) и
для `time.advanced` (accrue: `draft.time = from`, `stepTime = to`) обработчик может
запланировать `at` в `[draft.time, stepTime)` — событие ляжет **до** инстанта шага. Затем
коммит стампится `stepTime`, оставляя событие «в прошлом»; следующий `advanceTo` сработает
им при `at < committed.time` и `runStep` стампит `draft.time = at`, двигая время **назад**.
`module.ts:27-29` документирует пол клампа как «никогда в прошлом» = относительно текущего
инстанта = `stepTime`.

**Фикс:** `const safeAt = at < stepTime ? stepTime : at;` (`stepTime` в области видимости
`runStep`, равен `stepCtx.now`). Существующие тесты не затрагивает (в них `state.time ===
ctx.now`).

---

## CMB-1 · 🔴 LOW · bug · shared-core/modules/combat.ts:378

**Орбитальный победитель форсится в `far`, но `bombarding` не сбрасывается.**

`finishBattle` ставит победившему атакующему `orbit = 'far'`, но не чистит `bombarding`.
Экшен `fleet.orbit` явно держит инвариант «нельзя бомбить с far» (`combat.ts:519-522`
ставит `bombarding = false` при переходе в far). Бомбящий флот, отправленный в путь
(`fleet.move` не чистит `bombarding`), на `fleet.transit/arrived` становится орбитальным
атакующим и при победе остаётся в `far`+`bombarding=true` — комбинация, которую экшен-слой
считает невозможной. То же на `combat.ts:501` (прибытие безусловно ставит `orbit='far'`).
Сейчас инертно (оба потребителя дополнительно гейтят `orbit === 'near'`), но это
противоречивая запись состояния.

**Фикс:** в орбитальном блоке `finishBattle` (и на прибытии): `if (f) { f.orbit = 'far';
f.bombarding = false; }`.

---

## MOV-1 · 🔴 LOW · bug · shared-core/modules/movement.ts:285

**`toEdge`-цель, схлопывающаяся по EPS в текущий узел, отдаёт `E_NO_ROUTE`.**

Гард `E_SAME_LOCATION` (стр. 285) срабатывает только для node-движений (`payload.to ===
fleet.location`). Для флота **на узле** `toEdge`-марш с `t<=EPS` (или `t>=1-EPS`), где
`routeTo` совпадает с текущим узлом, не ловится: `mid = planRoute(node,node) = []`,
`hops.length === 0` → `continue`, `best` остаётся null → отказ `E_NO_ROUTE` (стр. 290).
Семантически верный код — `E_SAME_LOCATION` («ты уже там»), его же использует быстрый путь
для аналогичного припаркованного случая (`movement.ts:220`). Состояние не мутируется —
утечка лишь в неверном стабильном коде ошибки.

**Фикс:** если все `routeTo` равны текущему узлу и все `final` пусты — отдавать
`E_SAME_LOCATION`, а не проваливаться в null/`E_NO_ROUTE`.

---

## MOV-2 · 🔴 LOW · bug · shared-core/modules/movement.ts:295

**`fleet.departed` `from`/`to` неточны при развороте припаркованного флота / марше в точку.**

`from = fleet.location ?? fleet.edge?.from` (стр. 295) — для любого припаркованного флота
это всегда `edge.from`, даже когда `planJourney` выбрал разворот (`origin.fromId = edge.to`,
лега идёт к `edge.from`). `to = payload.to ?? последний hop` (стр. 302) — для `toEdge`
истинная цель это точка **на** лейне, но репортится последний узел-hop. Потребители сейчас
только косметические (печать в `skirmish.test`), но payload-контракт внутренне расходится с
реально стартующей легой.

**Фикс:** репортить `plan.fromId` как origin (или опускать `from` для припаркованного), а
для `toEdge` репортить реальную цель-точку, а не терминальный узел.

---

## DLT-1 · 🔴 LOW · bug · shared-core/state/delta.ts

**`diffState`/`applyDelta` роняют top-level поле `fog`, нарушая round-trip контракт.**

`GameState.fog?` (`gameState.ts:264`) — top-level JSON-сериализуемое поле, но `COLLECTIONS`
и `META_KEYS` его не содержат, поэтому `diffState` его не диффит, а `applyDelta` не переносит.
Это молча нарушает задокументированный контракт `applyDelta(prev, diffState(prev, next))`
deep-equals `next` (`delta.ts:14`). В проде замаскировано (диффится только проекция
`visibleState`, где `fog` уже вырезан — `visibility.ts:196`), но `diffState`/`applyDelta`
публично экспортируются (`index.ts:59`), так что любой консьюмер сырого стейта потеряет
память тумана.

**Фикс:** добавить `'fog'` в `META_KEYS` (`applyDelta` уже гонит meta через `Object.assign`,
объект-`fog` переносится корректно). Либо — уточнить docstring, что равенство «по модулю
`fog`», если поле исключено намеренно.

---

## SRV-2 · 🔴 LOW · bug · server/src/matchRoom.ts:223

**Resync деduplated-retry сбрасывает общий per-player baseline, а шлётся одному peer.**

На дедуп-ретрае успешного действия `submitAction` шлёт `stateMessageFor(playerId)`
единственному ретраящему peer. `stateMessageFor` ресетит `this.lastVisible.set(playerId,
view.base)` — но `lastVisible` keyed по **игроку** и общий для всех его peer (`peers.get`
= Set). При нескольких устройствах/вкладках одного игрока полный resync получает только
ретраящий peer, а общий baseline продвигается для всех; остальные peer застревают на старой
реконструкции (следующий `broadcastState` диффит против уже-текущего baseline → почти пустая
дельта). Single-peer-per-player (норма dev-харнесса) не затронут.

**Фикс:** либо разослать resync всем peer игрока (как в `broadcastState`), либо не мутировать
общий `lastVisible` из single-peer resync; если модель строго «один peer на игрока» —
зафиксировать это на `addPeer`.

---

## TEC-1 · 🔴 LOW · standardization · shared-core/modules/technology.ts:8

**Локальная `const MS_PER_HOUR = 3_600_000` вместо импорта.** Все остальные duration-модули
импортируют из `../util/time` (единый источник правды): `movement.ts:4`, `combat.ts:5`,
`construction.ts:9`, `economy.ts:7`. `technology.ts` дублирует магическую константу.
**Фикс:** удалить локальную, добавить `import { MS_PER_HOUR } from '../util/time';`.

---

## VIC-1 · 🔴 LOW · standardization · shared-core/modules/victory.ts:15

**Локальная `addUnits(score, stacks, data)` затеняет по имени util-хелпер
`addUnits(stacks, unit, count)`** (`util/stacks.ts:11`) с другой сигнатурой/семантикой.
Коллизии сейчас нет (util не импортируется), но имя зарезервировано за stack-мутацией.
**Фикс:** переименовать локальную в `tallyUnits`.

---

## SEC-1 · 🔴 LOW · standardization · shared-core/modules/sector.ts:55

**Деление `result /= 1 + type.hpBonus` под гардом только `hpBonus !== 0`.** `hpBonus` —
безграничный `z.number()` (`schemas.ts:135`); `hpBonus = -1` даёт деление на ноль (Infinity),
`< -1` — смену знака. Близнец `planetType.ts:58` тот же идиом защищает гардом `bonus !== 0
&& 1 + bonus > 0`. Шиппнутые данные используют только положительный `hpBonus`, поэтому
живого сбоя нет. **Фикс:** `if (type && type.hpBonus !== 0 && 1 + type.hpBonus > 0)
result /= 1 + type.hpBonus;`.

---

## SCH-1 · 🔴 LOW · standardization · shared-core/data/mapSchema.ts:50

**`resources: z.record(z.string(), z.number()).default({})` инлайном** дублирует уже
экспортированную `ResourceBagSchema` (`schemas.ts:14`), используемую везде для resource-bag.
**Фикс:** `import { ResourceBagSchema } from './schemas';` → `resources:
ResourceBagSchema.default({})` (это соседние data-схемы, не модули — правило «модули не
импортируют друг друга» не нарушается).

---

## ACT-1 · 🔴 LOW · simplification · action-layer/src/errors.ts:5

**Мёртвый код `E_DUPLICATE`.** Член union `ActionLayerErrorCode`, но `fail('E_DUPLICATE')`
не вызывается нигде (repo-wide grep — только объявление). Дубликаты идут **успешной**
веткой `ok({ status: 'duplicate', … })` (`gate.ts:58-59`), отдавая кэшированный receipt, а
не отказ. **Фикс:** удалить `'E_DUPLICATE'` из union.

---

## CMB-2 · 🔴 LOW · simplification · shared-core/modules/combat.ts:256

**Недостижимая ветка `if (at === null) return 'E_FLEET_BUSY'` в `assaultPlanet`.**
Единственный вызывающий (`combat.ts:536`) уже провёл флот через `requireOwnedIdleFleet`,
чей тип `IdleFleet` гарантирует не-null `location` (`util/fleet.ts:24-27` реджектит
`location === null`). Защитный мёртвый код. **Фикс:** типизировать параметр как `IdleFleet`
и убрать проверку, либо оставить с комментарием «unreachable» — поведение не меняется.

---

## Заметки (из ручного чтения, вне состязательного прохода)

### NOTE-1 · 🔴 LOW · shared-core/state/sectorKind.ts:27,32

**`isBuildable` и `hasOrbit` экспортируются публично (`index.ts:51`), но не используются
нигде** — ни в модулях, ни в тестах (используется только `isCapturable`). Либо мёртвый
код, либо **пропущенные гарды**: `construction` не проверяет `isBuildable` перед стройкой,
combat не проверяет `hasOrbit` перед орбитальными операциями. `map-roadmap.md` §0 намекает
на гейтинг по `kind`. Решение: выпилить как мёртвый код **или** подключить как гарды.

### NOTE-2 · 🔴 LOW · docs/state.md:9,401

**Счётчик тестов устарел:** `state.md` пишет «255 тестов», по факту — **282 / 37 файлов**.
Подробнее — в аудите документации (`2026-06-26-docs-audit.md`, раздел числового дрейфа).

---

## Отклонено верификацией (2)

Две находки прохода были отклонены состязательным верификатором (мисрид кода / опора на
невозможный вход / поведение намеренное и инвариантам не противоречит) и в отчёт не вошли.
