/**
 * Sanitize admin-supplied theme CSS so it can be injected into the page
 * without leaking network requests (design: "network requests blocked").
 *
 * Removes the constructs that fetch or break out: `@import`, `url(...)`,
 * `image-set(...)`, CSS comments, and any `<style>`/`<script>` tag edges.
 * This is allow-by-default CSS with the dangerous bits stripped, not a full
 * CSS parser — paired with the page's CSP it keeps injected themes inert.
 */

export const MAX_THEME_CSS = 20_000;

export function sanitizeThemeCss(input: string): string {
  let css = input.slice(0, MAX_THEME_CSS);
  css = css.replace(/<\/?(?:style|script)/gi, ""); // no breaking out of <style>
  css = css.replace(/\/\*[\s\S]*?\*\//g, ""); // drop comments
  css = css.replace(/@import[^;]*;?/gi, ""); // no remote stylesheets
  css = css.replace(/url\s*\([^)]*\)/gi, "none"); // no url() fetches
  css = css.replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none");
  return css.trim();
}
