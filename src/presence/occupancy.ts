import type { ActiveSlot } from "../shared/types.js";

/**
 * ── OccupancyTracker ──────────────────────────────────────────────────
 *
 * THE answer to "which room am I in?" — replaces the current
 * `currentRoomSlot ?? activeSlot` pattern with a single first-class type.
 *
 * An Occupancy is either:
 *   - "schedule"  — covering a slot per today's timetable
 *   - "sweep-adopt" — moved to a different room during an empty-room sweep
 *   - "force" — manual force-join
 *
 * The tracker owns `enter()`, `exit()`, and `current`; the engine no longer
 * has two competing "where am I" concepts (activeSlot vs currentRoomSlot).
 */

export type OccupancyVia = "schedule" | "sweep-adopt" | "force";

export type Occupancy = {
  courseId: string;
  className: string;
  classPageUrl: string;
  joinLinkText: string;
  myDisplayName: string;
  via: OccupancyVia;
  /** Epoch ms when we entered this room. */
  enteredAtMs: number;
  /** The scheduled slot being covered (null for force-joins). */
  slot: ActiveSlot | null;
  /** For sweep-adopt: the scheduled slot that triggered the sweep. */
  originSlotKey: string | null;
  /** The resolved BBB join URL for this room. */
  joinUrl: string | null;
  /** Where the slot startedAt string came from (IST offset or UTC for adopted). */
  startedAt: string;
};

export class OccupancyTracker {
  private currentOccupancy: Occupancy | null = null;

  /** Concrete room reference from the current occupancy for scraping. */
  get roomRef(): {
    courseId: string;
    className: string;
    myDisplayName: string;
  } | null {
    const occ = this.currentOccupancy;
    if (!occ) return null;
    return {
      courseId: occ.courseId,
      className: occ.className,
      myDisplayName: occ.myDisplayName
    };
  }

  get current(): Occupancy | null {
    return this.currentOccupancy;
  }

  get isOccupied(): boolean {
    return this.currentOccupancy != null;
  }

  get isAdopted(): boolean {
    return this.currentOccupancy?.via === "sweep-adopt";
  }

  get enteredAtMs(): number {
    return this.currentOccupancy?.enteredAtMs ?? 0;
  }

  get slotKey(): string | null {
    const occ = this.currentOccupancy;
    if (!occ) return null;
    return `${occ.courseId}@${occ.startedAt}`;
  }

  get originSlotKey(): string | null {
    return this.currentOccupancy?.originSlotKey ?? null;
  }

  enter(params: {
    via: OccupancyVia;
    slot: ActiveSlot | null;
    courseId: string;
    className: string;
    classPageUrl: string;
    joinLinkText: string;
    myDisplayName: string;
    joinUrl: string | null;
    originSlotKey?: string | null;
    enteredAtMs?: number;
  }): void {
    this.currentOccupancy = {
      courseId: params.courseId,
      className: params.className,
      classPageUrl: params.classPageUrl,
      joinLinkText: params.joinLinkText,
      myDisplayName: params.myDisplayName,
      via: params.via,
      slot: params.via === "schedule" || params.via === "sweep-adopt" ? params.slot : null,
      originSlotKey: params.via === "sweep-adopt" ? (params.originSlotKey ?? null) : null,
      joinUrl: params.joinUrl,
      enteredAtMs: params.enteredAtMs ?? Date.now(),
      startedAt: params.slot?.startedAt ?? new Date().toISOString()
    };
  }

  exit(): void {
    this.currentOccupancy = null;
  }

  /** True when this is a rejoin of the same room (after leave + rejoin flapping). */
  sameRoom(slot: ActiveSlot): boolean {
    if (!this.currentOccupancy) return false;
    return (
      this.currentOccupancy.courseId === slot.courseId &&
      this.currentOccupancy.startedAt === slot.startedAt
    );
  }
}
