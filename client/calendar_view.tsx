/**
 * The calendar pane of the chat screen: a month grid, the selected day's (or
 * the month's) events, and a bottom sheet to add / edit / delete an event.
 *
 * Not a `clientEntry`: `chat_panel.tsx` builds one with
 * {@link createCalendarView} and calls `render()` inside its content pane and
 * `sheet()` next to its other overlays. The sheet must sit directly in
 * `.chat-shell`, not inside a pane, or it would be caught up in the panes'
 * scroll-snap (see assets/style.css).
 *
 * State is plain closure `let`s re-rendered through the `update` callback,
 * like every panel in this codebase.
 */

import { on, ref, type RemixNode } from "@remix-run/ui";
import {
  coversDay,
  fmtDay,
  fmtMonth,
  fmtWhen,
  monthGrid,
  overlaps,
  parseYmd,
  shiftMonth,
  sortKey,
  todayYmd,
  weekday,
  WEEKDAY_LABELS,
} from "./calendar_dates.ts";
import type { FetchDpop } from "./session.ts";

/** Mirrors `CalendarEvent` in `@scope/db` (the client does not import it). */
export interface CalendarEvent {
  id: string;
  homeId: string;
  title: string;
  startDate: string;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  createdBy: string;
  createdAt: string;
  editedAt: string | null;
}

export interface CalendarViewOptions {
  /** JSON fetch helper (DPoP-signed); throws with the server's message. */
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  homeId: string;
  /**
   * Getters, not values: chat_panel learns these after its async startup,
   * after this view is created.
   */
  userId: () => string | null;
  isAdmin: () => boolean;
  fetchDpop: () => FetchDpop | null;
  /** Re-render the chat panel. */
  update: () => void;
  /** Run an action, surfacing a thrown error in chat_panel's error banner. */
  run: (fn: () => Promise<void>) => Promise<void>;
}

/** Most event chips a grid cell shows before collapsing to "+N". */
const MAX_CHIPS = 2;
const DEFAULT_START_TIME = "10:00";
const DEFAULT_END_TIME = "11:00";

/** The fields of the open sheet's form, captured by the `ref` mixin. */
type FieldName = "title" | "startDate" | "startTime" | "endDate" | "endTime";

