/** Injectable clock so tests are deterministic and time zones are explicit. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string | Date): Clock & { set(iso: string | Date): void; advanceMs(ms: number): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    set(next) {
      current = new Date(next);
    },
    advanceMs(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}
