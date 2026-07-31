/**
 * ── Job runner ─────────────────────────────────────────────────────────
 *
 * Ensures only one long-running action (join, leave, sweep) is in flight at
 * a time.  Provides:
 *   - in-flight guard (check before starting a new job)
 *   - abort callback for cancellable jobs (sweep)
 *   - liveness pulse for Docker autoheal during long probes
 */

export type Job = {
  id: string;
  startedAtMs: number;
  abortController: AbortController;
};

export class JobRunner {
  private current: Job | null = null;
  private lastLivenessPulseMs = 0;
  /** Called every pulseMs to signal "worker is alive" (Docker autoheal). */
  private livenessCallback: (() => void) | null = null;

  /** True when a job is currently running. */
  get inFlight(): boolean {
    return this.current != null;
  }

  /** The current job if one is running. */
  get currentJob(): Job | null {
    return this.current;
  }

  setLivenessCallback(fn: () => void): void {
    this.livenessCallback = fn;
  }

  /**
   * Start a new job.  Throws if a job is already in flight (caller must
   * check `inFlight` first).
   */
  start(id: string): Job {
    if (this.current) {
      throw new Error(
        `Cannot start job "${id}": "${this.current.id}" is in flight`
      );
    }
    const abortController = new AbortController();
    this.current = { id, startedAtMs: Date.now(), abortController };
    return this.current;
  }

  /** Finish (or cancel) the current job. */
  finish(): void {
    this.current = null;
  }

  /** Abort the current job if it supports cancellation. */
  abortCurrent(): void {
    this.current?.abortController.abort();
    this.current = null;
  }

  /** Get the abort signal for the current job (for passing to async ops). */
  get signal(): AbortSignal | undefined {
    return this.current?.abortController.signal;
  }

  /** Pulse liveness (call periodically during long jobs). */
  pulseLiveness(): void {
    this.lastLivenessPulseMs = Date.now();
    this.livenessCallback?.();
  }

  get lastPulseMs(): number {
    return this.lastLivenessPulseMs;
  }
}
