# Admiral refactor plan — presence control redesign

> Written 2026-07-31. No conservatism constraint: this rethinks the worker core,
> schemas, and status API. Behavior goals are preserved (they are the spec);
> internal structure is replaced. Each phase is independently deployable and
> testable — important because the trip deadline makes "big bang" risky.

## 0. Why the current code feels shaky (diagnosis)

`src/worker/engine.ts` is 1581 lines and does eleven jobs: scheduling, control
state, FSM driving, room watch, sweep orchestration, participant sampling,
notification triggering, schedule hot-reload, status assembly, persistence
marshalling, and housekeeping. Concrete smells:

1. **Two competing "where am I" concepts.** `activeSlot` (schedule) vs
   `currentRoomSlot` (occupied room). Adopted rooms are fake `ActiveSlot`s with
   `startedAt: new Date().toISOString()` — a UTC ISO string in a field typed and
   used everywhere else as an IST-offset string (engine.ts:1362). Frontend parses
   times with `startedAt.slice(11, 16)`.
2. **The state machine lost authority.** Sweep/adoption code assigns
   `this.state` directly in ~6 places (`adoptProbedRoom`, `handleScrapeDeadRoom`,
   `finishSweepFallback`, sweep-cap path), bypassing `nextTransition`. Meanwhile
   `TickSignals` grew to 12 fields and the engine pre-computes derived truth
   (`effectiveHeartbeatFresh`, `newSlotStarted`, `sessionSuppressed`) — the
   meaning-making leaked out of the FSM into tick wiring.
3. **Four separate "don't join" mechanisms**, each with its own storage, GC,
   ack email, and status shape: global standdown (`worker_state.standdown`),
   session standdown (`session_standdown_json` + GC in tick + boot GC),
   handoff grace (migration v3 columns), join backoff (v1 columns + streak).
4. **Pending-flag soup.** `roomSweepPending`, `scrapeDeadRoomPending`,
   `forceJoinPending`, `forceLeavePending` — set in one method, consumed in
   another, cleared at tick end. Ordering is implicit and un-testable.
5. **`sessionKey(courseId@startedAt)` is load-bearing but unstable.** Swaps
   change `startedAt` mid-day; adopted rooms get synthetic keys; samples and
   summaries hang off it anyway.
6. **Env config scattered** as `private static readonly` initializers reading
   `process.env` at class-load time — untestable, undiscoverable.
7. **~13 `center.enqueue(...)` call sites** in the engine with inline payload
   construction; the set of notification kinds is only discoverable by grepping.
8. **`StatusResponse` is a 25-field flat grab-bag** mixing schedule view-model,
   control state, room state, and watch state.
9. **`worker_state` grows a migration per knob** (v3 added 2 columns, v4 added
   1 — exactly the retrofit pattern).
10. **Hand-rolled SVG chart** (~200 lines in participant-stats.js) for a
    step-line time series — a solved problem.

## 1. Target architecture

One idea replaces the tangle: **a reconciler**. Each tick computes *what should
be true* (pure) and the engine makes it true (effects). Today's
`maintainRoomCoverage` is already an ad-hoc mini-reconciler bolted onto the
FSM; we promote the pattern to be the whole design and delete the FSM's
decision role.

```
tick():
  if (actionInFlight) return            // one action at a time (as today)
  world = sense()                       // gather inputs (cheap, pure-ish)
  decision = decide(world)              // PURE: desired room + actions
  await act(decision)                   // join/leave/sweep jobs
  record()                              // events, samples, status
```

### 1.1 New worker module layout

