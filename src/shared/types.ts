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

export type StatusResponse = {
  state: AdmiralState;
  standdown: boolean;
  sessionStanddown: SessionStanddown;
  reason: string;
  activeSlot: ActiveSlot | null;
  upcomingSlot: ActiveSlot | null;
  currentIstTime: string;
  schedule: AdmiralConfig;
  participantCount: number;
  participantNames: string[];
  duplicateConfirmed: boolean;
  duplicateStreak: number;
  lastHeartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  updatedAt: string;
  bbbJoinUrl: string | null;
  joinBackoffActive: boolean;
  joinBackoffRemainingSeconds: number | null;
};
