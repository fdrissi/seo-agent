import { Cron } from 'croner';
import { dateInZone, zonedParts } from '../core/time.js';

/**
 * Daylight-saving analysis for schedules. Offsets are always read from the
 * IANA time zone database through Intl; no UTC offsets are hardcoded.
 *
 * A transition creates either a GAP (wall-clock times that do not exist, when
 * clocks move forward) or an OVERLAP (wall-clock times that occur twice, when
 * clocks move back). `dstNotesForCron` reports every scheduled wall time that
 * falls into a gap or overlap within the horizon and what the scheduler
 * (croner) actually does there, computed rather than assumed.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset in minutes of an instant in an IANA zone (e.g. +180 for GMT+03:00). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    offsetFormatters.set(timeZone, fmt);
  }
  const name = fmt.formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(name);
  if (!m) throw new RangeError(`Cannot read the UTC offset of ${timeZone} (${name})`);
  if (!m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

export interface ZoneTransition {
  /** First instant with the new offset. */
  at: string;
  kind: 'gap' | 'overlap';
  offsetBeforeMinutes: number;
  offsetAfterMinutes: number;
  /** Local calendar date of the affected wall-clock window. */
  localDate: string;
  /** Affected wall-clock window [start, end) as HH:MM. */
  wallStart: string;
  wallEnd: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Wall-clock fields encoded as a UTC timestamp (so pattern matching works on wall time). */
function wallAsUtc(instantMs: number, offsetMin: number): Date {
  return new Date(instantMs + offsetMin * MINUTE);
}

function hhmm(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Offset transitions of a zone between two instants (minute precision). */
export function findTransitions(timeZone: string, from: Date, to: Date): ZoneTransition[] {
  const out: ZoneTransition[] = [];
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE;
  let prev = zoneOffsetMinutes(new Date(t), timeZone);
  while (t < to.getTime()) {
    const next = Math.min(t + HOUR, to.getTime());
    const off = zoneOffsetMinutes(new Date(next), timeZone);
    if (off !== prev) {
      // Binary search the first minute with the new offset.
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.max(MINUTE, Math.floor((hi - lo) / 2 / MINUTE) * MINUTE);
        if (zoneOffsetMinutes(new Date(mid), timeZone) === prev) lo = mid;
        else hi = mid;
      }
      const at = hi;
      const kind = off > prev ? 'gap' : 'overlap';
      const start = kind === 'gap' ? wallAsUtc(at, prev) : wallAsUtc(at, off);
      const end = kind === 'gap' ? wallAsUtc(at, off) : wallAsUtc(at, prev);
      out.push({
        at: new Date(at).toISOString(),
        kind,
        offsetBeforeMinutes: prev,
        offsetAfterMinutes: off,
        localDate: start.toISOString().slice(0, 10),
        wallStart: hhmm(start),
        wallEnd: hhmm(end),
      });
      prev = off;
    }
    t = next;
  }
  return out;
}

export interface DstNote {
  kind: 'gap' | 'overlap';
  localDate: string;
  wallTime: string;
  transitionAt: string;
  /** Instants at which croner actually fires for this wall time on that date. */
  actualRuns: string[];
  message: string;
}

/**
 * Scheduled wall times of a 5-field cron that fall into DST gaps/overlaps in
 * the zone within `horizonDays` of `from`.
 */
export function dstNotesForCron(cron: string, timeZone: string, from: Date, horizonDays = 400): DstNote[] {
  const wallMatcher = new Cron(cron, { timezone: 'UTC', paused: true, mode: '5-part' });
  const zoned = new Cron(cron, { timezone: timeZone, paused: true, mode: '5-part' });
  const to = new Date(from.getTime() + horizonDays * 24 * HOUR);
  const notes: DstNote[] = [];
  for (const tr of findTransitions(timeZone, from, to)) {
    const at = Date.parse(tr.at);
    const startWall = tr.kind === 'gap' ? wallAsUtc(at, tr.offsetBeforeMinutes) : wallAsUtc(at, tr.offsetAfterMinutes);
    const endWall = tr.kind === 'gap' ? wallAsUtc(at, tr.offsetAfterMinutes) : wallAsUtc(at, tr.offsetBeforeMinutes);
    for (let w = startWall.getTime(); w < endWall.getTime(); w += MINUTE) {
      const wall = new Date(w);
      if (!wallMatcher.match(wall)) continue;
      const span = Math.abs(tr.offsetAfterMinutes - tr.offsetBeforeMinutes) * MINUTE;
      const windowStart = at - span - HOUR;
      const windowEnd = at + span + HOUR;
      const wallTime = hhmm(wall);
      // Wall times croner may use for this slot: the slot itself, or (for a gap) the slot shifted by the gap length.
      const candidates = new Set([wallTime, ...(tr.kind === 'gap' ? [hhmm(new Date(w + span))] : [])]);
      const runs = zoned
        .nextRuns(200, new Date(windowStart))
        .filter((d) => d.getTime() >= windowStart && d.getTime() < windowEnd)
        .filter((d) => {
          const p = zonedParts(d, timeZone);
          return dateInZone(d, timeZone) === tr.localDate && candidates.has(`${pad(p.hour)}:${pad(p.minute)}`);
        })
        .map((d) => d.toISOString());
      const message =
        tr.kind === 'gap'
          ? `${wallTime} does not exist on ${tr.localDate} in ${timeZone} (clocks move forward). The scheduler fires at ${runs.join(', ') || 'no time'} instead.`
          : `${wallTime} occurs twice on ${tr.localDate} in ${timeZone} (clocks move back). The scheduler fires ${runs.length === 1 ? 'once' : `${runs.length} times`} (${runs.join(', ')}).`;
      notes.push({ kind: tr.kind, localDate: tr.localDate, wallTime, transitionAt: tr.at, actualRuns: runs, message });
    }
  }
  return notes;
}
