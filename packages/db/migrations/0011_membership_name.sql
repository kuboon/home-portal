-- 0011_membership_name — per-home display name.
--
-- A user can present a different name in each home. The name is stored on the
-- membership; NULL falls back to the user's global users.display_name. Captured
-- when joining (invite accept / home create) and editable per home. Additive
-- ADD COLUMN, so no table rebuild.

ALTER TABLE memberships ADD COLUMN display_name TEXT;
