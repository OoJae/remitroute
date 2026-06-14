// Cadence parsing and next-run computation for schedules. The cadence is a
// compact string stored on the schedule row. Supported forms:
//   once              run a single time, then mark the schedule done
//   daily             every 24 hours
//   weekly            every 7 days
//   weekly:fri        next occurrence of that weekday (mon..sun)
//   monthly:1         the given day of month (1..28), next month if past
//   every:20m         fixed interval in minutes
//   every:2h          fixed interval in hours
// computeNextRun returns the next run time, or null when there is no next run
// (the `once` cadence), in which case the caller marks the schedule done.
import { z } from "zod";

const DOW: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export const CadenceSchema = z
  .string()
  .min(1)
  .refine((c) => isValidCadence(c), "unsupported cadence string");

export function isValidCadence(cadence: string): boolean {
  const c = cadence.trim().toLowerCase();
  if (c === "once" || c === "daily" || c === "weekly") return true;
  if (c.startsWith("weekly:")) return DOW[c.slice(7)] !== undefined;
  if (c.startsWith("monthly:")) {
    const d = Number(c.slice(8));
    return Number.isInteger(d) && d >= 1 && d <= 28;
  }
  if (c.startsWith("every:")) {
    const m = /^every:(\d+)(m|h)$/.exec(c);
    return m !== null && Number(m[1]) > 0;
  }
  return false;
}

// Compute the next run strictly after `from` for the given cadence.
export function computeNextRun(cadence: string, from: Date = new Date()): Date | null {
  const c = cadence.trim().toLowerCase();

  if (c === "once") return null;

  if (c === "daily") return addMs(from, 24 * 60 * 60 * 1000);
  if (c === "weekly") return addMs(from, 7 * 24 * 60 * 60 * 1000);

  if (c.startsWith("weekly:")) {
    const target = DOW[c.slice(7)];
    if (target === undefined) throw new Error(`bad weekday in cadence: ${cadence}`);
    return nextWeekday(from, target);
  }

  if (c.startsWith("monthly:")) {
    const dom = Number(c.slice(8));
    return nextMonthlyDay(from, dom);
  }

  const everyMatch = /^every:(\d+)(m|h)$/.exec(c);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unitMs = everyMatch[2] === "h" ? 60 * 60 * 1000 : 60 * 1000;
    return addMs(from, n * unitMs);
  }

  throw new Error(`unsupported cadence: ${cadence}`);
}

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

// Next occurrence of a weekday, strictly after `from` (at the same time of day).
function nextWeekday(from: Date, targetDow: number): Date {
  const result = new Date(from.getTime());
  let delta = (targetDow - result.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  result.setUTCDate(result.getUTCDate() + delta);
  return result;
}

// Next time the given day of month occurs, strictly after `from`.
function nextMonthlyDay(from: Date, dom: number): Date {
  const result = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      dom,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
    ),
  );
  if (result.getTime() <= from.getTime()) {
    result.setUTCMonth(result.getUTCMonth() + 1);
  }
  return result;
}
