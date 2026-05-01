'use client';

import { useState, useCallback, useEffect } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

interface Hit { text: string; score: number; commitId: string; ts: number; tags: string[] }
interface CommitRow { commitId: string; text: string; op: string; branch: string; ns: string; ts: number; tags: string[] }
interface LogEntry { ts: number; label: string; payload: unknown; ok: boolean }

type Tab = 'memory' | 'git' | 'grants' | 'system' | 'skills';

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const OP_COLOR: Record<string, string> = {
  remember: 'text-green-400', reflect: 'text-purple-400',
  grant: 'text-blue-400', revoke: 'text-red-400',
  forget: 'text-orange-400', plan: 'text-yellow-400',
  skill_add: 'text-pink-400',
};

// ── Sub-components ───────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">{title}</h3>
      {children}
    </div>
  );
}

function Btn({ onClick, disabled, color = 'green', children }: {
  onClick: () => void; disabled?: boolean; color?: string; children: React.ReactNode
}) {
  const colors: Record<string, string> = {
    green: 'bg-green-700 hover:bg-green-600', blue: 'bg-blue-700 hover:bg-blue-600',
    purple: 'bg-purple-800 hover:bg-purple-700', red: 'bg-red-800 hover:bg-red-700',
    gray: 'bg-gray-700 hover:bg-gray-600', yellow: 'bg-yellow-700 hover:bg-yellow-600',
    pink: 'bg-pink-800 hover:bg-pink-700', orange: 'bg-orange-800 hover:bg-orange-700',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${colors[color] ?? colors.green} disabled:opacity-40 px-3 py-1.5 rounded text-xs font-bold transition-colors whitespace-nowrap`}
    >
      {children}
    </button>
  );
}

function Input({ value, onChange, placeholder, mono = true }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 outline-none focus:border-gray-500 placeholder-gray-600 ${mono ? 'font-mono' : ''}`}
    />
  );
}

function Textarea({ value, onChange, placeholder, rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 outline-none resize-none focus:border-gray-500 placeholder-gray-600 font-mono"
    />
  );
}

