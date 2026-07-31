# Plan: Date-scoped schedule overrides ("Today editor") + passive meeting sensor

> Implementation brief for a coding model. Self-contained: all codebase facts,
> schemas, signatures, and conventions below were verified against the repo.
> Where this file conflicts with your assumptions, trust this file — but still
> re-read each target file before editing it.

## 1. Background & goal

Incident context (`context.md`, 2026-07-30): a timetable change left Admiral
sitting in empty rooms all day because the schedule was baked into an env var.
Fixed since: `SCHEDULE_URL` hot-reload + empty-room detection + room sweeps.
Remaining pain: **same-day ad-hoc announcements** ("first and second hours
swapped today", "no 3rd hour"). The user may be on a train with flaky signal;
editing JSON in a gist from a phone is the current workaround.

Two phases:

- **Phase 1 (implement now):** date-scoped schedule overrides — one-shot ops
  (`cancel` / `swap` / `add`) phrased like the announcements, applied to a
  single IST date, settable via (a) optional `overrides` in the schedule
  JSON/gist (hot-reloads like everything else) and (b) a one-tap "Today"
  panel in the PWA that persists to SQLite and survives restarts.
- **Phase 2 (PoC-gated, later):** passive meeting-state sensor — scrape each
  course's Moodle BBB activity page for "session in progress" *without
  joining the room*, so sweeps probe invisibly and "hours swapped" is
  detected automatically. See §10. Do NOT build Phase 2 in the same PR.

Explicit non-goals: no announcement ingestion (WhatsApp/Telegram/email), no
delegate access, no changes to the weekly schedule mechanism, no new states
in the state machine, no new env vars in Phase 1.

## 2. Verified codebase facts (do not skip)

- **Config schema** (`src/shared/config.ts`): top level is
  `{ timezone, heartbeat{...}, duplicateDetection{...}, courses[] }`.
  Each course: `{ courseId, className, classPageUrl, joinLinkText,
  myDisplayName, weeklySlots: [{ days: DayName[], start, end }] }`.
  Times validated by `hhmmSchema = /^([01]\d|2[0-3]):[0-5]\d$/`.
  `parseSchedule(raw)` returns `{ ok, config|error }` and never throws.
- **`ActiveSlot`** (`src/shared/types.ts`): `{ courseId, className,
  classPageUrl, joinLinkText, myDisplayName, startedAt, endsAt }` where
  startedAt/endsAt are ISO strings with explicit offset
  (`2026-07-29T09:00:00+05:30`). Session keys are
  `` `${slot.courseId}@${slot.startedAt}` `` everywhere (dedupe, events,
  samples) — note a `swap` therefore produces *new* session keys, which is
  correct (a swapped slot is a new session).
- **Schedule getters** (`src/worker/schedule.ts`): `getActiveSlot(config)`,
  `getUpcomingSlot(config)`, `getMostRecentEndedSlot(config)`,
  `getCurrentIstDay()`, `getCurrentIstIso()`. Helpers already present:
  `istIso(datePrefix, hhmm)`, `hhmmToMinutes`, `formatPartsInIst(date)`,
  `nowInIst()` (returns `{ day, minutes, iso }`), `dayOrder`. Only caller of
  the three getters is `src/worker/engine.ts` (import at line ~21; `tick()`
  at ~line 418 sets `this.activeSlot` / `this.upcomingSlot`;
  `getMostRecentEndedSlot` is used for missed-summary recovery).
  `getCurrentIstDay` is also used by `sweepCandidates()` — keep its
  signature unchanged.
- **Engine** (`src/worker/engine.ts`): `private config!: AdmiralConfig`;
  hot-reload via `applyScheduleResult(result)` which recomputes slots and
  emits status; `persistence.appendEvent({ kind, slot?, payload? })`;
  `this.center.enqueue({ kind, slot?, payload? })` for emails;
  `getStatus()` builds `StatusResponse`, `emitStatus()` pushes SSE.
  Status is recomputed per emit — cheap pure helpers are fine to call there.
- **Persistence** (`src/worker/persistence.ts`): class `WorkerPersistence`
  wrapping `DatabaseSync`; write methods follow the
  `insertParticipantSample` pattern (write + inline retention prune). Row
  types are `type XRow = {...}` with snake_case columns mapped to camelCase.
- **DB migrations** (`src/shared/db.ts`): append-only `MIGRATIONS` array,
  `PRAGMA user_version` tracked. Current latest = **version 5**
  (`participant_samples`). `persistence.test.ts` asserts
  `user_version === 5` in the reopen test — **bump it to 6**.
- **Notifications** (`src/worker/notifications.ts`): `NotificationKind`
  string union (~line 30). `specForKind()` maps kind → `{ priority,
  settleMs, dedupeKey, supersedeKind? }`; `renderOne()` switch maps kind →
  renderer. Latest-wins ack pattern to copy: `standdown` uses
  `{ priority: 2, settleMs: caps.ackSettleMs, dedupeKey: null,
  supersedeKind: "standdown" }`. IST helpers live in
  `src/shared/istTime.ts` (`istDateKey`, `istParts`, `shortIstTime`, …).

- **Internal API** (`src/worker/internalApi.ts`): Fastify on 127.0.0.1,
  zod-parsed bodies, thin handlers delegating to `engine.*`.
- **Public API** (`src/api/index.ts`): `mutatingPaths` Set (origin/referer
  check), auth via `onRequest` hook (401 for anything not in `publicFiles` /
  `/login` / `/health` / `/logout`), proxies are
  `fetch(http://127.0.0.1:${internalPort}/internal/...)` with 5s timeout,
  502 on failure.
- **PWA** (`web/index.html`, `web/app.js`): vanilla JS, no deps.
  `request(path, options)` helper handles 401/errors; `showError(msg)`;
  `setButtonBusy(btn, busy)`; `renderStatus()` renders from module-level
  `lastStatus` (updated by `/status` fetch + SSE); destructive buttons use
  `confirm()` dialogs; panels are `<div class="panel">` with
  `.panel-title`. Palette: white/black/accent `#1c1c84`, sharp corners
  enforced globally (`border-radius: 0 !important`).
- **Tests**: `node:test` + `assert/strict`, run via `npm run test:unit`
  (tsx). DB tests use `openDatabase(":memory:")`. No `schedule.test.ts`
  exists yet — create it. `npm run typecheck` = `tsc --noEmit`.
- **Conventions**: ESM imports with `.js` suffix, 2-space indent, double
  quotes, zod for all external input, no new npm dependencies.

## 3. Data model (Phase 1)

### 3.1 `src/shared/types.ts`

Add:

```ts
export type DayOverrideSwap = { a: string; b: string };          // "HH:MM"
export type DayOverrideAdd = { courseId: string; start: string; end: string };

/** Ops phrased like class announcements, applied to one IST date. */
export type DayOverrideOps = {
  cancel?: string[];          // courseIds — remove that course's slots
  swap?: DayOverrideSwap[];   // swap time windows of slots starting at a and b
  add?: DayOverrideAdd[];     // extra slot for a configured course
};

/** As stored in schedule JSON (gist) — ops plus the date they apply to. */
export type DayOverride = DayOverrideOps & { date: string };     // "YYYY-MM-DD"

/** One row of the day_overrides table (API/PWA-applied overrides). */
export type AppliedDayOverride = {
  id: number;
  date: string;
  ops: DayOverrideOps;
  createdMs: number;
  createdIso: string;
  source: string;             // "pwa"
};
```

Extend `AdmiralConfig` with `overrides?: DayOverride[];` and
`StatusResponse` with:

```ts
todaySlots: ActiveSlot[];          // materialized, override-applied, sorted
todayOverrides: AppliedDayOverride[];  // API-applied rows for today (IST)
```

### 3.2 `src/shared/config.ts`

Add schemas (reuse `hhmmSchema`) and include in `configSchema`:

```ts
const dayOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cancel: z.array(z.string().min(1)).optional(),
  swap: z.array(z.object({ a: hhmmSchema, b: hhmmSchema })).optional(),
  add: z.array(z.object({ courseId: z.string().min(1), start: hhmmSchema, end: hhmmSchema })).optional()
});
// configSchema:  overrides: z.array(dayOverrideSchema).optional()
```

`AdmiralConfig` picks it up via the inferred type — but the repo declares
`AdmiralConfig` manually in types.ts, so keep both in sync manually.

## 4. Schedule materialization (`src/worker/schedule.ts`)

Core idea: all slot queries go through one pure function that materializes a
single IST date's slot instances and applies that date's ops.

```ts
export type OpsForDate = (dateKey: string) => DayOverrideOps[];
export type DayOverrideIssue = { op: "cancel" | "swap" | "add"; detail: string };

export function getDaySlots(
  config: AdmiralConfig,
  dateKey: string,                 // "YYYY-MM-DD" (IST)
  opsList: DayOverrideOps[] = []
): { slots: ActiveSlot[]; issues: DayOverrideIssue[] };
```

Implementation notes:

- Weekday for `dateKey`: `new Date(\`${dateKey}T12:00:00+05:30\`)` then read
  the short weekday via the existing `formatPartsInIst` (noon IST avoids
  every date-boundary hazard). Map through the existing `dayMap`.
- Base slots: for each course, for each `weeklySlots` entry whose `days`
  includes the weekday, build an `ActiveSlot` with `istIso(dateKey, ws.start)`
  / `istIso(dateKey, ws.end)` and the course's
  `classPageUrl/joinLinkText/myDisplayName/className`.
- Apply ops **in order: cancel → swap → add**, per ops object, in list order:
  - `cancel`: remove slots whose `courseId` matches. No match → issue.
  - `swap {a,b}`: find slots with `startedAt.slice(11, 16) === a` (and `b`);
    swap their `startedAt`/`endsAt` (courses stay put — times move).
    Either missing → issue, no-op.
  - `add`: look up course by `courseId` (unknown → issue), push a new slot.
- Sort by `Date.parse(startedAt)` ascending before returning.

Then refactor the three getters to thin wrappers (keep existing exported
names; add an optional second param — no other callers change):

```ts
export function getActiveSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null;
export function getUpcomingSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null;
export function getMostRecentEndedSlot(config: AdmiralConfig, opsForDate?: OpsForDate): ActiveSlot | null;
```

- `getActiveSlot`: materialize today (`nowInIst().iso.slice(0, 10)`), pick
  slots with `start <= now < end`; if several overlap, **latest start wins**.
- `getUpcomingSlot`: materialize today through +6 days (7 dates, each with
  `opsForDate?.(dateKey) ?? []`), return the first slot with `start > now`.
  This replaces the existing weekly-scan logic entirely and is simpler +
  override-aware for the whole week.
- `getMostRecentEndedSlot`: materialize today + yesterday, pick the slot
  with the greatest `endsAt` that is `<= now` and within 6 h — same
  semantics as now.
- Keep `getCurrentIstDay` / `getCurrentIstIso` as-is. `hhmmToMinutes`,
  `dayOrder`, `maybeActiveCourse` may become dead — remove if unreferenced
  (typecheck will not flag unused private fns; check manually).

## 5. Storage (migration v6 + persistence)

### 5.1 `src/shared/db.ts` — append migration

```sql
-- version: 6
-- PWA/API-applied same-day schedule overrides. Survive restarts, garbage
-- collected once their IST date has passed.
CREATE TABLE day_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'pwa'
);
CREATE INDEX idx_day_overrides_date ON day_overrides (date);
```

### 5.2 `src/worker/persistence.ts` — new section

```ts
addDayOverride(input: { date: string; ops: DayOverrideOps; source?: string; createdMs?: number }): number
listDayOverrides(date: string): AppliedDayOverride[]     // ordered by id ASC
deleteDayOverride(id: number): boolean                   // changes() > 0
```

- `addDayOverride` returns `lastInsertRowid` (Number()) and then GCs:
  `DELETE FROM day_overrides WHERE date < ?` with `istDateKey(Date.now())`
  (import from `../shared/istTime.js`) — mirrors the inline-prune pattern.
- `ops_json` is `JSON.stringify(ops)`; parse defensively (`try/catch → {}`)
  like `parseSlotJson` does.

## 6. Engine (`src/worker/engine.ts`)

1. **Ops provider** — new private method:

   ```ts
   private opsForDate(dateKey: string): DayOverrideOps[] {
     const fromSchedule = (this.config.overrides ?? [])
       .filter((o) => o.date === dateKey)
       .map(({ date: _date, ...ops }) => ops);
     const fromDb = this.persistence.listDayOverrides(dateKey).map((r) => r.ops);
     return [...fromSchedule, ...fromDb];
   }
   ```

2. **Wire the getters**: in `tick()` and `applyScheduleResult()` pass the
   provider: `getActiveSlot(this.config, (d) => this.opsForDate(d))`, same
   for `getUpcomingSlot` and `getMostRecentEndedSlot`.
   After a schedule hot-reload, also log issues once:
   `getDaySlots(config, todayKey, opsForDate(todayKey)).issues` → one
   `override_unmatched` history event per issue (do this in
   `applyScheduleResult`, NOT per tick — avoids event spam).

3. **Public methods for the internal API:**

   ```ts
   listDayOverrides(date?: string): AppliedDayOverride[];  // default: today IST
   addDayOverride(input: {
     date?: string;                                        // default: today IST
     op: "cancel" | "swap" | "add";
     courseId?: string; a?: string; b?: string; start?: string; end?: string;
   }): { ok: true; id: number; issues: DayOverrideIssue[] } | { ok: false; error: string };
   deleteDayOverride(id: number): boolean;
   ```

   `addDayOverride` behaviour:
   - Validate: date format; `cancel`/`add` need a `courseId` present in
     `config.courses`; `swap` needs `a`/`b` (HH:MM); `add` needs
     `start`/`end` with `start < end`. Invalid → `{ ok: false, error }`
     (internal API maps this to HTTP 400).
   - Build ops (`{ cancel: [courseId] }` / `{ swap: [{ a, b }] }` /
     `{ add: [{ courseId, start, end }] }`), `persistence.addDayOverride`.
   - Compute `issues` by materializing that date with the new ops included.
   - `appendEvent({ kind: "day_override_applied", payload: { date, op, ... , issues } })`.
   - Enqueue ack email (see §8): payload `{ date, summary, issues,
     todaySlots }` where `summary` is human lines ("Cancelled CBE411",
     "Swapped 10:00 ↔ 11:00") and `todaySlots` is included only when
     `date === istDateKey(Date.now())`.
   - `emitStatus()`.
   `deleteDayOverride`: delete; if found, event `day_override_removed` +
   same ack email shape + `emitStatus()`.

4. **Status** (`getStatus()`): add `todaySlots:
   getDaySlots(this.config, todayKey, this.opsForDate(todayKey)).slots` and
   `todayOverrides: this.persistence.listDayOverrides(todayKey)`.
   (`todayKey = istDateKey(Date.now())` — import from `../shared/istTime.js`.)

Edge cases to preserve: an override deleting/swapping the slot Admiral is
currently sitting in is handled by existing logic — `activeSlot` changes →
`!hasActiveSlot`/slot-change paths leave/join automatically; adoption
(`adoptedFromSlotKey`) ends when `activeSlot` no longer matches. No extra
work needed, but smoke-test a cancel-during-cover.

## 7. API routes

### 7.1 `src/worker/internalApi.ts`

```ts
const dayOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  op: z.enum(["cancel", "swap", "add"]),
  courseId: z.string().min(1).optional(),
  a: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  b: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
});
```

- `GET /internal/day-overrides?date=YYYY-MM-DD` →
  `{ overrides: engine.listDayOverrides(date) }`.
- `POST /internal/day-override` → parse body; `engine.addDayOverride(...)`;
  `{ ok: false }` → `reply.code(400)`, else `{ ok: true, id, issues }`.
- `POST /internal/day-override-delete` body `{ id: z.number().int().positive() }`
  → `{ ok: engine.deleteDayOverride(id) }` (404 when false).

### 7.2 `src/api/index.ts`

- `mutatingPaths` += `"/day-override"`, `"/day-override-delete"`.
- `GET /day-overrides` — query-passthrough proxy (same pattern as
  `/participant-samples`).
- `POST /day-override`, `POST /day-override-delete` — body-passthrough
  proxies (same pattern as `/override`).

## 8. Ack email (`src/worker/notifications.ts`)

- Add `"day_override"` to `NotificationKind`.
- `specForKind`: `case "day_override": return { priority: 2, settleMs:
  caps.ackSettleMs, dedupeKey: null, supersedeKind: "day_override" };`
  (latest-wins: rapid successive edits coalesce into one email.)
- `renderOne`: `case "day_override": return renderDayOverride(row.payload, nowMs);`
- New renderer near `renderSessionStanddown`:

  ```
  Subject: Schedule updated for <date>
  Lines:   one per summary entry ("Cancelled: CBE411 Mobile Forensics",
           "Swapped: 10:00 ↔ 11:00", "Added: CBS411 VAPT 14:00–15:00"),
           unmatched-op warnings if payload.issues non-empty,
           then "Today's classes now:" + "HH:MM–HH:MM  className" lines
           when payload.todaySlots is present,
           + "Undo or adjust: https://<ADMIRAL_DOMAIN>/"
  ```

## 9. PWA "Today" panel (`web/index.html`, `web/app.js`)

Insert a panel between the pills `.row` and the "Presence control" panel:

- Title: **Today** (existing `.panel` / `.panel-title` styles).
- Renders from `lastStatus.todaySlots` + `lastStatus.todayOverrides`
  (re-render inside `renderStatus()` — no new fetch needed).
- Per slot row: `10:00–11:00  CBE411 Mobile Forensics` + small buttons:
  - **Cancel** → `confirm("Cancel <class> today? Admiral will skip it.")` →
    `POST /day-override { op: "cancel", courseId }`.
  - **Swap** → arm-and-tap: first tap marks the slot (highlight + hint
    "Tap the slot to swap with"); tapping another slot completes
    `POST /day-override { op: "swap", a: startOfFirst, b: startOfSecond }`
    (`startedAt.slice(11, 16)`); tapping the armed slot again cancels arming.
- **Add class** row: course `<select>` (from `lastStatus.schedule.courses`),
  two `<input type="time">`, button → `{ op: "add", courseId, start, end }`.
- Applied-overrides list (from `todayOverrides`): human line + **Undo** →
  `POST /day-override-delete { id }` (with `confirm`).
- After every mutation: on HTTP 200 `await refreshStatus()`; show returned
  `issues` via `showError(issues.map(i => i.detail).join("; "))` when
  non-empty; on 4xx show the error body.
- A "Move class" op is intentionally omitted — it is Add + Cancel.
- `startedAt.slice(11, 16)` is already IST wall time — use it for display.

Also update `config/schedule.example.json` with an `"overrides"` array
containing one plausible `swap` and one `cancel` example dated far in the
past (inert), so the shape is documented.

## 10. Phase 2 (later, PoC-gated) — passive meeting sensor

Do not implement now; recorded so the next session can pick it up:

1. **PoC** `src/poc/probeMeetingState.ts`: headless Moodle login (reuse
   `resolveJoinUrl.ts` helpers), load one course's BBB activity page during
   a real live class, dump DOM/screenshots to `.runtime/`, verify selectors
   for "session in progress" / join button / participant count, and for
   moderator markers in the BBB user list. Engine wiring proceeds only on
   verified selectors.
2. **`meetingProbe` module**: per course → `{ live, participantCount|null,
   joinUrl|null }` without joining; ~5 min result cache.
3. **Engine integration** behind `MEETING_PROBE_ENABLED` (default false) +
   `MEETING_SCAN_SECONDS` (default 900): (a) sensor-guided sweep — probe
   candidates passively first, join only confirmed-live rooms, fail-open to
   today's join-probe behaviour on error; (b) background scan during class
   hours — non-active course live while scheduled room is below threshold →
   `room_swap_suspected` event + fast-track adoption + `action_needed`
   email.
4. **Moderator-aware occupancy**: "alive" = moderator present (strong) or
   headcount ≥ threshold (weak); adoption requires alive.

## 11. Tests & docs

- **New `src/worker/schedule.test.ts`** (node:test style): `getDaySlots`
  with a 3-course fixture covering: base materialization by weekday;
  `cancel` matched/unmatched; `swap` happy path (times exchange, courses
  stay) + unmatched side → issue + no-op; `add` known/unknown course;
  result sorted by start; multiple ops compose (cancel+add).
- **`persistence.test.ts`**: day-override round-trip (insert/list/delete),
  list-by-date isolation, GC of past dates on insert; bump the
  `user_version` assertion **5 → 6**.
- **`notifications.test.ts`**: two `day_override` enqueues leave only one
  pending row (supersede), matching the existing standdown-style test.
- **`context.md`**: new section documenting the overrides model (gist +
  PWA), precedence (gist ops first, then PWA ops in creation order), the
  endpoints, the Today panel, and the ack email.
- **`.env.example`**: no changes (no new env vars in Phase 1).

## 12. Validation (must all pass)

1. `npm run typecheck` — clean.
2. `npm run test:unit` — all green (existing + new).
3. DRY_RUN smoke: boot worker + API against a temp DB (`DRY_RUN=true`,
   disposable `DATABASE_PATH`), then with the session cookie:
   - `GET /day-overrides` → `{ "overrides": [] }`;
   - `POST /day-override {"op":"swap","a":"10:00","b":"11:00"}` → 200;
     `GET /status` shows `todaySlots` with exchanged times and
     `todayOverrides` length 1; history has `day_override_applied`;
   - `POST /day-override {"op":"cancel","courseId":"<id>"}` → 200; that
     course's slots vanish from `todaySlots`;
   - `POST /day-override-delete {"id":N}` → slots restored;
   - invalid body (bad op / unknown course) → 400; unauthenticated → 401.
4. Re-open the smoke DB file and confirm `PRAGMA user_version` = 6.
5. Eyeball `/` in a browser: Today panel renders, swap arm-and-tap works,
   undo works.

## 13. Deploy notes

- `docker compose up -d --build` (or recreate); DB auto-migrates to v6 in
  place — no data migration needed.
- Gist `overrides` are optional; PWA-applied ops live in SQLite and are
  GC'd after their date passes. If both exist for a date, gist ops apply
  first, then PWA ops in creation order.






