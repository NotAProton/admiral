/**
 * Re-export from presence/decider.ts for the engine.
 *
 * stateMachine.ts was deleted in Phase 2. Its tests are ported to
 * decider.test.ts using World fixtures. The decision logic is now
 * exposed as a pure decide(world) function.
 */
export { type AdmiralState, type World, decide } from "../presence/decider.js";

// Re-export TickSignals-compatible Decision type for the engine's
// remaining code that still uses the old shape.
export type { Decision } from "../presence/decider.js";

