/**
 * Split plain text into text/link segments so a chat body can render its
 * `http(s)://` URLs as anchors without ever interpreting the rest as markup.
 *
 * Pure and DOM-free (unit-tested); the JSX lives in the caller.
 *
 * Boundaries follow how people actually paste URLs into chat:
 * - a URL runs over printable ASCII only, so it stops at whitespace and at
 *   the first Japanese character（例: 「https://x.jp/aを見て」→ /a まで）;
 * - `<>"'` and a backtick end it too (markup-ish quoting around a URL);
 * - trailing sentence punctuation is given back to the text (`.`, `,`, `)`
 *   …) — except a `)` that closes a `(` inside the URL, as in Wikipedia
 *   paths like `/wiki/Foo_(bar)`.
 */

export type Segment =
  | { type: "text"; value: string }
  | { type: "link"; value: string };

const URL_RE = /https?:\/\/[!-~]+/g;
const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/;

/** Give back the run of trailing punctuation that isn't part of the URL. */
function trimTrailing(url: string): string {
  const match = TRAILING_PUNCT.exec(url);
  if (!match) return url;
  let end = match.index;
  // A `)` closes an unmatched `(` inside the URL: keep it (and re-check the
  // punctuation that followed it). Repeat while the parens stay unbalanced.
  let tail = match[0];
  while (tail.startsWith(")")) {
    const head = url.slice(0, end);
    const opens = (head.match(/\(/g) ?? []).length;
    const closes = (head.match(/\)/g) ?? []).length;
    if (opens <= closes) break;
    end += 1;
    tail = tail.slice(1);
    // Anything after the kept `)` that isn't punctuation was already excluded
    // by the regex, so only punctuation can remain in `tail`.
  }
  return url.slice(0, end);
}

export function splitLinks(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimTrailing(m[0]);
    // A bare scheme with nothing after it is not a link.
    if (!/^https?:\/\/[!-~]/.test(url)) continue;
    const start = m.index;
    if (start > last) {
      out.push({ type: "text", value: text.slice(last, start) });
    }
    out.push({ type: "link", value: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
