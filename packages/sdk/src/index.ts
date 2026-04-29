export { ZeroMem } from './client.js';
export { StorageClient } from './storage.js';
export { KvViews } from './kv-views.js';
export { VectorIndex } from './vector.js';
export { InferenceClient } from './inference.js';
export { GrantManager } from './grant.js';
export { SkillsManager } from './skills.js';
export {
  buildCommit,
  signCommit,
  verifyCommit,
  encodeCommit,
  decodeCommit,
  storeCommit,
  loadCommit,
  walkCommits,
} from './commit.js';
export { diffBranches } from './git.js';
export {
  deriveKvSymKey,
  encryptKvText,
  decryptKvText,
  wrapKeyForRecipient,
  unwrapKey,
  createCapsule,
  verifyCapsule,
  encodeCapsule,
  decodeCapsule,
  createAccessChallenge,
  respondToChallenge,
  verifyChallenge,
  ACCESS_TIER_NAMESPACES,
  type MemoryCapsule,
  type AccessChallenge,
  type AccessTier,
} from './acl.js';
export {
  ZeroMemFrozenError,
  ZeroMemGrantNotFoundError,
  ZeroMemGrantExpiredError,
  ZeroMemStorageError,
  ZeroMemNoTipError,
  ZeroMemDuplicateSkippedError,
} from './errors.js';
export type {
  ZeroCommit,
  CommitOp,
  CommitMetadata,
  VectorEntry,
  RecallResult,
  SearchOpts,
  GrantRecord,
  Skill,
  Plan,
  PlanTask,
  ZeroMemConfig,
  MemStats,
  CommitProof,
  DiffResult,
  GcResult,
} from './types.js';
export { DEFAULTS } from './types.js';
