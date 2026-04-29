import type { RecallResult, VectorEntry } from './types.js';

export interface MemoryIndex {
  init?(): Promise<void>;
  insert(entry: VectorEntry & { payloadRoot?: string }): Promise<void>;
  search(
    query: number[],
    opts?: {
      k?: number;
      namespace?: string;
      tombstonedIds?: Set<string>;
      tags?: string[];
      since?: string;
      until?: string;
      minScore?: number;
      recencyWeight?: number;
    }
  ): Promise<RecallResult[]>;
  remove(namespace: string, commitId: string): Promise<void>;
  merge(srcNamespace: string, dstNamespace: string): Promise<void>;
  /** Remove tombstoned entries (KV shards or Postgres rows) */
  gc(namespace: string, tombstonedIds: Set<string>): Promise<number>;
}
