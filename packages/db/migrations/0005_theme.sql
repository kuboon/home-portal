-- 0005_theme — per-Home custom CSS theme.
--
-- A home admin can set custom CSS for the home. The value is sanitized before
-- storage to block network-fetching constructs (see server/theme.ts), so it
-- can be injected into the page without leaking requests.

ALTER TABLE homes ADD COLUMN theme_css TEXT NOT NULL DEFAULT '';
