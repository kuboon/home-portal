/**
 * Calendar event tests against an in-memory libSQL DB (`:memory:`).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { db, resetClient } from "./client.ts";
import { migrate } from "./migrate.ts";
import { upsertUser } from "./users.ts";
import { addMember, createHome, HomeError } from "./homes.ts";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  MAX_EVENT_TITLE,
  updateEvent,
} from "./calendar.ts";

if (!Deno.env.get("TURSO_DATABASE_URL")) {
  Deno.env.set("TURSO_DATABASE_URL", ":memory:");
}

async function setup() {
  resetClient();
  await migrate();
  await upsertUser({ id: "alice", displayName: "Alice" });
  await upsertUser({ id: "bob", displayName: "Bob" });
  await upsertUser({ id: "carol", displayName: "Carol" });
  // alice is the home's admin (creator); bob and carol are members.
  const home = await createHome({ name: "H", userId: "alice" });
  await addMember(home.id, "bob");
  await addMember(home.id, "carol");
  return { home };
}

Deno.test("createEvent round-trips all-day and timed events", async () => {
  const { home } = await setup();
  const allDay = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "  運動会  ",
    startDate: "2026-11-08",
  });
  assertEquals(allDay.title, "運動会");
  assertEquals(allDay.startDate, "2026-11-08");
  assertEquals(allDay.startTime, null);
  assertEquals(allDay.endDate, null);
  assertEquals(allDay.endTime, null);
  assertEquals(allDay.createdBy, "bob");
  assertEquals(allDay.editedAt, null);

  const timed = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "通院",
    startDate: "2026-11-09",
    startTime: "10:00",
    endTime: "11:30",
  });
  assertEquals(timed.startTime, "10:00");
  assertEquals(timed.endTime, "11:30");
  assertEquals((await getEvent(timed.id))?.title, "通院");
});

Deno.test("an end date equal to the start date is stored as null", async () => {
  const { home } = await setup();
  const e = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "x",
    startDate: "2026-11-08",
    endDate: "2026-11-08",
  });
  assertEquals(e.endDate, null);
});

Deno.test("listEvents returns events overlapping the range", async () => {
  const { home } = await setup();
  const mk = (title: string, startDate: string, endDate?: string) =>
    createEvent({ homeId: home.id, userId: "bob", title, startDate, endDate });

  await mk("before", "2026-10-30");
  await mk("spans-into", "2026-10-30", "2026-11-01"); // ends on the 1st
  await mk("inside", "2026-11-15");
  await mk("last-day", "2026-11-30");
  await mk("spans-out", "2026-11-30", "2026-12-02");
  await mk("after", "2026-12-01");
  await mk("spans-whole", "2026-10-01", "2027-01-31");

  const titles = (await listEvents(home.id, {
    from: "2026-11-01",
    to: "2026-11-30",
  })).map((e) => e.title);
  assertEquals(titles, [
    "spans-whole",
    "spans-into",
    "inside",
    "last-day",
    "spans-out",
  ]);
});

Deno.test("listEvents is scoped to the home", async () => {
  const { home } = await setup();
  const other = await createHome({ name: "Other", userId: "carol" });
  await createEvent({
    homeId: other.id,
    userId: "carol",
    title: "elsewhere",
    startDate: "2026-11-08",
  });
  const events = await listEvents(home.id, {
    from: "2026-11-01",
    to: "2026-11-30",
  });
  assertEquals(events.length, 0);
});

Deno.test("all-day events lead their day, then timed by start", async () => {
  const { home } = await setup();
  const timed = (title: string, startTime: string, endTime: string) =>
    createEvent({
      homeId: home.id,
      userId: "bob",
      title,
      startDate: "2026-11-08",
      startTime,
      endTime,
    });
  await timed("afternoon", "14:00", "15:00");
  await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "all-day",
    startDate: "2026-11-08",
  });
  await timed("morning", "09:00", "10:00");
  // Two events at the same instant keep creation order (ULID tiebreak).
  await timed("tie-1", "12:00", "13:00");
  await timed("tie-2", "12:00", "13:00");

  const titles = (await listEvents(home.id, {
    from: "2026-11-08",
    to: "2026-11-08",
  })).map((e) => e.title);
  assertEquals(titles, ["all-day", "morning", "tie-1", "tie-2", "afternoon"]);
});

Deno.test("createEvent rejects malformed input", async () => {
  const { home } = await setup();
  const base = { homeId: home.id, userId: "bob", title: "x" };
  const bad = [
    { ...base, title: "   ", startDate: "2026-11-08" },
    {
      ...base,
      title: "a".repeat(MAX_EVENT_TITLE + 1),
      startDate: "2026-11-08",
    },
    { ...base, startDate: "2026-11-8" }, // not zero-padded
    { ...base, startDate: "2026-02-30" }, // not a real date
    { ...base, startDate: "2026-11-08", endDate: "2026-13-01" },
    { ...base, startDate: "2026-11-08", startTime: "24:00", endTime: "24:30" },
    { ...base, startDate: "2026-11-08", startTime: "9:00", endTime: "10:00" },
    // Only one of the two times: all-day XOR timed.
    { ...base, startDate: "2026-11-08", startTime: "10:00" },
    { ...base, startDate: "2026-11-08", endTime: "10:00" },
    // End before start: by date, and by time on the same day.
    { ...base, startDate: "2026-11-08", endDate: "2026-11-07" },
    { ...base, startDate: "2026-11-08", startTime: "11:00", endTime: "10:00" },
  ];
  for (const input of bad) {
    const error = await assertRejects(() => createEvent(input), HomeError);
    assertEquals(error.status, 400, JSON.stringify(input));
  }
});

Deno.test("a multi-day timed event may end earlier in the day", async () => {
  const { home } = await setup();
  // 22:00 on the 8th → 06:00 on the 9th is valid: compare (date, time).
  const e = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "夜行バス",
    startDate: "2026-11-08",
    startTime: "22:00",
    endDate: "2026-11-09",
    endTime: "06:00",
  });
  assertEquals(e.endDate, "2026-11-09");
});

Deno.test("the table CHECK rejects a half-timed row", async () => {
  const { home } = await setup();
  // Bypass normalizeEvent: the DDL constraint is the backstop. Use a real
  // home and user so it is the CHECK (not a foreign key) that rejects it.
  const insert = (startTime: string | null, endTime: string | null) =>
    db().then((c) =>
      c.execute({
        sql: "INSERT INTO events (id, home_id, title, start_date, " +
          "start_time, end_time, created_by) VALUES (?, ?, 't', " +
          "'2026-11-08', ?, ?, 'alice')",
        args: [crypto.randomUUID(), home.id, startTime, endTime],
      })
    );
  const error = await assertRejects(() => insert("10:00", null));
  assert(String(error).includes("CHECK"), String(error));
  // Both set and both null are fine.
  await insert("10:00", "11:00");
  await insert(null, null);
});

Deno.test("updateEvent replaces fields and marks edited", async () => {
  const { home } = await setup();
  const e = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "通院",
    startDate: "2026-11-09",
    startTime: "10:00",
    endTime: "11:00",
  });
  // PUT semantics: omitting the times turns it into an all-day event.
  const updated = await updateEvent({
    eventId: e.id,
    userId: "bob",
    isAdmin: false,
    title: "通院（終日）",
    startDate: "2026-11-10",
  });
  assertEquals(updated.title, "通院（終日）");
  assertEquals(updated.startDate, "2026-11-10");
  assertEquals(updated.startTime, null);
  assertEquals(updated.endTime, null);
  assert(updated.editedAt !== null);
  assertEquals(updated.createdBy, "bob");
});

Deno.test("only the creator or an admin may update or delete", async () => {
  const { home } = await setup();
  const e = await createEvent({
    homeId: home.id,
    userId: "bob",
    title: "bob's",
    startDate: "2026-11-08",
  });
  const edit = { title: "hijacked", startDate: "2026-11-08" };

  // carol is a member but not the creator.
  const denied = await assertRejects(
    () =>
      updateEvent({ ...edit, eventId: e.id, userId: "carol", isAdmin: false }),
    HomeError,
  );
  assertEquals(denied.status, 403);
  const deniedDelete = await assertRejects(
    () => deleteEvent({ eventId: e.id, userId: "carol", isAdmin: false }),
    HomeError,
  );
  assertEquals(deniedDelete.status, 403);
  // The denial must not have changed anything.
  assertEquals((await getEvent(e.id))?.title, "bob's");

  // An admin may edit and delete someone else's event.
  const byAdmin = await updateEvent({
    ...edit,
    title: "fixed by admin",
    eventId: e.id,
    userId: "alice",
    isAdmin: true,
  });
  assertEquals(byAdmin.title, "fixed by admin");
  const deleted = await deleteEvent({
    eventId: e.id,
    userId: "alice",
    isAdmin: true,
  });
  assertEquals(deleted.title, "fixed by admin");
  assertEquals(await getEvent(e.id), null);
});

Deno.test("update/delete of a missing event is a 404", async () => {
  await setup();
  const error = await assertRejects(
    () => deleteEvent({ eventId: "nope", userId: "alice", isAdmin: true }),
    HomeError,
  );
  assertEquals(error.status, 404);
});

Deno.test("listEvents validates its range", async () => {
  const { home } = await setup();
  for (
    const range of [
      { from: "2026-11-30", to: "2026-11-01" }, // reversed
      { from: "2026-11", to: "2026-11-30" }, // malformed
      { from: "2026-01-01", to: "2027-12-31" }, // too long
    ]
  ) {
    const error = await assertRejects(
      () => listEvents(home.id, range),
      HomeError,
    );
    assertEquals(error.status, 400);
  }
});
