/**
 * Calendar events — one shared calendar per Home.
 *
 * Dates and times are timezone-free wall-clock strings ('YYYY-MM-DD' /
 * 'HH:MM'): a family's "Nov 8 at 10:00" is not an absolute instant, and keeping
 * it as text means the grid cell is decided by the string itself with no zone
 * conversion anywhere. `startTime === null` marks an all-day event.
 *
 * Membership/role checks are the controller's job — these functions assume the
 * caller is already authorized for the home. Update/delete still enforce
 * "creator or admin" here (the `renameThread` pattern), since that rule
 * needs the stored row.
 */

import { monotonicUlid } from "@std/ulid";
import { db } from "./client.ts";
import { HomeError } from "./homes.ts";

/** Max event title length, in characters. */
export const MAX_EVENT_TITLE = 200;

/** Max span of a single {@link listEvents} query, in days. */
export const MAX_EVENT_RANGE_DAYS = 400;

export interface CalendarEvent {
  id: string;
  homeId: string;
  title: string;
  /** 'YYYY-MM-DD' (timezone-free wall-clock date). */
  startDate: string;
  /** 'HH:MM', or null for an all-day event. */
  startTime: string | null;
  /** 'YYYY-MM-DD', or null when the event ends on {@link startDate}. */
  endDate: string | null;
  /** 'HH:MM', or null for an all-day event. */
  endTime: string | null;
  createdBy: string;
  createdAt: string;
  editedAt: string | null;
}

/** Untrusted event fields (from a controller/MCP caller). */
export interface EventInput {
  title: string;
  startDate: string;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
}

/** Canonical, validated event fields. */
export type EventFields = {
  title: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** True for an existing calendar date ('2026-02-30' is false). */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d;
}

function isRealTime(s: string): boolean {
  if (!TIME_RE.test(s)) return false;
  const [h, min] = s.split(":").map(Number);
  return h <= 23 && min <= 59;
}

/** "" / null / undefined → null; anything else is kept (trimmed). */
const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Validate and canonicalize event fields, throwing HomeError(400) if bad.
 *
 * Exported so callers can validate *before* spending a rate-limit slot: a
 * rejected request posts nothing, so it should not make the user's immediate
 * correction fail with "too fast". `createEvent` / `updateEvent` still run it.
 */
export function normalizeEvent(input: EventInput): EventFields {
  const title = (input.title ?? "").trim();
  if (!title) throw new HomeError("予定のタイトルを入力してください");
  if (title.length > MAX_EVENT_TITLE) {
    throw new HomeError(`タイトルは ${MAX_EVENT_TITLE} 文字までです`);
  }

  const startDate = (input.startDate ?? "").trim();
  if (!isRealDate(startDate)) throw new HomeError("開始日が不正です");

  let endDate = blankToNull(input.endDate);
  if (endDate !== null && !isRealDate(endDate)) {
    throw new HomeError("終了日が不正です");
  }
  // Same-day is stored as NULL so there is one canonical form per event.
  if (endDate === startDate) endDate = null;

  const startTime = blankToNull(input.startTime);
  const endTime = blankToNull(input.endTime);
  if (startTime !== null && !isRealTime(startTime)) {
    throw new HomeError("開始時刻が不正です");
  }
  if (endTime !== null && !isRealTime(endTime)) {
    throw new HomeError("終了時刻が不正です");
  }
  // All-day XOR timed: both times or neither (mirrors the table's CHECK).
  if ((startTime === null) !== (endTime === null)) {
    throw new HomeError(
      "開始と終了の時刻は両方指定するか、両方空にしてください",
    );
  }

  // Compare the composite (date, time). Fixed-width strings sort correctly.
  const start = `${startDate} ${startTime ?? ""}`;
  const end = `${endDate ?? startDate} ${endTime ?? ""}`;
  if (end < start) throw new HomeError("終了が開始より前になっています");

  return { title, startDate, startTime, endDate, endTime };
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: String(row.id),
    homeId: String(row.home_id),
    title: String(row.title),
    startDate: String(row.start_date),
    startTime: row.start_time == null ? null : String(row.start_time),
    endDate: row.end_date == null ? null : String(row.end_date),
    endTime: row.end_time == null ? null : String(row.end_time),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    editedAt: row.edited_at == null ? null : String(row.edited_at),
  };
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'). */
function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/**
 * Events in a home that overlap `[from, to]` (inclusive, 'YYYY-MM-DD'),
 * ordered by start. A multi-day event appears if any of its days fall in the
 * range. All-day events lead their day: SQLite sorts NULL `start_time` first
 * in ASC. `id` (a ULID, creation-ordered) breaks exact ties deterministically.
 */
