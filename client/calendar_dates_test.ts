/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  addDays,
  coversDay,
  fmtDay,
  fmtWhen,
  monthGrid,
  overlaps,
  shiftMonth,
  sortKey,
  todayYmd,
  weekday,
  ymd,
} from "./calendar_dates.ts";

const ev = (over: Partial<Parameters<typeof fmtWhen>[0]> = {}) => ({
  startDate: "2026-11-08",
  startTime: null,
  endDate: null,
  endTime: null,
  ...over,
});

Deno.test("ymd zero-pads", () => {
  assertEquals(ymd(2026, 1, 5), "2026-01-05");
  assertEquals(ymd(2026, 11, 28), "2026-11-28");
});

Deno.test("addDays crosses month, year and leap boundaries", () => {
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addDays("2028-02-28", 1), "2028-02-29");
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
  assertEquals(addDays("2026-11-08", 0), "2026-11-08");
});

Deno.test("weekday is Sunday-based", () => {
  assertEquals(weekday("2026-11-08"), 0); // 日
  assertEquals(weekday("2026-11-07"), 6); // 土
  assertEquals(weekday("2026-03-01"), 0);
});

Deno.test("shiftMonth wraps the year both ways", () => {
  assertEquals(shiftMonth(2026, 12, 1), { y: 2027, m: 1 });
  assertEquals(shiftMonth(2026, 1, -1), { y: 2025, m: 12 });
  assertEquals(shiftMonth(2026, 11, 0), { y: 2026, m: 11 });
  assertEquals(shiftMonth(2026, 11, -23), { y: 2024, m: 12 });
});

Deno.test("monthGrid is 42 days starting on the Sunday on or before the 1st", () => {
  // Expected bounds computed independently (Python datetime).
  const cases: [number, number, string, string][] = [
    [2026, 11, "2026-11-01", "2026-12-12"], // the 1st is a Sunday
    [2026, 2, "2026-02-01", "2026-03-14"],
    [2027, 1, "2026-12-27", "2027-02-06"], // starts in the previous year
    [2026, 12, "2026-11-29", "2027-01-09"], // ends in the next year
  ];
  for (const [y, m, from, to] of cases) {
    const g = monthGrid(y, m);
    assertEquals(g.days.length, 42);
    assertEquals([g.from, g.to], [from, to], `${y}-${m}`);
    assertEquals(g.days[0], g.from);
    assertEquals(g.days[41], g.to);
    assertEquals(weekday(g.from), 0);
    // Consecutive days, no gaps or repeats.
    for (let i = 1; i < 42; i++) {
      assertEquals(g.days[i], addDays(g.days[i - 1], 1));
    }
  }
});

Deno.test("coversDay includes every day of a multi-day event", () => {
  const trip = ev({ startDate: "2026-11-08", endDate: "2026-11-10" });
  assertFalse(coversDay(trip, "2026-11-07"));
  assert(coversDay(trip, "2026-11-08"));
  assert(coversDay(trip, "2026-11-09"));
  assert(coversDay(trip, "2026-11-10"));
  assertFalse(coversDay(trip, "2026-11-11"));
  // A single-day event covers only its day.
  assert(coversDay(ev(), "2026-11-08"));
  assertFalse(coversDay(ev(), "2026-11-09"));
});

Deno.test("overlaps matches the server's range query", () => {
  const trip = ev({ startDate: "2026-10-30", endDate: "2026-11-01" });
  assert(overlaps(trip, "2026-11-01", "2026-11-30"));
  assertFalse(overlaps(trip, "2026-11-02", "2026-11-30"));
  assert(overlaps(ev(), "2026-11-08", "2026-11-08"));
});

Deno.test("fmtDay and fmtWhen", () => {
  assertEquals(fmtDay("2026-11-08"), "11/8(日)");
  assertEquals(fmtWhen(ev()), "終日");
  assertEquals(
    fmtWhen(ev({ startTime: "10:00", endTime: "11:30" })),
    "10:00〜11:30",
  );
  assertEquals(
    fmtWhen(ev({ endDate: "2026-11-10" })),
    "11/8(日)〜11/10(火)",
  );
  assertEquals(
    fmtWhen(
      ev({ startTime: "22:00", endDate: "2026-11-09", endTime: "06:00" }),
    ),
    "11/8(日) 22:00〜11/9(月) 06:00",
  );
});

Deno.test("sortKey puts all-day first, then by time, then by id", () => {
  const rows = [
    { ...ev({ startTime: "14:00", endTime: "15:00" }), id: "c" },
    { ...ev(), id: "z" },
    { ...ev({ startTime: "09:00", endTime: "10:00" }), id: "b" },
    { ...ev({ startDate: "2026-11-07" }), id: "y" },
    { ...ev({ startTime: "09:00", endTime: "10:00" }), id: "a" },
  ];
  rows.sort((p, q) => sortKey(p) < sortKey(q) ? -1 : 1);
  assertEquals(rows.map((r) => r.id), ["y", "z", "a", "b", "c"]);
});

Deno.test("todayYmd reads the device-local date", () => {
  // 2026-11-08 23:30 local, whatever the zone: still the 8th.
  assertEquals(todayYmd(new Date(2026, 10, 8, 23, 30)), "2026-11-08");
  assertEquals(todayYmd(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});