function HitCard({ hit }: { hit: Hit }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 border border-gray-700">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span className="font-mono">{hit.commitId?.slice(0, 10)}…</span>
        <span className="text-green-400 font-bold">{(hit.score * 100).toFixed(1)}%</span>
      </div>
      <p className="text-sm text-gray-200 leading-relaxed">{hit.text}</p>
      {hit.tags?.length > 0 && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {hit.tags.map((t, i) => <span key={i} className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">{t}</span>)}
        </div>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab] = useState<Tab>('memory');
  const [agentId, setAgentId] = useState('agent-a');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [kvMode, setKvMode] = useState<'unknown' | 'on-chain' | 'in-memory'>('unknown');
  const [walletAddr, setWalletAddr] = useState('');
  const [walletPubKey, setWalletPubKey] = useState('');

  // Memory state
  const [memText, setMemText] = useState('');
  const [memNs, setMemNs] = useState('');
  const [memTags, setMemTags] = useState('');
  const [query, setQuery] = useState('');
  const [question, setQuestion] = useState('');
  const [searchOpts, setSearchOpts] = useState({ since: '', minScore: '', tags: '' });
  const [recallHits, setRecallHits] = useState<Hit[]>([]);
  const [askHits, setAskHits] = useState<Hit[]>([]);
  const [searchHits, setSearchHits] = useState<Hit[]>([]);
  const [answer, setAnswer] = useState('');
  const [forgetId, setForgetId] = useState('');

  // Git state
  const [commits, setCommits] = useState<CommitRow[]>([]);
  const [newBranch, setNewBranch] = useState('');
  const [mergeBranch, setMergeBranch] = useState('');
  const [diffA, setDiffA] = useState('main');
  const [diffB, setDiffB] = useState('');
  const [diffResult, setDiffResult] = useState<any>(null);
  const [blameKw, setBlameKw] = useState('');
  const [blameResult, setBlameResult] = useState<any[]>([]);
  const [snapshotName, setSnapshotName] = useState('');

  // Grant state
  const [grantTo, setGrantTo] = useState('');
  const [grantToPubKey, setGrantToPubKey] = useState('');
  const [grantScope, setGrantScope] = useState('default');
  const [grantTtl, setGrantTtl] = useState('24h');
  const [grantTier, setGrantTier] = useState('READ_FULL');
  const [grantId, setGrantId] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const [recallFrom, setRecallFrom] = useState('');
  const [crossQuery, setCrossQuery] = useState('');
  const [crossHits, setCrossHits] = useState<Hit[]>([]);
  // Challenge-response (verified grant)
  const [challenge, setChallenge] = useState('');
  const [recipientPrivKey, setRecipientPrivKey] = useState('');
  const [challengeProof, setChallengeProof] = useState('');
  const [challengeSignerAddr, setChallengeSignerAddr] = useState('');
  const [verifiedGrantId, setVerifiedGrantId] = useState('');
  // Batch grant
  const [batchRecipients, setBatchRecipients] = useState('');
  const [batchGrantIds, setBatchGrantIds] = useState<string[]>([]);
  // forgetBulk
  const [bulkTags, setBulkTags] = useState('');
  const [bulkOlderThan, setBulkOlderThan] = useState('');
  const [bulkNs, setBulkNs] = useState('');
  const [bulkResult, setBulkResult] = useState<number | null>(null);
  // replay
  const [replayCommitId, setReplayCommitId] = useState('');
  const [replayBranch, setReplayBranch] = useState('');

  // System state
  const [stats, setStats] = useState<any>(null);
  const [gcResult, setGcResult] = useState<any>(null);
  const [proveId, setProveId] = useState('');
  const [proofResult, setProofResult] = useState<any>(null);
  const [restoreTip, setRestoreTip] = useState('');

  // Skills state
  const [skillName, setSkillName] = useState('summarize');
  const [skillCode, setSkillCode] = useState(`const lines = input.text.split('\\n').filter(Boolean);
return { summary: lines.slice(0, 3).join(' | ') };`);
  const [skillInput, setSkillInput] = useState('{"text":"line1\\nline2\\nline3"}');
  const [skillList, setSkillList] = useState<string[]>([]);
  const [skillResult, setSkillResult] = useState('');

  // Plan state
  const [planGoal, setPlanGoal] = useState('');
  const [plan, setPlan] = useState<any>(null);

  const log = useCallback((label: string, payload: unknown, ok = true) => {
    setActivityLog(prev => [{ ts: Date.now(), label, payload, ok }, ...prev].slice(0, 50));
  }, []);

  const call = useCallback(async (action: string, body: object) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/zeromem/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, branch, ...body }),
      });
      const data = await res.json();
      if (data.error) { log(action, data, false); throw new Error(data.error); }
      // Track KV mode from server responses
      if (data._warn?.includes('KV node')) setKvMode('in-memory');
      else if (action === 'health') setKvMode(data.kvNodeDown ? 'in-memory' : 'on-chain');
      log(action, data, true);
      return data;
    } finally {
      setLoading(false);
    }
  }, [agentId, branch, log]);

  // Check health + wallet on first load / agent change
  const checkHealth = useCallback(async () => {
    try {
      const [hRes, aRes] = await Promise.all([
        fetch('/api/zeromem/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, branch }) }),
        fetch('/api/zeromem/address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, branch }) }),
      ]);
      const h = await hRes.json();
      const a = await aRes.json();
      setKvMode(h.kvNodeDown ? 'in-memory' : 'on-chain');
      setWalletAddr(a.address ?? '');
      setWalletPubKey(a.pubKey ?? '');
    } catch {}
  }, [agentId, branch]);

  // Auto-check health on load and when agentId changes
  useEffect(() => { checkHealth(); }, [agentId]); // eslint-disable-line

  const refreshLog = useCallback(async () => {
    const data = await call('log', { limit: 15 });
    setCommits(data.commits ?? []);
  }, [call]);

  // ── Tab: Memory ─────────────────────────────────────────────────────────────

  const MemoryTab = (
    <div className="grid grid-cols-1 gap-4">

      <Card title="mem.remember() — Store a memory">
        <Textarea value={memText} onChange={setMemText} placeholder="Type something to remember…" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={memNs} onChange={setMemNs} placeholder="Namespace (default)" />
          <Input value={memTags} onChange={setMemTags} placeholder="Tags comma-separated" />
        </div>
        <div className="flex gap-2">
          <Btn onClick={async () => {
            const d = await call('remember', {
              text: memText,
              ns: memNs || undefined,
              tags: memTags ? memTags.split(',').map(s => s.trim()) : undefined,
            });
            setMemText('');
            await refreshLog();
          }} disabled={loading || !memText.trim()}>mem.remember()</Btn>
        </div>
      </Card>

      <Card title="mem.recall() — Semantic search">
        <div className="flex gap-2">
          <Input value={query} onChange={v => { setQuery(v); setRecallHits([]); }} placeholder="Search query…" />
          <Btn color="blue" onClick={async () => {
            const d = await call('recall', { query, k: 5, ns: memNs || undefined });
            setRecallHits(d.hits ?? []);
          }} disabled={loading || !query.trim()}>recall()</Btn>
        </div>
        {recallHits.length > 0 && (
          <p className="text-xs text-gray-600">{recallHits.length} result{recallHits.length !== 1 ? 's' : ''}</p>
        )}
        {recallHits.map((h, i) => <HitCard key={i} hit={h} />)}
      </Card>

      <Card title="mem.ask() — RAG answer from memories">
        <div className="flex gap-2">
          <Input value={question} onChange={v => { setQuestion(v); setAskHits([]); setAnswer(''); }} placeholder="Ask a question…" />
          <Btn color="purple" onClick={async () => {
            const d = await call('ask', { question, k: 5 });
            setAnswer(d.answer ?? '');
            setAskHits(d.hits ?? []);
          }} disabled={loading || !question.trim()}>ask()</Btn>
        </div>
        {answer && (
          <div className="bg-gray-800 rounded p-3 border border-purple-900">
            <p className="text-xs text-purple-400 mb-1">Answer</p>
            <p className="text-sm text-gray-100">{answer}</p>
          </div>
        )}
        {askHits.length > 0 && <p className="text-xs text-gray-600">Context memories used:</p>}
        {askHits.map((h, i) => <HitCard key={i} hit={h} />)}
      </Card>

      <Card title="mem.search() — Search with filters">
        <div className="flex gap-2">
          <Input value={query} onChange={v => { setQuery(v); setSearchHits([]); }} placeholder="Query…" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input value={searchOpts.since} onChange={v => setSearchOpts(s => ({ ...s, since: v }))} placeholder="since: 7d / 1h" />
          <Input value={searchOpts.minScore} onChange={v => setSearchOpts(s => ({ ...s, minScore: v }))} placeholder="minScore: 0.4" />
          <Input value={searchOpts.tags} onChange={v => setSearchOpts(s => ({ ...s, tags: v }))} placeholder="tags: 0g,storage" />
        </div>
        <Btn color="blue" onClick={async () => {
          const d = await call('search', {
            query,
            since: searchOpts.since || undefined,
            minScore: searchOpts.minScore || undefined,
            tags: searchOpts.tags ? searchOpts.tags.split(',').map(s => s.trim()) : undefined,
          });
          setSearchHits(d.hits ?? []);
        }} disabled={loading || !query.trim()}>mem.search()</Btn>
        {searchHits.length > 0 && (
          <p className="text-xs text-gray-600">{searchHits.length} result{searchHits.length !== 1 ? 's' : ''}</p>
        )}
        {searchHits.map((h, i) => <HitCard key={i} hit={h} />)}
      </Card>

      <Card title="mem.forget() — Tombstone a single commit">
        <div className="flex gap-2">
          <Input value={forgetId} onChange={setForgetId} placeholder="commitId to forget (0x…)" />
          <Btn color="red" onClick={async () => {
            await call('forget', { commitId: forgetId });
            setForgetId('');
          }} disabled={loading || !forgetId.trim()}>forget()</Btn>
        </div>
      </Card>

      <Card title="mem.forgetBulk() — Tombstone by tags / age">
        <p className="text-xs text-gray-500">Bulk-tombstone memories matching criteria. Run <code className="text-orange-400">gc()</code> after to reclaim KV space.</p>
        <div className="grid grid-cols-3 gap-2">
          <Input value={bulkTags} onChange={setBulkTags} placeholder="tags: session,temp" />
          <Input value={bulkOlderThan} onChange={setBulkOlderThan} placeholder="olderThan: 30d / 7d" />
          <Input value={bulkNs} onChange={setBulkNs} placeholder="namespace (default)" />
        </div>
        <div className="flex gap-2 items-center">
          <Btn color="red" onClick={async () => {
            const d = await call('forgetBulk', {
              tags: bulkTags ? bulkTags.split(',').map(s => s.trim()) : undefined,
              olderThan: bulkOlderThan || undefined,
              ns: bulkNs || undefined,
            });
            setBulkResult(d.removed ?? 0);
          }} disabled={loading}>forgetBulk()</Btn>
          {bulkResult !== null && (
            <span className="text-xs text-orange-400">{bulkResult} memories tombstoned</span>
          )}
        </div>
      </Card>

    </div>
  );

  // ── Tab: Git ─────────────────────────────────────────────────────────────────

  const GitTab = (
    <div className="grid grid-cols-1 gap-4">

      <Card title="Commit Log — mem.log()">
        <Btn color="gray" onClick={refreshLog} disabled={loading}>Refresh log</Btn>
        {commits.length > 0 && (
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {commits.map((c, i) => (
              <div key={i} className="flex gap-2 text-xs font-mono bg-gray-800 rounded px-2 py-1.5 items-center">
                <span className="text-yellow-500 shrink-0">{c.commitId?.slice(0, 8)}…</span>
                <span className={`${OP_COLOR[c.op] ?? 'text-gray-400'} shrink-0 w-16`}>[{c.op}]</span>
                <span className="text-gray-500 shrink-0">{c.branch}</span>
                <span className="text-gray-300 flex-1 truncate">{c.text}</span>
                <span className="text-gray-600 shrink-0">{timeAgo(c.ts)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="mem.branch() — Fork current HEAD">
          <Input value={newBranch} onChange={setNewBranch} placeholder="new-branch-name" />
          <Btn color="blue" onClick={async () => {
            const d = await call('branch', { name: newBranch });
            setBranch(d.currentBranch);
            setNewBranch('');
          }} disabled={loading || !newBranch.trim()}>branch()</Btn>
        </Card>

        <Card title="mem.merge() — Merge branch in">
          <Input value={mergeBranch} onChange={setMergeBranch} placeholder="branch to merge from" />
          <select
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 outline-none"
            onChange={e => setMergeBranch(e.target.value)}
          >
            <option value="fast-forward">fast-forward</option>
            <option value="reflect">reflect (sealed inference)</option>
          </select>
          <Btn color="purple" onClick={async () => {
            await call('merge', { from: mergeBranch });
            await refreshLog();
          }} disabled={loading || !mergeBranch.trim()}>merge()</Btn>
        </Card>
      </div>

      <Card title="mem.diff() — Compare two branches">
        <div className="grid grid-cols-2 gap-2">
          <Input value={diffA} onChange={setDiffA} placeholder="branch A" />
          <Input value={diffB} onChange={setDiffB} placeholder="branch B" />
        </div>
        <Btn onClick={async () => {
          const d = await call('diff', { branchA: diffA, branchB: diffB });
          setDiffResult(d);
        }} disabled={loading || !diffA || !diffB}>diff()</Btn>
        {diffResult && (
          <div className="text-xs font-mono space-y-1">
            <p className="text-gray-500">Diverged at: <span className="text-yellow-400">{diffResult.divergedAt?.slice(0, 12) ?? 'none'}…</span></p>
            <p className="text-green-400">Only in {diffA}: {diffResult.onlyInA?.length ?? 0} commits</p>
            <p className="text-blue-400">Only in {diffB}: {diffResult.onlyInB?.length ?? 0} commits</p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="mem.blame() — Who wrote what">
          <Input value={blameKw} onChange={setBlameKw} placeholder="keyword to search" />
          <Btn color="orange" onClick={async () => {
            const d = await call('blame', { keyword: blameKw });
            setBlameResult(d.matches ?? []);
          }} disabled={loading || !blameKw.trim()}>blame()</Btn>
          {blameResult.map((m, i) => (
            <div key={i} className="text-xs font-mono text-gray-400">
              <span className="text-yellow-500">{m.commitId?.slice(0, 10)}…</span> [{m.op}] {timeAgo(m.ts)}
            </div>
          ))}
        </Card>

        <Card title="mem.snapshot() — Named checkpoint">
          <Input value={snapshotName} onChange={setSnapshotName} placeholder="snapshot name" />
          <div className="flex gap-2">
            <Btn onClick={async () => {
              await call('snapshot', { name: snapshotName });
            }} disabled={loading || !snapshotName.trim()}>snapshot()</Btn>
            <Btn color="gray" onClick={async () => {
              const d = await call('checkout', { name: snapshotName });
              setSnapshotName('');
            }} disabled={loading || !snapshotName.trim()}>checkout()</Btn>
          </div>
        </Card>
      </div>

      <Card title="mem.replay() — Time-travel to a specific commit (frozen read-only)">
        <p className="text-xs text-gray-500">Opens a frozen, read-only view of the agent's memory at any historical commitId. Paste a commitId from the log above.</p>
        <div className="flex gap-2">
          <Input value={replayCommitId} onChange={setReplayCommitId} placeholder="commitId (0x…) — paste from log" />
          <Btn color="yellow" onClick={async () => {
            const d = await call('replay', { commitId: replayCommitId });
            setReplayBranch(d.branch ?? '');
          }} disabled={loading || !replayCommitId.trim()}>replay()</Btn>
        </div>
        {replayBranch && (
          <div className="bg-gray-800 rounded p-3 text-xs font-mono space-y-1 border border-yellow-900">
            <p className="text-yellow-400">🔒 Frozen snapshot created</p>
            <p className="text-gray-400">Snapshot branch: <span className="text-yellow-300">{replayBranch}</span></p>
            <p className="text-gray-500">Switch to this branch in the header to query the frozen state. Writes are blocked.</p>
          </div>
        )}
      </Card>

    </div>
  );

  // ── Tab: Grants ──────────────────────────────────────────────────────────────

  const GrantsTab = (
    <div className="grid grid-cols-1 gap-4">

      <Card title="mem.grant() — Give another agent access">
        <div className="grid grid-cols-2 gap-2">
          <Input value={grantTo} onChange={setGrantTo} placeholder="Recipient wallet address (0x…)" />
          <Input value={grantToPubKey} onChange={setGrantToPubKey} placeholder="Recipient compressed pubkey (02…)" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input value={grantScope} onChange={setGrantScope} placeholder="scope" />
          <Input value={grantTtl} onChange={setGrantTtl} placeholder="TTL: 24h / 7d" />
          <select
            value={grantTier}
            onChange={e => setGrantTier(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 outline-none"
          >
            <option value="READ_SEMANTIC">READ_SEMANTIC — summaries only</option>
            <option value="READ_FULL">READ_FULL — all namespaces</option>
            <option value="ADMIN">ADMIN — can delegate</option>
          </select>
        </div>
        <div className="flex gap-2 items-center">
          <Btn color="blue" onClick={async () => {
            const d = await call('grant', {
              to: grantTo, toPubKey: grantToPubKey || undefined,
              scope: grantScope, ttl: grantTtl, tier: grantTier,
            });
            setGrantId(d.grantId ?? '');
          }} disabled={loading || !grantTo.trim()}>mem.grant()</Btn>
          {grantId && <span className="text-xs font-mono text-green-400 truncate">grantId: {grantId.slice(0, 20)}…</span>}
        </div>
      </Card>

      <Card title="Challenge-Response — Verified grant (wallet-ownership proof)">
        <p className="text-xs text-gray-500">3-step flow: granter creates nonce → recipient signs with their key → granter verifies + issues grant.</p>

        {/* Step 1 */}
        <div className="border border-gray-700 rounded-lg p-3 space-y-2">
          <p className="text-xs text-blue-400 font-bold">Step 1 — Granter: create challenge</p>
          <div className="grid grid-cols-2 gap-2">
            <Input value={grantTo} onChange={setGrantTo} placeholder="Recipient address (0x…)" />
            <Input value={grantScope} onChange={setGrantScope} placeholder="scope (default)" />
          </div>
          <Btn onClick={async () => {
            const d = await call('createChallenge', { recipientAddress: grantTo, scope: grantScope });
            setChallenge(JSON.stringify(d.challenge, null, 2));
            setChallengeProof('');
            setChallengeSignerAddr('');
          }} disabled={loading || !grantTo.trim()}>1. createChallenge()</Btn>
          {challenge && (
            <Textarea value={challenge} onChange={setChallenge} rows={4} placeholder="Challenge JSON appears here…" />
          )}
        </div>

        {/* Step 2 */}
        <div className="border border-gray-700 rounded-lg p-3 space-y-2">
          <p className="text-xs text-green-400 font-bold">Step 2 — Recipient: sign the challenge</p>
          <p className="text-xs text-gray-500">Paste the recipient's private key (WRITER_PRIVATE_KEY or RESEARCHER_PRIVATE_KEY from .env). In production this is done client-side by the recipient.</p>
          <Input
            value={recipientPrivKey}
            onChange={setRecipientPrivKey}
            placeholder="Recipient private key (0x64hexchars) — WRITER_PRIVATE_KEY"
          />
          <Btn color="gray" onClick={async () => {
            if (!challenge.trim()) return;
            const challengeObj = JSON.parse(challenge.match(/\{[\s\S]*\}/)?.[0] ?? challenge);
            const d = await call('signChallenge', {
              challenge: challengeObj,
              recipientPrivKey,
            });
            setChallengeProof(d.proof ?? '');
            setChallengeSignerAddr(d.signerAddress ?? '');
          }} disabled={loading || !challenge.trim() || !recipientPrivKey.trim()}>2. signChallenge()</Btn>
          {challengeSignerAddr && (
            <p className="text-xs text-green-400">✓ Signed by: <span className="font-mono">{challengeSignerAddr}</span></p>
          )}
          {challengeProof && (
            <p className="text-xs font-mono text-gray-400 break-all">proof: {challengeProof.slice(0, 30)}…</p>
          )}
        </div>

        {/* Step 3 */}
        <div className="border border-gray-700 rounded-lg p-3 space-y-2">
          <p className="text-xs text-purple-400 font-bold">Step 3 — Granter: verify proof + issue grant</p>
          <div className="grid grid-cols-2 gap-2">
            <Input value={grantToPubKey} onChange={setGrantToPubKey} placeholder="Recipient pubkey (02…)" />
            <Input value={grantTtl} onChange={setGrantTtl} placeholder="TTL: 24h" />
          </div>
          <div className="flex gap-2 items-center">
            <Btn color="purple" onClick={async () => {
              if (!challenge.trim() || !challengeProof) return;
              const challengeObj = JSON.parse(challenge.match(/\{[\s\S]*\}/)?.[0] ?? challenge);
              const d = await call('grantVerified', {
                challenge: challengeObj,
                proof: challengeProof,
                toPubKey: grantToPubKey || undefined,
                ttl: grantTtl,
                tier: grantTier,
              });
              setVerifiedGrantId(d.grantId ?? '');
            }} disabled={loading || !challengeProof}>3. grantVerified()</Btn>
            {verifiedGrantId && (
              <span className="text-xs text-green-400 font-mono truncate">✓ {verifiedGrantId.slice(0, 20)}…</span>
            )}
          </div>
        </div>
      </Card>

      <Card title="mem.batchGrant() — Grant access to multiple wallets at once">
        <p className="text-xs text-gray-500">One line per recipient. Format: <code className="text-blue-400">0xAddress:0x02PubKey</code></p>
        <Textarea
          value={batchRecipients}
          onChange={setBatchRecipients}
          placeholder={"0xAddress1:02PubKey1\n0xAddress2:02PubKey2"}
          rows={3}
        />
        <div className="grid grid-cols-3 gap-2">
          <Input value={grantScope} onChange={setGrantScope} placeholder="scope" />
          <Input value={grantTtl} onChange={setGrantTtl} placeholder="TTL: 24h" />
          <select
            value={grantTier}
            onChange={e => setGrantTier(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 outline-none"
          >
            <option value="READ_SEMANTIC">READ_SEMANTIC</option>
            <option value="READ_FULL">READ_FULL</option>
            <option value="ADMIN">ADMIN</option>
          </select>
        </div>
        <div className="flex gap-2 items-start flex-wrap">
          <Btn color="blue" onClick={async () => {
            const lines = batchRecipients.trim().split('\n').filter(Boolean);
            const recipients = lines.map(line => {
              const [address, pubKey] = line.split(':').map(s => s.trim());
              return { address, pubKey: pubKey ?? '' };
            });
            if (recipients.length === 0) return;
            const d = await call('batchGrant', {
              recipients,
              scope: grantScope,
              ttl: grantTtl,
              tier: grantTier,
            });
            setBatchGrantIds(d.grantIds ?? []);
          }} disabled={loading || !batchRecipients.trim()}>batchGrant()</Btn>
          {batchGrantIds.length > 0 && (
            <div className="flex flex-col gap-1">
              {batchGrantIds.map((id, i) => (
                <span key={i} className="text-xs font-mono text-green-400">✓ {id.slice(0, 20)}…</span>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="mem.revoke() — Cancel a grant">
          <Input value={revokeId} onChange={setRevokeId} placeholder="grantId to revoke (0x…)" />
          <div className="grid grid-cols-2 gap-2">
            <Input value={grantScope} onChange={setGrantScope} placeholder="scope" />
            <Input value={grantTo} onChange={setGrantTo} placeholder="recipient address" />
          </div>
          <Btn color="red" onClick={async () => {
            await call('revoke', { grantId: revokeId, scope: grantScope, to: grantTo });
            setRevokeId('');
          }} disabled={loading || !revokeId.trim()}>revoke()</Btn>
        </Card>

        <Card title="Cross-agent recall — Read another agent's memory">
          <Input value={recallFrom} onChange={setRecallFrom} placeholder="Granter wallet address (0x…)" />
          <Input value={crossQuery} onChange={setCrossQuery} placeholder="What to look for…" />
          <Btn color="blue" onClick={async () => {
            const d = await call('recall', { query: crossQuery, from: recallFrom, k: 5 });
            setCrossHits(d.hits ?? []);
          }} disabled={loading || !recallFrom.trim() || !crossQuery.trim()}>recall(from:)</Btn>
          {crossHits.map((h, i) => <HitCard key={i} hit={h} />)}
        </Card>
      </div>

    </div>
  );

  // ── Tab: System ──────────────────────────────────────────────────────────────

  const SystemTab = (
    <div className="grid grid-cols-1 gap-4">

      <Card title="mem.stats() — Memory usage overview">
        <Btn color="gray" onClick={async () => {
          const d = await call('stats', {});
          setStats(d.stats);
        }} disabled={loading}>Load stats</Btn>
        {stats && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-800 rounded p-3">
              <p className="text-xs text-gray-500 mb-1">Agent</p>
              <p className="text-green-400 font-mono">{stats.agentId}</p>
              <p className="text-gray-400">Branch: {stats.currentBranch}</p>
              <p className="text-gray-400">Total memories: <span className="text-white">{stats.approxTotalMemories}</span></p>
            </div>
            <div className="bg-gray-800 rounded p-3">
              <p className="text-xs text-gray-500 mb-1">Branches</p>
              {stats.branches?.map((b: string, i: number) => (
                <p key={i} className="text-blue-400 font-mono text-xs">{b}</p>
              ))}
            </div>
            <div className="bg-gray-800 rounded p-3">
              <p className="text-xs text-gray-500 mb-1">Skills</p>
              {stats.skills?.length > 0
                ? stats.skills.map((s: string, i: number) => <p key={i} className="text-pink-400 text-xs">{s}</p>)
                : <p className="text-gray-600 text-xs">No skills yet</p>}
            </div>
            <div className="bg-gray-800 rounded p-3">
              <p className="text-xs text-gray-500 mb-1">Namespaces</p>
              {Object.entries(stats.namespaceStats ?? {}).map(([k, v]) => (
                <p key={k} className="text-yellow-400 text-xs font-mono">{k}: {v as number}</p>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="mem.reflect() — Episodic → Semantic compaction">
        <div className="flex gap-2 items-center">
          <Input value={searchOpts.since} onChange={v => setSearchOpts(s => ({ ...s, since: v }))} placeholder="since: 1h / 24h (default 1h)" />
          <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
            <input type="checkbox" className="accent-purple-500" onChange={e => {}} />
            Force reprocess
          </label>
        </div>
        <Btn color="purple" onClick={async () => {
          const d = await call('reflect', { since: searchOpts.since || '1h' });
        }} disabled={loading}>mem.reflect()</Btn>
      </Card>

      <Card title="mem.gc() — Garbage collect tombstoned entries">
        <p className="text-xs text-gray-500">Removes tombstoned entries from all KV shards. Run after mem.forget() to reclaim storage.</p>
        <Btn color="orange" onClick={async () => {
          const d = await call('gc', {});
          setGcResult(d);
        }} disabled={loading}>mem.gc()</Btn>
        {gcResult && (
          <p className="text-sm text-orange-400">Removed {gcResult.removed} entries from {gcResult.namespacesScanned?.length} namespaces</p>
        )}
      </Card>

      <Card title="mem.prove() — Generate Merkle attestation">
        <div className="flex gap-2">
          <Input value={proveId} onChange={setProveId} placeholder="commitId (0x…)" />
          <Btn onClick={async () => {
            const d = await call('prove', { commitId: proveId });
            setProofResult(d.proof);
          }} disabled={loading || !proveId.trim()}>prove()</Btn>
        </div>
        {proofResult && (
          <div className="bg-gray-800 rounded p-3 text-xs font-mono space-y-1">
            <p><span className="text-gray-500">agentAddr:</span> <span className="text-green-400">{proofResult.agentAddress}</span></p>
            <p><span className="text-gray-500">op:</span> <span className={OP_COLOR[proofResult.op] ?? 'text-gray-300'}>{proofResult.op}</span></p>
            <p><span className="text-gray-500">branch:</span> <span className="text-blue-400">{proofResult.branch}</span></p>
            <p><span className="text-gray-500">provedAt:</span> {new Date(proofResult.provedAt).toISOString()}</p>
            <p><span className="text-gray-500">sig:</span> <span className="text-yellow-400 break-all">{proofResult.attestationSig?.slice(0, 40)}…</span></p>
            {proofResult.storageExplorerUrl && (
              <a href={proofResult.storageExplorerUrl} target="_blank" rel="noreferrer"
                className="text-blue-400 underline block mt-1">View on 0G StorageScan →</a>
            )}
          </div>
        )}
      </Card>

      <Card title="mem.restore() — Rebuild KV from 0G blob DAG">
        <p className="text-xs text-gray-500">Rebuilds the KV index after a wipe. Provide the last known commitId (or leave blank if KV head survives).</p>
        <Input value={restoreTip} onChange={setRestoreTip} placeholder="tipCommitId (optional, 0x…)" />
        <Btn color="red" onClick={async () => {
          await call('restore', { branch, tipCommitId: restoreTip || undefined });
          await refreshLog();
        }} disabled={loading}>mem.restore()</Btn>
      </Card>

    </div>
  );

  // ── Tab: Skills & Plans ──────────────────────────────────────────────────────

  const SkillsTab = (
    <div className="grid grid-cols-1 gap-4">

      <Card title="mem.skills.add() — Register a signed skill blob">
        <Input value={skillName} onChange={setSkillName} placeholder="skill name" />
        <Textarea
          value={skillCode}
          onChange={setSkillCode}
          placeholder="JavaScript code. Access input as 'input'."
          rows={5}
        />
        <div className="flex gap-2">
          <Btn color="pink" onClick={async () => {
            const d = await call('skillAdd', { name: skillName, code: skillCode });
          }} disabled={loading || !skillName.trim() || !skillCode.trim()}>skills.add()</Btn>
          <Btn color="gray" onClick={async () => {
            const d = await call('skillList', {});
            setSkillList(d.skills ?? []);
          }} disabled={loading}>skills.list()</Btn>
        </div>
        {skillList.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {skillList.map((s, i) => (
              <span key={i} onClick={() => setSkillName(s)}
                className="text-xs bg-pink-900 text-pink-300 px-2 py-0.5 rounded cursor-pointer hover:bg-pink-800">{s}</span>
            ))}
          </div>
        )}
      </Card>

      <Card title="mem.skills.run() — Execute a skill">
        <div className="grid grid-cols-2 gap-2">
          <Input value={skillName} onChange={setSkillName} placeholder="skill name" />
          <Input value={skillInput} onChange={setSkillInput} placeholder='JSON input e.g. {"text":"…"}' />
        </div>
        <Btn color="pink" onClick={async () => {
          const d = await call('skillRun', { name: skillName, input: JSON.parse(skillInput || '{}') });
          setSkillResult(JSON.stringify(d.result, null, 2));
        }} disabled={loading || !skillName.trim()}>skills.run()</Btn>
        {skillResult && (
          <pre className="bg-gray-800 rounded p-3 text-xs text-green-400 overflow-x-auto">{skillResult}</pre>
        )}
      </Card>

      <Card title="mem.plan() — Hierarchical task planner">
        <div className="flex gap-2">
          <Input value={planGoal} onChange={setPlanGoal} placeholder="Goal: write release notes for v2…" />
          <Btn color="yellow" onClick={async () => {
            const d = await call('plan', { goal: planGoal });
            setPlan(d.plan);
          }} disabled={loading || !planGoal.trim()}>plan()</Btn>
        </div>
        {plan && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">commitId: <span className="text-yellow-400 font-mono">{plan.commitId?.slice(0, 16)}…</span></p>
            {plan.tasks?.map((t: any, i: number) => (
              <div key={i} className="flex gap-2 items-center bg-gray-800 rounded p-2">
                <span className={`text-lg ${t.done ? '✅' : '⬜'}`}>{t.done ? '✅' : '⬜'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200">{t.description}</p>
                  {t.dependsOn?.length > 0 && <p className="text-xs text-gray-500">depends on: {t.dependsOn.join(', ')}</p>}
                </div>
                {!t.done && (
                  <Btn color="gray" onClick={async () => {
                    const d = await call('completePlanTask', { planCommitId: plan.commitId, taskId: t.id });
                    const updated = await call('getPlan', { commitId: d.commitId });
                    setPlan(updated.plan);
                  }} disabled={loading}>✓</Btn>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

    </div>
  );

  // ── Layout ───────────────────────────────────────────────────────────────────

  const TABS: { id: Tab; label: string; color: string }[] = [
    { id: 'memory', label: 'Memory', color: 'text-green-400' },
    { id: 'git', label: 'Git', color: 'text-yellow-400' },
    { id: 'grants', label: 'Grants', color: 'text-blue-400' },
    { id: 'system', label: 'System', color: 'text-purple-400' },
    { id: 'skills', label: 'Skills & Plans', color: 'text-pink-400' },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-mono flex flex-col">

      {/* Top bar */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-6 sticky top-0 bg-gray-950 z-10">
        <div>
          <span className="text-green-400 font-bold text-lg">ZeroMem</span>
          <span className="text-gray-600 text-xs ml-2">Git-for-Agent-Memory · 0G Galileo</span>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <span className="text-xs text-gray-500">agent:</span>
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-green-300 outline-none w-32 font-mono"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">branch:</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-yellow-300 outline-none w-28 font-mono"
          />
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {loading && <span className="text-yellow-400 animate-pulse">● working…</span>}
          {walletAddr && (
            <span
              className="text-gray-400 font-mono cursor-pointer hover:text-green-400"
              title={`Wallet: ${walletAddr}\nPubKey: ${walletPubKey}\nClick to copy address`}
              onClick={() => navigator.clipboard?.writeText(walletAddr)}
            >
              {walletAddr.slice(0, 6)}…{walletAddr.slice(-4)}
            </span>
          )}
          {kvMode === 'in-memory' && (
            <span className="bg-yellow-900 text-yellow-300 px-2 py-0.5 rounded font-bold" title="KV node unreachable — data lives in-memory this session. Blobs are on 0G.">
              ⚠ KV: in-memory
            </span>
          )}
          {kvMode === 'on-chain' && (
            <span className="bg-green-900 text-green-300 px-2 py-0.5 rounded font-bold">
              ✓ KV: on-chain
            </span>
          )}
          <button onClick={checkHealth} className="text-gray-600 hover:text-gray-400" title="Refresh status">⟳</button>
          <span className="text-gray-700">GrantRegistry: 0xAa14…57ec</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar navigation */}
        <nav className="w-44 border-r border-gray-800 p-3 space-y-1 shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                tab === t.id
                  ? `bg-gray-800 ${t.color} font-bold`
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-900'
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="pt-4 border-t border-gray-800 mt-4">
            <p className="text-xs text-gray-600 px-3 mb-2">Contract</p>
            <a
              href="https://chainscan-galileo.0g.ai"
              target="_blank" rel="noreferrer"
              className="block px-3 py-1 text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >ChainScan →</a>
            <a
              href="https://storagescan-galileo.0g.ai"
              target="_blank" rel="noreferrer"
              className="block px-3 py-1 text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >StorageScan →</a>
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-5">
          {tab === 'memory' && MemoryTab}
          {tab === 'git' && GitTab}
          {tab === 'grants' && GrantsTab}
          {tab === 'system' && SystemTab}
          {tab === 'skills' && SkillsTab}
        </main>

        {/* Activity log sidebar */}
        <aside className="w-72 border-l border-gray-800 p-3 overflow-y-auto shrink-0">
          <p className="text-xs text-gray-500 font-bold mb-2 uppercase tracking-widest">Activity log</p>
          {activityLog.length === 0 && (
            <p className="text-xs text-gray-700">Actions will appear here…</p>
          )}
          {activityLog.map((entry, i) => (
            <div key={i} className={`mb-2 rounded p-2 text-xs border ${entry.ok ? 'border-gray-800 bg-gray-900' : 'border-red-900 bg-red-950'}`}>
              <div className="flex justify-between mb-1">
                <span className={entry.ok ? 'text-green-400' : 'text-red-400'}>{entry.label}</span>
                <span className="text-gray-600">{timeAgo(entry.ts)}</span>
              </div>
              <pre className="text-gray-400 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap break-all max-h-24">
                {JSON.stringify(entry.payload, null, 2).slice(0, 300)}
              </pre>
            </div>
          ))}
        </aside>

      </div>
    </div>
  );
}