export function createCalendarView(opts: CalendarViewOptions) {
  // "Today" is read fresh at each use, never cached: an A2HS app stays open on
  // a phone for days, and a cached value would go stale at midnight.
  let { y, m } = parseYmd(todayYmd());
  let events: CalendarEvent[] = [];
  let selected: string | null = null;
  let loading = false;
  /** Bumped per load so a slow, older response cannot overwrite a newer one. */
  let loadSeq = 0;
  let streamAbort: AbortController | null = null;

  // The sheet. `editing` is the event being edited, or null for a new one.
  let sheetOpen = false;
  let editing: CalendarEvent | null = null;
  let sheetSeq = 0;
  let allDay = true;
  let saving = false;
  /**
   * The sheet's own error line. Save/delete errors cannot go to chat_panel's
   * banner: it sits behind the sheet, so a validation error would be hidden.
   */
  let sheetError = "";
  /** Seeds for the form's `defaultValue`s; refreshed from the DOM on toggle. */
  let draft: Record<FieldName, string> = {
    title: "",
    startDate: "",
    startTime: DEFAULT_START_TIME,
    endDate: "",
    endTime: DEFAULT_END_TIME,
  };
  const fields: Partial<Record<FieldName, HTMLInputElement>> = {};

  const isMultiDay = (e: CalendarEvent) =>
    e.endDate !== null && e.endDate !== e.startDate;

  const canEdit = (e: CalendarEvent) =>
    e.createdBy === opts.userId() || opts.isAdmin();

  const load = async () => {
    const seq = ++loadSeq;
    const { from, to } = monthGrid(y, m);
    loading = true;
    opts.update();
    try {
      const data = await opts.api(
        `/api/homes/${opts.homeId}/events?from=${from}&to=${to}`,
      ) as { events: CalendarEvent[] };
      if (seq === loadSeq) events = data.events;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  };

  /**
   * Re-fetch on every change ping from the server. Same framing as the chat
   * stream: blocks split on a blank line, `event: sync` means "re-query".
   * Comment frames (the server's keep-alive) carry no `event:` line.
   */
  const start = () => {
    if (streamAbort) return;
    const fetchDpop = opts.fetchDpop();
    if (!fetchDpop) return;
    const ac = new AbortController();
    streamAbort = ac;
    (async () => {
      const response = await fetchDpop(
        `/api/homes/${opts.homeId}/events/stream`,
        { signal: ac.signal },
      );
      if (!response.ok || !response.body) return;
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = block.split("\n").find((l) => l.startsWith("event:"))
            ?.slice(6).trim();
          if (event === "sync") await opts.run(load);
        }
      }
    })().catch(() => {}).finally(() => {
      if (streamAbort === ac) streamAbort = null;
    });
  };

  const stop = () => {
    streamAbort?.abort();
    streamAbort = null;
  };

  const goMonth = (delta: number) =>
    opts.run(async () => {
      ({ y, m } = shiftMonth(y, m, delta));
      selected = null;
      await load();
    });

  const goToday = () =>
    opts.run(async () => {
      const today = todayYmd();
      ({ y, m } = parseYmd(today));
      selected = today;
      await load();
    });

  const selectDay = (day: string) => {
    selected = selected === day ? null : day;
    // A day from the leading/trailing week belongs to another month: follow it.
    const d = parseYmd(day);
    if (d.y !== y || d.m !== m) {
      y = d.y;
      m = d.m;
      opts.run(load);
      return;
    }
    opts.update();
  };

  // --- the sheet ----------------------------------------------------------

  const openSheet = (event: CalendarEvent | null) => {
    editing = event;
    sheetSeq++;
    saving = false;
    sheetError = "";
    if (event) {
      allDay = event.startTime === null;
      draft = {
        title: event.title,
        startDate: event.startDate,
        startTime: event.startTime ?? DEFAULT_START_TIME,
        endDate: event.endDate ?? event.startDate,
        endTime: event.endTime ?? DEFAULT_END_TIME,
      };
    } else {
      const day = selected ?? todayYmd();
      allDay = true;
      draft = {
        title: "",
        startDate: day,
        startTime: DEFAULT_START_TIME,
        endDate: day,
        endTime: DEFAULT_END_TIME,
      };
    }
    sheetOpen = true;
    opts.update();
  };

  const closeSheet = () => {
    sheetOpen = false;
    editing = null;
    opts.update();
  };

  /** Copy what the user typed into `draft`, so a re-render keeps it. */
  const snapshot = () => {
    for (const name of Object.keys(fields) as FieldName[]) {
      const el = fields[name];
      if (el) draft[name] = el.value;
    }
  };

  /** `ref` mixin: track a form field while it is mounted. */
  const bind = (name: FieldName) =>
    ref((node, signal) => {
      fields[name] = node as HTMLInputElement;
      signal.addEventListener("abort", () => {
        if (fields[name] === node) delete fields[name];
      });
    });

  const onToggleAllDay = (checked: boolean) => {
    snapshot();
    allDay = checked;
    opts.update();
  };

  /** Keep the end date from falling before a newly picked start date. */
  const onStartDateChange = () => {
    const start = fields.startDate?.value;
    const end = fields.endDate;
    if (start && end && end.value < start) end.value = start;
  };

  /** Run a sheet action, showing a failure inside the sheet. */
  const sheetAction = async (fn: () => Promise<void>) => {
    if (saving) return;
    sheetError = "";
    saving = true;
    opts.update();
    try {
      await fn();
    } catch (e) {
      sheetError = (e as Error).message;
    } finally {
      saving = false;
      opts.update();
    }
  };

  const onSave = () => {
    snapshot();
    const body = {
      title: draft.title,
      startDate: draft.startDate,
      endDate: draft.endDate,
      startTime: allDay ? null : draft.startTime,
      endTime: allDay ? null : draft.endTime,
    };
    return sheetAction(async () => {
      const base = `/api/homes/${opts.homeId}/events`;
      await opts.api(editing ? `${base}/${editing.id}` : base, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Show the month the event landed in.
      ({ y, m } = parseYmd(body.startDate));
      selected = body.startDate;
      sheetOpen = false;
      editing = null;
      await load();
    });
  };

  const onDelete = () => {
    const target = editing;
    if (!target) return;
    if (!globalThis.confirm(`「${target.title}」を削除しますか？`)) return;
    return sheetAction(async () => {
      await opts.api(`/api/homes/${opts.homeId}/events/${target.id}`, {
        method: "DELETE",
      });
      sheetOpen = false;
      editing = null;
      await load();
    });
  };

  // --- rendering ----------------------------------------------------------

  const sorted = (list: CalendarEvent[]) =>
    [...list].sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);

  const dayCell = (day: string, inMonth: boolean, today: string) => {
    const dayEvents = sorted(events.filter((e) => coversDay(e, day)));
    const isToday = day === today;
    const isSelected = day === selected;
    const dow = weekday(day);
    const tone = dow === 0 ? "text-error" : dow === 6 ? "text-info" : "";
    return (
      <button
        type="button"
        key={day}
        class={`calendar-day min-h-14 sm:min-h-20 flex flex-col items-stretch gap-0.5 p-0.5 text-left border-b border-r border-base-content/10 ${
          inMonth ? "" : "opacity-40"
        } ${isSelected ? "bg-primary/15" : "hover:bg-base-content/5"}`}
        aria-label={`${fmtDay(day)}${
          dayEvents.length ? ` 予定 ${dayEvents.length} 件` : ""
        }`}
        aria-pressed={isSelected ? "true" : "false"}
        mix={[on("click", () => selectDay(day))]}
      >
        <span
          class={`self-center text-xs leading-5 w-5 h-5 text-center rounded-full ${
            isToday ? "bg-primary text-primary-content font-bold" : tone
          }`}
        >
          {parseYmd(day).d}
        </span>
        {/* 狭い画面では点、広い画面ではタイトルを出す。 */}
        {dayEvents.length
          ? (
            <span class="sm:hidden flex justify-center gap-0.5">
              {dayEvents.slice(0, 3).map((e) => (
                <span key={e.id} class="w-1.5 h-1.5 rounded-full bg-primary">
                </span>
              ))}
            </span>
          )
          : null}
        {dayEvents.slice(0, MAX_CHIPS).map((e) => (
          <span
            key={e.id}
            class="hidden sm:block truncate rounded px-1 text-[11px] leading-4 bg-primary/15"
          >
            {e.startTime && e.startDate === day ? `${e.startTime} ` : ""}
            {e.title}
          </span>
        ))}
        {dayEvents.length > MAX_CHIPS
          ? (
            <span class="hidden sm:block text-[11px] leading-4 opacity-60 px-1">
              +{dayEvents.length - MAX_CHIPS}
            </span>
          )
          : null}
      </button>
    );
  };

  const eventRow = (e: CalendarEvent) => (
    <li key={e.id}>
      <button
        type="button"
        class="calendar-event w-full flex items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-base-content/5"
        mix={[on("click", () => openSheet(e))]}
      >
        <span class="shrink-0 w-24 flex flex-col text-xs opacity-70 pt-0.5">
          {
            /* 日付を選んでいない（月一覧）ときは日付も出す。複数日の予定は
            fmtWhen が日付を含むので重ねない。 */
          }
          {!selected && !isMultiDay(e)
            ? <span>{fmtDay(e.startDate)}</span>
            : null}
          <span>{fmtWhen(e)}</span>
        </span>
        <span class="flex-1 min-w-0 break-words">{e.title}</span>
      </button>
    </li>
  );

  const render = (): RemixNode => {
    const { days } = monthGrid(y, m);
    const today = todayYmd();
    const monthFirst = `${y}-${String(m).padStart(2, "0")}-01`;
    const monthLast = days.filter((d) => d.startsWith(monthFirst.slice(0, 8)))
      .at(-1)!;
    const listed = sorted(
      selected
        ? events.filter((e) => coversDay(e, selected!))
        : events.filter((e) => overlaps(e, monthFirst, monthLast)),
    );
    return (
      <div class="calendar flex-1 min-h-0 overflow-y-auto">
        <div class="calendar-toolbar flex items-center gap-1 px-2 py-2">
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            aria-label="前の月"
            mix={[on("click", () => goMonth(-1))]}
          >
            ‹
          </button>
          <h3 class="font-bold text-lg min-w-28 text-center">
            {fmtMonth(y, m)}
          </h3>
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            aria-label="次の月"
            mix={[on("click", () => goMonth(1))]}
          >
            ›
          </button>
          {loading
            ? (
              <span class="loading loading-spinner loading-xs opacity-60">
              </span>
            )
            : null}
          <span class="flex-1"></span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            mix={[on("click", goToday)]}
          >
            今日
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            mix={[on("click", () => openSheet(null))]}
          >
            ＋ 予定
          </button>
        </div>

        <div class="calendar-grid grid grid-cols-7 border-t border-l border-base-content/10 mx-2">
          {WEEKDAY_LABELS.map((label, i) => (
            <div
              key={label}
              class={`text-center text-xs py-1 border-b border-r border-base-content/10 ${
                i === 0 ? "text-error" : i === 6 ? "text-info" : "opacity-70"
              }`}
            >
              {label}
            </div>
          ))}
          {days.map((day) => dayCell(day, parseYmd(day).m === m, today))}
        </div>

        <section class="calendar-list px-2 py-3">
          <h4 class="px-2 pb-1 text-sm font-semibold opacity-70">
            {selected ? `${fmtDay(selected)} の予定` : `${m}月の予定`}
          </h4>
          {listed.length === 0
            ? <p class="px-2 py-4 text-sm opacity-60">予定はありません。</p>
            : <ul>{listed.map(eventRow)}</ul>}
        </section>
      </div>
    );
  };

  const sheet = (): RemixNode => {
    if (!sheetOpen) return null;
    const readOnly = editing !== null && !canEdit(editing);
    const disabled = readOnly || saving;
    // Inputs are uncontrolled (`defaultValue` + read back through `ref`), per
    // the remix-ui-text-field-editable skill: binding `value=` makes the
    // runtime treat a field as controlled, and re-seeding the form when the
    // sheet re-opens on another event would fight what the user typed. Do not
    // "fix" these back to `value=`.
    return (
      <div
        class="fixed inset-0 z-40 flex flex-col justify-end"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "予定の編集" : "予定の追加"}
      >
        <button
          type="button"
          class="context-scrim absolute inset-0 bg-black/40"
          aria-label="閉じる"
          mix={[on("click", closeSheet)]}
        >
        </button>
        <div
          key={`sheet-${sheetSeq}`}
          class="calendar-sheet context-sheet relative w-full max-w-md mx-auto bg-base-100 rounded-t-2xl shadow-2xl px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[90dvh] overflow-y-auto"
        >
          <div class="flex justify-center pb-2">
            <div class="h-1 w-10 rounded-full bg-base-content/20"></div>
          </div>
          <h3 class="font-bold mb-3">
            {readOnly ? "予定" : editing ? "予定の編集" : "予定の追加"}
          </h3>
          <div class="space-y-3">
            <input
              key="title"
              type="text"
              class="input input-bordered w-full"
              placeholder="タイトル（例: 運動会）"
              maxlength={200}
              defaultValue={draft.title}
              disabled={disabled}
              mix={[bind("title")]}
            />
            <label class="flex items-center gap-2 text-sm">
              <input
                key="allDay"
                type="checkbox"
                class="toggle toggle-sm"
                defaultChecked={allDay}
                disabled={disabled}
                mix={[on<HTMLInputElement>("change", (e) =>
                  onToggleAllDay((e.target as HTMLInputElement).checked))]}
              />
              終日
            </label>
            {
              /* 各行は [日付, 時刻?]。時刻が末尾なので、終日を切り替えても
                日付の input は同じノードのまま残る。 */
            }
            <div class="flex items-center gap-2">
              <span class="w-8 text-sm opacity-70 shrink-0">開始</span>
              <input
                key="startDate"
                type="date"
                class="input input-bordered input-sm flex-1 min-w-0"
                defaultValue={draft.startDate}
                disabled={disabled}
                mix={[bind("startDate"), on("change", onStartDateChange)]}
              />
              {allDay ? null : (
                <input
                  key="startTime"
                  type="time"
                  class="input input-bordered input-sm w-28"
                  defaultValue={draft.startTime}
                  disabled={disabled}
                  mix={[bind("startTime")]}
                />
              )}
            </div>
            <div class="flex items-center gap-2">
              <span class="w-8 text-sm opacity-70 shrink-0">終了</span>
              <input
                key="endDate"
                type="date"
                class="input input-bordered input-sm flex-1 min-w-0"
                defaultValue={draft.endDate}
                disabled={disabled}
                mix={[bind("endDate")]}
              />
              {allDay ? null : (
                <input
                  key="endTime"
                  type="time"
                  class="input input-bordered input-sm w-28"
                  defaultValue={draft.endTime}
                  disabled={disabled}
                  mix={[bind("endTime")]}
                />
              )}
            </div>
            {readOnly
              ? (
                <p class="text-xs opacity-60">
                  作成者または管理者だけが編集できます。
                </p>
              )
              : null}
            {sheetError
              ? (
                <div role="alert" class="alert alert-error alert-soft py-2">
                  <span>{sheetError}</span>
                </div>
              )
              : null}
          </div>
          <div class="flex items-center gap-2 mt-4">
            {editing && !readOnly
              ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-sm text-error"
                  disabled={saving}
                  mix={[on("click", onDelete)]}
                >
                  削除
                </button>
              )
              : null}
            <span class="flex-1"></span>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              mix={[on("click", closeSheet)]}
            >
              {readOnly ? "閉じる" : "キャンセル"}
            </button>
            {readOnly ? null : (
              <button
                type="button"
                class="btn btn-primary btn-sm"
                disabled={saving}
                mix={[on("click", onSave)]}
              >
                {saving
                  ? <span class="loading loading-spinner loading-xs"></span>
                  : null}
                保存
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return {
    render,
    sheet,
    /** Fetch the visible month's events. */
    load,
    /** Subscribe to change pings (idempotent). */
    start,
    /** Unsubscribe; called when leaving the calendar. */
    stop,
    /** Close the sheet without saving (e.g. on navigating away). */
    closeSheet: () => {
      if (sheetOpen) closeSheet();
    },
  };
}

export type CalendarView = ReturnType<typeof createCalendarView>;
