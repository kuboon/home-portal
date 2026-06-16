import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { sanitizeThemeCss } from "./theme.ts";

Deno.test("sanitizeThemeCss keeps plain CSS", () => {
  const css = ".chat-bubble { background: #fad; border-radius: 12px; }";
  assertEquals(sanitizeThemeCss(css), css);
});

Deno.test("sanitizeThemeCss strips network-fetching and break-out constructs", () => {
  const out = sanitizeThemeCss(
    "@import url('http://evil/x.css');\n" +
      "body { background: url(http://evil/track.png); }\n" +
      "div { background: image-set('http://evil/a.png' 1x); }\n" +
      "/* x */ </style><script>alert(1)</script>",
  );
  assert(!/@import/i.test(out));
  assert(!/url\s*\(/i.test(out));
  assert(!/image-set/i.test(out));
  assert(!/<\/?(style|script)/i.test(out));
  assertStringIncludes(out, "background: none"); // url() replaced
});
