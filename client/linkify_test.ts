/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import { type Segment, splitLinks } from "./linkify.ts";

const t = (value: string): Segment => ({ type: "text", value });
const l = (value: string): Segment => ({ type: "link", value });

Deno.test("plain text stays one text segment", () => {
  assertEquals(splitLinks("こんにちは"), [t("こんにちは")]);
  assertEquals(splitLinks(""), []);
});

Deno.test("a URL in the middle is split out", () => {
  assertEquals(
    splitLinks("見て https://example.com/a?b=1&c=2#x ね"),
    [t("見て "), l("https://example.com/a?b=1&c=2#x"), t(" ね")],
  );
});

Deno.test("http and multiple URLs, including at the edges", () => {
  assertEquals(
    splitLinks("http://a.example/1\nhttps://b.example/2"),
    [l("http://a.example/1"), t("\n"), l("https://b.example/2")],
  );
});

Deno.test("Japanese text right after the URL ends it", () => {
  assertEquals(
    splitLinks("https://example.com/pathを見て"),
    [l("https://example.com/path"), t("を見て")],
  );
});

Deno.test("trailing sentence punctuation is not part of the link", () => {
  assertEquals(
    splitLinks(
      "これ https://example.com/x. そして (https://example.com/y), 終わり",
    ),
    [
      t("これ "),
      l("https://example.com/x"),
      t(". そして ("),
      l("https://example.com/y"),
      t("), 終わり"),
    ],
  );
});

Deno.test("a closing paren that balances one inside the URL is kept", () => {
  assertEquals(
    splitLinks("https://ja.wikipedia.org/wiki/Foo_(bar) です"),
    [l("https://ja.wikipedia.org/wiki/Foo_(bar)"), t(" です")],
  );
  assertEquals(
    splitLinks("(https://ja.wikipedia.org/wiki/Foo_(bar))"),
    [t("("), l("https://ja.wikipedia.org/wiki/Foo_(bar)"), t(")")],
  );
});

Deno.test("quotes and angle brackets end the URL", () => {
  assertEquals(
    splitLinks('<https://example.com/z> "https://example.com/q"'),
    [
      t("<"),
      l("https://example.com/z"),
      t('> "'),
      l("https://example.com/q"),
      t('"'),
    ],
  );
});

Deno.test("a bare scheme is left as text", () => {
  assertEquals(splitLinks("https:// だけ"), [t("https:// だけ")]);
});
