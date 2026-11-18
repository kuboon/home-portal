/**
 * Calendar side effects shared by the HTTP API and the MCP tools.
 *
 * A change to an event (add / update / delete) bumps the home's calendar
 * signal and posts a one-line notice into the main channel, so the chat and
 * Web Push carry it with no extra plumbing. The MCP tools go through the same
 * path, so an agent's change is announced exactly like a human's.
 */

import { type CalendarEvent, postMessage } from "@scope/db";
import { notifyNewMessage } from "./notify.ts";
import { signalCalendar, signalMainChannel } from "./realtime.ts";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 'YYYY-MM-DD' → '11/8(土)'. The weekday comes from `getUTCDay()`: the string
 * is a timezone-free date, and `new Date("2026-11-08")` is UTC midnight, so
 * `getDay()` would give the previous day for anyone west of UTC.
 */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${weekday})`;
}

/**
 * One-line description of an event's when + title, e.g.
 * `11/8(土) 10:00〜11:30 運動会` or `11/8(土)〜11/10(月) 旅行`.
 */
export function describeEvent(
  event: Pick<
    CalendarEvent,
    "title" | "startDate" | "startTime" | "endDate" | "endTime"
  >,
): string {
  const start = formatDate(event.startDate);
  const multiDay = event.endDate !== null && event.endDate !== event.startDate;
  const end = multiDay ? formatDate(event.endDate!) : "";
  let when: string;
  if (event.startTime === null) {
    when = multiDay ? `${start}〜${end}` : start;
  } else if (multiDay) {
    when = `${start} ${event.startTime}〜${end} ${event.endTime}`;
  } else {
    when = `${start} ${event.startTime}〜${event.endTime}`;
  }
  return `${when} ${event.title}`;
}

export type EventChange = "added" | "updated" | "deleted";

const VERBS: Record<EventChange, string> = {
  added: "予定を追加",
  updated: "予定を変更",
  deleted: "予定を削除",
};

/** The main-channel notice for an event change. */
export function announcement(change: EventChange, event: CalendarEvent) {
  return `📅 ${VERBS[change]}: ${describeEvent(event)}`;
}

/**
 * After an event change: signal calendar watchers, then post the notice into
 * the main channel as the acting user and notify members.
 *
 * The event change is the source of truth and has already committed; the
 * notice is a courtesy. So a failure to post is logged and swallowed rather
 * than failing a change that did succeed. Never throws.
 */
export async function announceEventChange(
  change: EventChange,
  event: CalendarEvent,
  authorId: string,
): Promise<void> {
  try {
    await signalCalendar(event.homeId);
  } catch (error) {
    console.warn("[calendar] signal failed", error);
  }
  try {
    const body = announcement(change, event);
    await postMessage({ homeId: event.homeId, threadId: null, authorId, body });
    await signalMainChannel(event.homeId);
    await notifyNewMessage({ homeId: event.homeId, authorId, body });
  } catch (error) {
    console.warn("[calendar] announcement failed", error);
  }
}
