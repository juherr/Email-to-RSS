/**
 * A source of "now", injected into the domain so aggregates never reach for
 * ambient `Date.now()`. Production wires `systemClock`; tests can supply a fixed
 * clock for deterministic expiry/timestamp assertions.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
