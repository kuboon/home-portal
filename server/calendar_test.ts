import { assertEquals } from "@std/assert";
import type { CalendarEvent } from "@scope/db";
import { announcement, describeEvent, formatDate } from "./calendar.ts";

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e",
  homeId: "h",
  title: "運動会",
  startDate: "2026-11-08",
  startTime: null,
  endDate: null,
  endTime: null,
  createdBy: "alice",
  createdAt: "2026-11-01 00:00:00",
  editedAt: null,
  ...over,
});

Deno.test("formatDate gives month/day and a timezone-independent weekday", () => {
  assertEquals(formatDate("2026-11-08"), "11/8(日)");
  assertEquals(formatDate("2026-11-07"), "11/7(土)");
  assertEquals(formatDate("2027-01-01"), "1/1(金)");
  // Leap day.
  assertEquals(formatDate("2028-02-29"), "2/29(火)");
});

Deno.test("describeEvent covers the four shapes", () => {
  assertEquals(describeEvent(event({})), "11/8(日) 運動会");
  assertEquals(
    describeEvent(event({ title: "旅行", endDate: "2026-11-10" })),
    "11/8(日)〜11/10(火) 旅行",
  );
  assertEquals(
    describeEvent(event({ startTime: "10:00", endTime: "11:30" })),
    "11/8(日) 10:00〜11:30 運動会",
  );
  assertEquals(
    describeEvent(
      event({
        title: "夜行バス",
        startTime: "22:00",
        endDate: "2026-11-09",
        endTime: "06:00",
      }),
    ),
    "11/8(日) 22:00〜11/9(月) 06:00 夜行バス",
  );
});

Deno.test("describeEvent treats an end date equal to the start as one day", () => {
  assertEquals(
    describeEvent(event({ endDate: "2026-11-08" })),
    "11/8(日) 運動会",
  );
});

Deno.test("announcement names the change", () => {
  assertEquals(
    announcement("added", event({})),
    "📅 予定を追加: 11/8(日) 運動会",
  );
  assertEquals(
    announcement("updated", event({})),
    "📅 予定を変更: 11/8(日) 運動会",
  );
  assertEquals(
    announcement("deleted", event({})),
    "📅 予定を削除: 11/8(日) 運動会",
  );
});
