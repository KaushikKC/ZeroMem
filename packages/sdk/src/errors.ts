/** Tried to write on a frozen replay snapshot */
export class ZeroMemFrozenError extends Error {
  constructor() {
    super('Cannot write to a frozen replay snapshot');
    this.name = 'ZeroMemFrozenError';
  }
}

/** Grant record not found in granter KV stream */
export class ZeroMemGrantNotFoundError extends Error {
  constructor(public readonly from: string, public readonly scope: string) {
    super(`No grant found from ${from} for scope '${scope}'`);
    this.name = 'ZeroMemGrantNotFoundError';
  }
}

/** Grant TTL has passed */
export class ZeroMemGrantExpiredError extends Error {
  constructor(public readonly from: string, public readonly scope: string) {
    super(`Grant from ${from} for scope '${scope}' has expired`);
    this.name = 'ZeroMemGrantExpiredError';
  }
}

/** 0G Storage upload/download/KV write failed after all retries */
export class ZeroMemStorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ZeroMemStorageError';
  }
}

/** KV head is null and no tip was provided for restore() */
export class ZeroMemNoTipError extends Error {
  constructor(public readonly branch: string) {
    super(
      `Cannot restore branch '${branch}': no tip commit found in KV. ` +
      `Pass the last known commitId: mem.restore('${branch}', { tipCommitId: '0x...' })`
    );
    this.name = 'ZeroMemNoTipError';
  }
}

/** remember() found a near-duplicate above the dedupe threshold */
export class ZeroMemDuplicateSkippedError extends Error {
  constructor(public readonly existingCommitId: string, public readonly score: number) {
    super(`Near-duplicate memory detected (score=${score.toFixed(3)}); returning existing commitId`);
    this.name = 'ZeroMemDuplicateSkippedError';
  }
}