```
src/worker/
  engine.ts                 thin orchestrator: ticker, sense/act loop, status, API surface
  presence/
    slots.ts                Slot type (epoch ms), slotId(), sessionKey() — one home
    occupancy.ts            OccupancyTracker: THE answer to "which room am I in"
    suppressions.ts         unified join-gate model (standdown/session/grace/backoff)
    decider.ts              pure decide(world) → Decision  [replaces stateMachine.ts]
    roomWatch.ts            explicit small FSM for empty/dead-room evaluation
    sweeper.ts              sweep as a cancellable step-job
  schedule/
    calendar.ts             today's schedule.ts (pure materialization) — kept, renamed
    overrides.ts            ops validation/construction/merge (moved out of engine)
  jobs.ts                   generic long-action runner: in-flight guard, abort callback, liveness pulse
  config.ts                 WorkerConfig: every engine knob, built once from env, injected
  notify.ts                 typed facade over NotificationCenter (coverStart(slot), ...)
  notifications.ts          outbox/budget/render — kept as-is
  persistence.ts            reorganized (see §3)
  stateMachine.ts           DELETED (tests ported to decider tests)
```
### 1.2 Core types (presence/slots.ts)

```ts
// Times are epoch ms internally; IST formatting happens only at boundaries
// (config parse, emails, frontend display). No more ISO-string slicing.
type Slot = {
  courseId: string; className: string; classPageUrl: string;
  joinLinkText: string; myDisplayName: string;
  startsAtMs: number; endsAtMs: number;     // derived from IST wall clock
  dateKey: string;                          // IST date the slot belongs to
};
const slotId = (s: Slot) => `${s.courseId}@${s.dateKey}T${hhmm(s.startsAtMs)}`;

// What room we're actually in — first-class, separate from the schedule.
type RoomRef = {
  courseId: string; className: string; classPageUrl: string;
  joinLinkText: string; myDisplayName: string;
};
type Occupancy = {
  room: RoomRef;
  via: "schedule" | "sweep-adopt" | "force";
  slot: Slot | null;           // the scheduled slot being covered (null for pure force-joins)
  originSlotId: string | null; // set for sweep-adopt
  enteredAtMs: number;
  joinUrl: string | null;
};
```

Adopted rooms stop pretending to be schedule slots. `OccupancyTracker` owns
`enter(room, meta)` / `exit()` / `current`, persists the marker, and answers
`isAdopted()`, `roomForScrape()` — ending the `currentRoomSlot ?? activeSlot`
pattern.

### 1.3 Suppressions — one model for every "don't join" (presence/suppressions.ts)

```ts
type Suppression =
  | { kind: "standdown" }                                        // manual off only
  | { kind: "session"; slotId: string }                          // GC'd when slot passes
  | { kind: "handoff_grace"; slotId: string; untilMs: number }   // auto-expire / clear on fresh heartbeat
  | { kind: "join_backoff"; untilMs: number };                   // auto-expire
```

- Stored in a `suppressions` table (§3); all GC'd by one rule (expired, or
  target slot no longer active/upcoming) in one place.
- The PWA "standdown session" button, the handoff flap guard, and join backoff
  become three writers of one concept. Status exposes `suppressions: [...]`
  uniformly; ack emails map 1:1 from writers (unchanged content).
- Expiry policies live next to the type (per-kind `isExpired(s, world)`), not
  scattered across tick + boot + applyOverride.

### 1.4 The decider (presence/decider.ts) — replaces stateMachine.ts

Pure function, exhaustively unit-tested:

```ts
type World = {
  nowMs: number;
  activeSlot: Slot | null; upcomingSlot: Slot | null;
  occupancy: Occupancy | null;
  heartbeat: { ageSeconds: number | null; fresh: boolean; missing: boolean };
  suppressions: Suppression[];
  duplicateConfirmed: boolean;
  roomWatch: WatchVerdict;            // "ok" | "empty-confirmed" | "scrape-dead"
  force: { join: boolean; leave: boolean };
  newSlotStarted: boolean;            // computed here, from slot ids
};

type Decision =
  | { kind: "none"; reason: string }
  | { kind: "join"; slot: Slot; reason: string; email: "cover_start" | "cover_resume" | "none" }
  | { kind: "leave"; reason: string; email: "handoff" | "none" }
  | { kind: "sweep"; origin: Slot; reason: "empty" | "scrape-dead" | "retry-timer" }
  | { kind: "adopt-end"; reason: string }
  | { kind: "rejoin-dead-room"; slot: Slot };
```

