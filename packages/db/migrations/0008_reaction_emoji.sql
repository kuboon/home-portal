-- 0008_reaction_emoji — rename reactions.stamp to reactions.emoji.
--
-- Terminology cleanup: the message-reaction feature was historically called
-- "stamp", but it is a reaction (an emoji on a message). The word "stamp" is
-- reserved for the future sticker feature (a standalone post chosen from a
-- per-user library). RENAME COLUMN preserves data and updates the primary key.

ALTER TABLE reactions RENAME COLUMN stamp TO emoji;
