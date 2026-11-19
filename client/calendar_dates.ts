/**
 * Timezone-free date math for the calendar.
 *
 * Event dates are wall-clock strings ('YYYY-MM-DD'), not instants, so every
 * computation here goes through `Date.UTC` + `getUTC*`: that pins the string
 * to one fixed day regardless of the viewer's zone. (`new Date("2026-11-08")`
 * is UTC midnight, so the local `getDay()` would report the previous day for
 * anyone west of UTC.) The single exception is {@link todayYmd}, which is the
 * viewer's own today by definition.
 *
 * Kept free of DOM and `@remix-run/ui` so it can be unit-tested.
 */

/** The fields of an event this module reads. */
export interface DatedEvent {
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const pad = (n: number) => String(n).padStart(2, "0");

/** (2026, 11, 8) → '2026-11-08'. Month is 1-based. */
export function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** '2026-11-08' → { y: 2026, m: 11, d: 8 }. */
export function parseYmd(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

const toUtc = (s: string) => {
  const { y, m, d } = parseYmd(s);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (dt: Date) =>
  ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

/** Shift a date by `n` days (negative goes back). Handles month/year ends. */
export function addDays(s: string, n: number): string {
  const dt = toUtc(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

/** 0 = 日 … 6 = 土, independent of the viewer's timezone. */
export function weekday(s: string): number {
  return toUtc(s).getUTCDay();
}

/** The viewer's own today, from their device clock. */
export function todayYmd(now: Date = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The month after/before (y, m), wrapping the year. Month is 1-based. */
export function shiftMonth(
  y: number,
  m: number,
  delta: number,
): { y: number; m: number } {
  const i = y * 12 + (m - 1) + delta;
  return { y: Math.floor(i / 12), m: (i % 12 + 12) % 12 + 1 };
}

/**
 * The 6×7 grid for a month, weeks starting on Sunday (the usual layout in
 * Japan). Always 42 days, so the grid's height never jumps between months.
 * `from`/`to` are the first and last cells, for fetching what the grid shows.
 */
export function monthGrid(
  y: number,
  m: number,
): { from: string; to: string; days: string[] } {
  const first = ymd(y, m, 1);
  const from = addDays(first, -weekday(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  return { from, to: days[41], days };
}

/** The last day an event covers (its start day when it has no end date). */
export const lastDay = (e: DatedEvent) => e.endDate ?? e.startDate;

/** True if the event falls on `day` (multi-day events cover every day). */
export function coversDay(e: DatedEvent, day: string): boolean {
  return e.startDate <= day && day <= lastDay(e);
}

/** True if the event overlaps the inclusive range [from, to]. */
export function overlaps(e: DatedEvent, from: string, to: string): boolean {
  return e.startDate <= to && lastDay(e) >= from;
}

/** '2026-11-08' → '11/8(日)'. */
export function fmtDay(s: string): string {
  const { m, d } = parseYmd(s);
  return `${m}/${d}(${WEEKDAYS[weekday(s)]})`;
}

/** Header label for a month, e.g. '2026年11月'. */
export const fmtMonth = (y: number, m: number) => `${y}年${m}月`;

/** Weekday column labels, Sunday first. */
export const WEEKDAY_LABELS = WEEKDAYS;

/**
 * The "when" of an event for a list row: '終日', '10:00〜11:30', or with the
 * dates spelled out for a multi-day event.
 */
export function fmtWhen(e: DatedEvent): string {
  const multiDay = e.endDate !== null && e.endDate !== e.startDate;
  if (e.startTime === null) {
    return multiDay ? `${fmtDay(e.startDate)}〜${fmtDay(e.endDate!)}` : "終日";
  }
  if (multiDay) {
    return `${fmtDay(e.startDate)} ${e.startTime}〜${
      fmtDay(e.endDate!)
    } ${e.endTime}`;
  }
  return `${e.startTime}〜${e.endTime}`;
}

/**
 * Sort key matching the server's `ORDER BY start_date, start_time, id`:
 * all-day events ('' sorts first) lead their day.
 */
export const sortKey = (e: DatedEvent & { id: string }) =>
  `${e.startDate} ${e.startTime ?? ""} ${e.id}`;
