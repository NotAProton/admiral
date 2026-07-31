import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRoomOccupancy,
  type RoomWatchConfig,
  type RoomWatchInput,
  type ParticipantScrape
} from "./roomWatch.js";

const cfg: RoomWatchConfig = {
  enabled: true,
  minParticipants: 3,
  graceMs: 300_000,
  confirmMs: 300_000,
  sweepRetryMs: 900_000,
  sweepMaxPerSlot: 6,
  scrapeFailLeaveThreshold: 3
};

function baseInput(overrides: Partial<RoomWatchInput> = {}): RoomWatchInput {
  return {
    config: cfg,
    inRoom: true,
    dryRun: false,
    nowMs: 1_000_000_000,
    roomEnteredAtMs: 1_000_000_000 - 400_000, // past grace
    belowThresholdSinceMs: null,
    scrapeFailStreak: 0,
    isAdopted: false,
    sweepsThisSlot: 0,
    nextSweepRetryAtMs: null,
    sweepHalted: false,
    ...overrides
  };
}

const okScrape: ParticipantScrape = { count: 5, scrapeOk: true };
const emptyScrape: ParticipantScrape = { count: 1, scrapeOk: true };
const failedScrape: ParticipantScrape = { count: 0, scrapeOk: false };

test("no sweep when headcount above threshold", () => {
  const d = evaluateRoomOccupancy(baseInput(), okScrape);
  assert.equal(d.doSweep, false);
  assert.equal(d.doScrapeDeadRejoin, false);
  assert.equal(d.belowThresholdSinceMs, null);
});

test("sets belowThresholdSinceMs on first below-threshold scrape", () => {
  const d = evaluateRoomOccupancy(baseInput(), emptyScrape);
  assert.equal(d.doSweep, false);
  assert.equal(d.belowThresholdSinceMs, 1_000_000_000);
});

test("triggers sweep after confirm window of below-threshold", () => {
  const d = evaluateRoomOccupancy(
    baseInput({
      belowThresholdSinceMs: 1_000_000_000 - 400_000
    }),
    emptyScrape
  );
  assert.equal(d.doSweep, true);
  assert.equal(d.belowThresholdSinceMs, null); // reset after trigger
});

test("does not sweep when sweep is halted", () => {
  const d = evaluateRoomOccupancy(
    baseInput({
      belowThresholdSinceMs: 1_000_000_000 - 400_000,
      sweepHalted: true
    }),
    emptyScrape
  );
  assert.equal(d.doSweep, false);
});

test("resets belowThreshold on above-threshold scrape", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ belowThresholdSinceMs: 1_000_000_000 - 400_000 }),
    okScrape
  );
  assert.equal(d.doSweep, false);
  assert.equal(d.belowThresholdSinceMs, null);
});

test("ignores empty scrapes during grace period", () => {
  const d = evaluateRoomOccupancy(
    baseInput({
      nowMs: 1_000_000_000,
      roomEnteredAtMs: 1_000_000_000 - 50_000 // 50s ago, still in 300s grace
    }),
    emptyScrape
  );
  assert.equal(d.doSweep, false);
  assert.equal(d.belowThresholdSinceMs, null); // grace period ignores
});

test("scrape fail streak triggers dead room after threshold", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ scrapeFailStreak: 2 }),
    failedScrape
  );
  assert.equal(d.doScrapeDeadRejoin, true);
  assert.equal(d.scrapeFailStreak, 0);
});

test("scrape fail streak incremented but not triggered below threshold", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ scrapeFailStreak: 1 }),
    failedScrape
  );
  assert.equal(d.doScrapeDeadRejoin, false);
  assert.equal(d.scrapeFailStreak, 2);
});

test("disabled config returns no-ops", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ config: { ...cfg, enabled: false } }),
    emptyScrape
  );
  assert.equal(d.doSweep, false);
  assert.equal(d.doScrapeDeadRejoin, false);
});

test("dry-run returns no-ops", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ dryRun: true }),
    emptyScrape
  );
  assert.equal(d.doSweep, false);
  assert.equal(d.doScrapeDeadRejoin, false);
});

test("not in room returns no-ops", () => {
  const d = evaluateRoomOccupancy(
    baseInput({ inRoom: false }),
    emptyScrape
  );
  assert.equal(d.doSweep, false);
  assert.equal(d.doScrapeDeadRejoin, false);
});
