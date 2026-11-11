import { assertEquals, assertThrows } from "@std/assert";
import {
  chunkStatements,
  insertStatement,
  sqlLiteral,
  topoOrder,
} from "./sql_dump.ts";

Deno.test("sqlLiteral escapes strings and encodes nulls/numbers/blobs", () => {
  assertEquals(sqlLiteral(null), "NULL");
  assertEquals(sqlLiteral(42), "42");
  assertEquals(sqlLiteral("it's"), "'it''s'");
  assertEquals(sqlLiteral(""), "''");
  assertEquals(sqlLiteral("改行\nあり"), "('改行' || char(10) || 'あり')");
  assertEquals(sqlLiteral("\r\n"), "(char(13) || char(10))");
  assertEquals(sqlLiteral(new Uint8Array([0, 255])), "X'00ff'");
});

Deno.test("insertStatement quotes identifiers", () => {
  assertEquals(
    insertStatement("users", ["id", "display_name"], ["u1", "A'B"]),
    `INSERT INTO "users" ("id", "display_name") VALUES ('u1', 'A''B');`,
  );
});

Deno.test("topoOrder puts referenced tables first and rejects cycles", () => {
  const order = topoOrder(["messages", "homes", "users", "threads"], {
    homes: ["users"],
    threads: ["homes", "users"],
    messages: ["threads", "homes", "users", "messages"],
  });
  assertEquals(order, ["users", "homes", "threads", "messages"]);
  assertThrows(() => topoOrder(["a", "b"], { a: ["b"], b: ["a"] }));
});

Deno.test("chunkStatements skips comments and splits by count", () => {
  const sql = "-- header\nA;\nB;\n\nC;\n";
  assertEquals(chunkStatements(sql, { maxStatements: 2 }), [["A;", "B;"], [
    "C;",
  ]]);
});
