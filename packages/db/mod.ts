/**
 * `@scope/db` — Cloudflare D1 data layer for home portal.
 *
 * Re-exports the client accessor and table modules. The migration runner
 * (`./migrate.ts`) and the `node:sqlite` stand-in (`./sqlite.ts`) are
 * Deno-only and deliberately not re-exported, so the Worker bundle never
 * pulls them in.
 *
 * @module
 */

export {
  d1Client,
  type D1DatabaseLike,
  db,
  getD1,
  setDatabase,
  type SqlClient,
} from "./client.ts";
export {
  getUser,
  upsertUser,
  type UpsertUserInput,
  type User,
} from "./users.ts";
export {
  addMember,
  createHome,
  getHome,
  getRole,
  type Home,
  HomeError,
  type HomeWithRole,
  listHomesForUser,
  listMembers,
  MAX_MEMBERS,
  type Member,
  removeMember,
  type Role,
  setHomeTheme,
  setMemberName,
  setMemberRole,
} from "./homes.ts";
export {
  ARCHIVE_AFTER_DAYS,
  archiveStaleThreads,
  createThread,
  editMessage,
  getMessageContext,
  getThread,
  hideMessage,
  type ImageInput,
  type ImageRef,
  listMainMessages,
  listMessages,
  listThreads,
  listThreadsForViewer,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_MESSAGE_LENGTH,
  type Message,
  pickupIntoThread,
  postMessage,
  type QuoteRef,
  renameThread,
  repostMessage,
  type RepostOf,
  type StampRef,
  type Thread,
  type ThreadForViewer,
  tombstoneMessage,
} from "./threads.ts";
export {
  canUseStamp,
  createStamp,
  getStamp,
  type HomeStamp,
  type LibraryStamp,
  listHomeStamps,
  listLibrary,
  MAX_LIBRARY_STAMPS,
  MAX_STAMP_LABEL,
  removeFromLibrary,
  type Stamp,
  touchStamp,
} from "./stamps.ts";
export {
  joinedUserIds,
  joinThread,
  joinThreadMany,
  leaveThread,
  type ParticipantState,
} from "./participants.ts";
export {
  type Channel,
  MAX_REACTIONS_PER_MESSAGE,
  reactionsByMessage,
  type ReactionSummary,
  toggleReaction,
} from "./reactions.ts";
export {
  type Agent,
  createAgent,
  deleteAgent,
  getAgentIdByToken,
  getAgentOwner,
  listAgentsByOwner,
} from "./agents.ts";
