export type DayName = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export type WeeklySlot = {
  days: DayName[];
  start: string;
  end: string;
};

export type CourseConfig = {
  courseId: string;
  className: string;
  classPageUrl: string;
  joinLinkText: string;
  myDisplayName: string;
  weeklySlots: WeeklySlot[];
};

export type DayOverrideSwap = {
  a: string;
  b: string;
};

export type DayOverrideAdd = {
  courseId: string;
  start: string;
  end: string;
};

/** Ops phrased like class announcements, applied to one IST date. */
export type DayOverrideOps = {
  cancel?: string[];
  swap?: DayOverrideSwap[];
  add?: DayOverrideAdd[];
};

/** As stored in schedule JSON (gist) — ops plus the date they apply to. */
export type DayOverride = DayOverrideOps & {
  date: string;
};

/** One row of the day_overrides table (API/PWA-applied overrides). */
export type AppliedDayOverride = {
  id: number;
  date: string;
  ops: DayOverrideOps;
  createdMs: number;
  createdIso: string;
  source: string;
};

export type AdmiralConfig = {
  timezone: string;
  heartbeat: {
    intervalSeconds: number;
    freshThresholdSeconds: number;
    missingThresholdSeconds: number;
  };
  duplicateDetection: {
    confirmConsecutiveScrapes: number;
    scrapeIntervalSeconds: number;
  };
  courses: CourseConfig[];
  overrides?: DayOverride[];
};

export type AdmiralState = "Out" | "Joining" | "InRoom" | "Leaving";

export type OverrideAction =
  | "force_join"
  | "force_leave"
  | "standdown_on"
  | "standdown_off"
  | "standdown_session"
  | "standdown_session_cancel";

export type SessionStanddown = {
  courseId: string;
  className: string;
  startedAt: string;
} | null;

export type HeartbeatPayload = {
  device_id: string;
};

export type ParticipantSnapshot = {
  count: number;
  names: string[];
  nameExactMatchCount: number;
  /**
   * False when the scrape itself failed (page gone / evaluate threw). A zero
   * count with scrapeOk=false means "unknown", never "empty room" — the
   * 2026-07-30 incident showed a silent zero is indistinguishable from a
   * broken scrape without this flag.
   */
  scrapeOk: boolean;
};

/** One row of the participant-count time series (participant_samples table). */
export type ParticipantSample = {
  id: number;
  tsMs: number;
  tsIso: string;
  slotKey: string | null;
  courseId: string;
  className: string | null;
  participantCount: number;
  /** True when sampled in a room Admiral adopted via an empty-room sweep. */
  adopted: boolean;
};

export type CurrentRoomInfo = {
  courseId: string;
  className: string;
  /** True when Admiral moved here via an empty-room sweep instead of the schedule. */
  adopted: boolean;
  adoptedFromClassName: string | null;
  enteredAt: string | null;
};

export type RoomWatchInfo = {
  enabled: boolean;
  /** Below this headcount (including Admiral itself) a room counts as empty. */
  minParticipants: number;
  scrapeOk: boolean;
  belowThresholdSince: string | null;
  sweepsThisSlot: number;
  maxSweepsPerSlot: number;
  nextSweepRetryAt: string | null;
};

export type ActiveSlot = {
  courseId: string;
  className: string;
  classPageUrl: string;
  joinLinkText: string;
  myDisplayName: string;
  /** IST wall clock with explicit offset, e.g. "2026-07-29T09:00:00+05:30" — safe for `new Date()` on any host timezone. */
  startedAt: string;
  /** IST wall clock with explicit offset, e.g. "2026-07-29T10:00:00+05:30". */
  endsAt: string;
};

export type HistoryEvent = {
  id: number;
  tsMs: number;
  tsIso: string;
  kind: string;
  slotKey: string | null;
  courseId: string | null;
  className: string | null;
  payload: Record<string, unknown> | null;
};

export type EmailBudgetSnapshot = {
  emailsToday: number;
  emailDailyCap: number;
  suppressedToday: number;
};

export type ScheduleSource = "env" | "file" | "url" | "cache";

/** Legacy flat status — kept for backward compat. Engine now returns V2. */
export type StatusResponse = StatusResponseV2;

/**
 * v2 grouped StatusResponse — replaces the 25-field flat grab-bag.
 * Same data, organized into logical groups. Public API serves this shape;
 * engine.getStatus() is the single source of truth.
 */
export type StatusResponseV2 = {
  /** IST wall-clock time with offset. */
  currentTime: string;
  /** UTC when this status was assembled. */
  updatedAt: string;

  control: {
    state: AdmiralState;
    reason: string;
  };

  schedule: {
    config: AdmiralConfig;
    source: ScheduleSource;
    loadedAt: string;
    url: string | null;
    activeSlot: ActiveSlot | null;
    upcomingSlot: ActiveSlot | null;
    /** Today's slots after override application (sorted). */
    todaySlots: ActiveSlot[];
    /** Today's persisted overrides. */
    todayOverrides: AppliedDayOverride[];
  };

  presence: {
    currentRoom: CurrentRoomInfo | null;
    participantCount: number;
    participantNames: string[];
    duplicateConfirmed: boolean;
    duplicateStreak: number;
    bbbJoinUrl: string | null;
  };

  watch: RoomWatchInfo;

  suppressions: {
    globalStanddown: boolean;
    sessionStanddown: SessionStanddown;
    joinBackoffActive: boolean;
    joinBackoffRemainingSeconds: number | null;
  };

  heartbeat: {
    fresh: boolean;
    lastAgeSeconds: number | null;
  };

  email: EmailBudgetSnapshot | null;
};