Rule order (mirrors today's precedence, now legible):

1. `force.leave` or `standdown` active and occupied → **leave**.
2. `duplicateConfirmed` → **leave** + add `handoff_grace` suppression (the
   handoff grace *write* moves here from the leave handler).
3. Occupied, adopted, and origin slot no longer active → **adopt-end** then
   re-decide (today's guard (a)).
4. Occupied and room watch says empty/scrape-dead (post grace+confirm) →
   **sweep** (respecting per-slot cap and retry timer, which the sweeper owns).
5. Occupied, scheduled slot ended (non-adopted) → **leave** ("Slot ended").
6. Occupied but a *different* scheduled slot is now active → **leave** so the
   next decision joins the right room (today this falls out of
   `!hasActiveSlot`/slot-key comparisons; making it explicit kills
   `newSlotStarted`/`effectiveHeartbeatFresh` special-casing — see rule 8).
7. Vacant, `force.join` → **join** active/upcoming slot, ignoring suppressions.
8. Vacant, active slot exists, slot not suppressed, no backoff/grace, and
   (heartbeat missing **or** this active slot is not the one we last saw —
   the "new slot started" rule, stated once with its rationale) → **join**.
9. Otherwise **none**, with the exact hold-off reason strings the PWA shows
   today ("Heartbeat still fresh; holding off", "Session stood down", ...).

Every branch carries its reason string and email intent, so `reason` is no
longer assigned in four places and emails fire from decisions, not from inside
join/leave implementations.

Async reality (joins take ~2 min, sweeps ~5 min) is handled by `jobs.ts`: one
action in flight; long jobs get a `shouldAbort()` callback (standdown /
force-leave / slot-change) polled between steps and a liveness pulse (generic,
replacing the sweep-specific `lastTickMs` poke). After any action completes or
aborts, the engine immediately re-senses and re-decides — same recovery
semantics as today, one mechanism.

### 1.5 Room watch as an explicit FSM (presence/roomWatch.ts)

```ts
type WatchState =
  | { phase: "settling"; enteredAtMs: number }      // grace window
  | { phase: "ok" }
  | { phase: "below"; sinceMs: number }             // counting toward confirm
  | { phase: "scrape-dead"; streak: number };
```

`reduce(state, snapshot, nowMs, config) → { state, verdict }` where
`verdict ∈ "none" | "empty-confirmed" | "scrape-dead"`. Pure, table-tested
(including the incident regression: broken scrape must never read as empty).
All four timing constants live in `WorkerConfig.roomWatch`.

### 1.6 Sweeper (presence/sweeper.ts)

A `SweepJob` class driven by the job runner: build candidate list → per room:
abort-check → resolve → join → settle → double-scrape → verdict → keep-or-leave
→ adopt or continue → fallback rejoin + retry timer. Emits the same history
events as today (`room_sweep_start/probe/adopted/exhausted/...`). Owns the
per-slot cap and retry timer as explicit job state (persisted per origin slot
id, so a restart mid-slot doesn't reset the cap to 0).

### 1.7 Overrides (schedule/overrides.ts)

- One pure entry point: `buildOps(input) → { ops, summary } | { error }` (the
  validation currently inline in `engine.addDayOverride`), reused by both APIs.
- `mergeForDate(config, dbRows, dateKey)` (today's `opsForDate`) lives here.
- Engine keeps only `addDayOverride/deleteDayOverride` orchestration: persist →
  event → ack email via facade → emit status.
- Keep the ops model (cancel/swap/add matches announcement language — that part
  was right) and keep gist+DB precedence. Reject past dates at write time
  (today's GC already assumes only-future matters).

### 1.8 Notifications

Keep `NotificationCenter` (outbox/dedupe/budgets are good). Add `notify.ts`:

```ts
notify.coverStart(slot, joinUrl); notify.handoff(slot); notify.actionNeeded(...);
notify.standdown(active); notify.sessionStanddown(slot, cancelled);
notify.dayOverride(date, summary, issues, todaySlots); ...
```

Engine modules call typed methods; the stringly-typed `enqueue({kind, payload})`
with inline payloads disappears from business logic. `notifications.ts`
rendering/budget/supersede logic unchanged.

### 1.9 Status reshape (breaking, we own all clients)

```ts
type StatusResponse = {
  state: "vacant" | "entering" | "occupied" | "exiting";
  reason: string; updatedAt: string;
  heartbeat: { ageSeconds: number | null; fresh: boolean };
  schedule: {
    source: ScheduleSource; loadedAt: string; url: string | null;
    activeSlot: SlotView | null; upcomingSlot: SlotView | null;
    todaySlots: SlotView[]; todayOverrides: AppliedDayOverride[];
  };
  occupancy: { room: RoomRef; via; originClassName: string | null; enteredAt: string } | null;
  suppressions: { kind: string; label: string; untilMs?: number }[];  // UI-ready labels
  room: {
    participantCount: number; scrapeOk: boolean; duplicateStreak: number;
    watch: { enabled; minParticipants; belowThresholdSince; phase } | null;
    sweep: { active: boolean; sweepsThisSlot; maxPerSlot; nextRetryAt; lastProbed } | null;
  };
  email: EmailBudgetSnapshot;
};
```

`SlotView` carries preformatted `start: "HH:MM"` / `end: "HH:MM"` (IST) plus
epoch ms — frontends stop slicing ISO strings. The three pages (index, today,
participant-stats) get updated to the grouped shape; pills map 1:1.

### 1.10 Config (worker/config.ts)

Every `envNumber/envBoolean` knob (tick, watch, sweep, sampling, handoff grace,
backoff) parsed once into a typed `WorkerConfig` and injected into the engine.
Modules receive slices. Kills class-load-time `process.env` reads and makes
decider/watch tests trivial.

## 2. stateMachine.ts fate

Deleted. Its tests (`stateMachine.test.ts`, 219 lines) are ported to decider
tests almost mechanically — the signal tuples become `World` fixtures. This is
the behavior-preservation safety net.

## 3. Database redesign (migration v7)

Append-only, one migration, with a migration test that boots a v6 fixture DB.

```sql
-- Generic durable KV: kills the migration-per-knob pattern.
CREATE TABLE control_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- seed from worker_state: standdown, lastActiveSlotKey, join failure streak…

-- Unified join gates.
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- standdown | session | handoff_grace | join_backoff
  slot_id TEXT,
  until_ms INTEGER,
  created_ms INTEGER NOT NULL,
  meta_json TEXT
);

-- First-class sessions: fixes adopted-room slotKey hacks and gives the stats
-- page clean grouping.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id TEXT,                  -- scheduled slot covered (null for force-joins)
  room_course_id TEXT NOT NULL,
  room_class_name TEXT,
  via TEXT NOT NULL,             -- schedule | sweep-adopt | force
  origin_slot_id TEXT,
  entered_ms INTEGER NOT NULL,
  left_ms INTEGER,
  exit_reason TEXT
);
CREATE INDEX idx_sessions_entered ON sessions (entered_ms);

ALTER TABLE participant_samples ADD COLUMN session_id INTEGER
  REFERENCES sessions(id);
CREATE INDEX idx_samples_session ON participant_samples (session_id);
```

Transform steps inside v7: read `worker_state` → insert `control_state` rows +
`suppressions` rows (standdown, session standdown if still relevant, grace,
backoff); create a `sessions` row for any `current_room_json` marker (it then
triggers the usual recovered-after-restart path); `DROP TABLE worker_state`.
`events`, `email_*`, `day_overrides`, `heartbeats` untouched.

Optional v7 follow-up (not required): backfill `participant_samples.session_id`
by time-window join; fine to leave NULL for history.

## 4. Participant stats charting library

Replace the hand-rolled SVG with **uPlot**, vendored (no CDN, no build step):

- `web/vendor/uplot.iife.min.js` (~45 KB) + `web/vendor/uplot.min.css` (~2 KB),
  registered in `publicFiles`. Works offline, CSP stays default-src 'self'.
- Why uPlot: purpose-built for time series, native step-line support
  (`paths: uPlot.paths.stepped`), trivial second series for the threshold line
  (dashed via `dash`), point emphasis for below-threshold/adopted samples,
  built-in cursor/tooltip/legend, tiny. Chart.js is 4× the size for features we
  don't need; ECharts is absurd here.
- `participant-stats.js` chart section shrinks from ~200 lines to ~60: map
  samples → `[ts[], count[]]` (+ a flat threshold series), gap-breaking via
  null insertion (uPlot-native), adopted segments as series-point styling.
  Session cards and raw table stay untouched.

## 5. Phase plan (each independently deployable)

**Phase 0 — Safety net (½ day).** Port stateMachine tests to decider-shaped
fixtures against *current* behavior; add engine-level scenario tests for the
sweep/adopt/handoff flows using a fake BbbSession. Goal: characterize today's
behavior before touching it.

**Phase 1 — Pure extractions, zero behavior change (1 day).** `worker/config.ts`,
`schedule/overrides.ts`, `presence/slots.ts`, `presence/suppressions.ts`
(storage still old tables; module is a façade), `presence/roomWatch.ts`,
`notify.ts` façade. Engine delegates; all existing tests still green.

**Phase 2 — Occupancy + decider (1–2 days, the big one).** Introduce
`OccupancyTracker`, `jobs.ts`, `decider.ts`; rewrite `tick()` as sense → decide
→ act; delete `stateMachine.ts`, the pending-flag fields, and the
`currentRoomSlot/activeSlot` duality; sweeper becomes a job. Golden tests from
Phase 0 must pass unchanged.

**Phase 3 — Schema v7 (½ day).** Migration + persistence reorganization +
migration test with a v6 fixture. Engine switches to `control_state` +
`suppressions` + `sessions`; samples gain `session_id`.

**Phase 4 — Status reshape + frontends (½–1 day).** Grouped `StatusResponse`;
update `web/app.js`, `web/today.js`, `web/participant-stats.js`. Public API
unchanged structurally (same paths).

**Phase 5 — uPlot (½ day).** Vendor assets, rewrite chart section, delete the
SVG code.

**Phase 6 — Docs + dead-code sweep (½ day).** Rewrite the architecture sections
of context.md (reconciler model, suppressions, sessions, new status shape);
delete dead fields/helpers; final grep for `sessionKey(` outside slots.ts.

Total ≈ 4–5 focused days, shippable after every phase.

## 6. Explicitly not changing

- NotificationCenter internals (outbox/coalesce/budget/supersede) — it's the
  healthiest module.
- `bbbSession.ts`, `resolveJoinUrl.ts`, `scheduleSource.ts`, `heartbeat.ts`,
  public API auth (`src/api/index.ts` structure), Docker deployment, PWA shell
  pattern, debugging artifacts (`.runtime/`), IST handling, email content/tiers.
- User-visible behavior: same join/leave/handoff/sweep/standdown semantics,
  same event kinds (new ones only where strictly additive), same email texts.
  The frontend changes are field-path updates, not UX redesign.

## 7. Risks

- **Behavior drift in Phase 2** → mitigated by Phase 0 golden tests + DRY_RUN
  smoke of every scenario (join, handoff, standdowns, sweep-adopt, fallback).
- **v7 migration bug losing standdown state** → migration test + automatic
  pre-migration DB backup file (`admiral.db.bak-v6`).
- **Timeline vs the trip** → phases land independently; if time runs out after
  Phase 1/3 the system is still strictly cleaner and fully working. Do not
  start Phase 2 within 48h of departure without a rollback point (git tag).