export async function listEvents(
  homeId: string,
  range: { from: string; to: string },
): Promise<CalendarEvent[]> {
  if (!isRealDate(range.from) || !isRealDate(range.to)) {
    throw new HomeError("期間の指定が不正です");
  }
  if (range.to < range.from) throw new HomeError("期間の指定が不正です");
  if (daysBetween(range.from, range.to) > MAX_EVENT_RANGE_DAYS) {
    throw new HomeError(`期間は ${MAX_EVENT_RANGE_DAYS} 日以内にしてください`);
  }
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM events " +
      "WHERE home_id = ? AND start_date <= ? " +
      "AND COALESCE(end_date, start_date) >= ? " +
      "ORDER BY start_date, start_time, id",
    args: [homeId, range.to, range.from],
  });
  return rows.map(rowToEvent);
}

export async function getEvent(id: string): Promise<CalendarEvent | null> {
  const { rows } = await (await db()).execute({
    sql: "SELECT * FROM events WHERE id = ?",
    args: [id],
  });
  return rows[0] ? rowToEvent(rows[0]) : null;
}

/** Create an event. Any member may create (the controller checks membership). */
export async function createEvent(
  input: EventInput & { homeId: string; userId: string },
): Promise<CalendarEvent> {
  const f = normalizeEvent(input);
  const id = monotonicUlid();
  await (await db()).execute({
    sql: "INSERT INTO events " +
      "(id, home_id, title, start_date, start_time, end_date, end_time, " +
      "created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      id,
      input.homeId,
      f.title,
      f.startDate,
      f.startTime,
      f.endDate,
      f.endTime,
      input.userId,
    ],
  });
  const event = await getEvent(id);
  if (!event) throw new Error(`createEvent failed to read back ${id}`);
  return event;
}

/** Load an event the caller may modify: its creator, or an admin. */
async function getEditable(
  eventId: string,
  userId: string,
  isAdmin: boolean,
): Promise<CalendarEvent> {
  const event = await getEvent(eventId);
  if (!event) throw new HomeError("event not found", 404);
  if (event.createdBy !== userId && !isAdmin) {
    throw new HomeError("作成者または管理者のみ編集できます", 403);
  }
  return event;
}

/**
 * Replace an event's fields (PUT semantics: every field is given; an omitted
 * time/end means "none"). The creator may edit their event; an admin may edit
 * any.
 */
export async function updateEvent(
  input: EventInput & { eventId: string; userId: string; isAdmin: boolean },
): Promise<CalendarEvent> {
  const f = normalizeEvent(input);
  await getEditable(input.eventId, input.userId, input.isAdmin);
  await (await db()).execute({
    sql: "UPDATE events SET title = ?, start_date = ?, start_time = ?, " +
      "end_date = ?, end_time = ?, edited_at = datetime('now') WHERE id = ?",
    args: [
      f.title,
      f.startDate,
      f.startTime,
      f.endDate,
      f.endTime,
      input.eventId,
    ],
  });
  const event = await getEvent(input.eventId);
  if (!event) {
    throw new Error(`updateEvent failed to read back ${input.eventId}`);
  }
  return event;
}

/**
 * Delete an event (hard delete). The creator may delete their event; an admin
 * may delete any. Returns the deleted event so the caller can describe it.
 */
export async function deleteEvent(
  input: { eventId: string; userId: string; isAdmin: boolean },
): Promise<CalendarEvent> {
  const event = await getEditable(input.eventId, input.userId, input.isAdmin);
  await (await db()).execute({
    sql: "DELETE FROM events WHERE id = ?",
    args: [input.eventId],
  });
  return event;
}
