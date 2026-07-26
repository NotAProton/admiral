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

export type OverrideAction = "force_join" | "force_leave" | "standdown_on" | "standdown_off";

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
  startedAt: string;
  endsAt: string;
};

export type StatusResponse = {
  state: AdmiralState;
  standdown: boolean;
  reason: string;
  activeSlot: ActiveSlot | null;
  participantCount: number;
  participantNames: string[];
  duplicateConfirmed: boolean;
  duplicateStreak: number;
  lastHeartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  updatedAt: string;
  bbbJoinUrl: string | null;
};
