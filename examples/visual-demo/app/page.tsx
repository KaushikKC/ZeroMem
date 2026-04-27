'use client';

import { useState } from 'react';

interface CommitEntry {
  commitId: string;
  text: string;
  op: string;
  ts: number;
}

interface RecallHit {
  text: string;
  score: number;
  commitId: string;
  ts: number;
}

export default function Home() {
  const [agentId, setAgentId] = useState('demo-agent');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RecallHit[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  async function api(path: string, body: object) {
    const resp = await fetch(`/api/zeromem/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, ...body }),
    });
    return resp.json();
  }

  async function handleRemember() {
    if (!text.trim()) return;
    setLoading(true);
    setStatus('Storing memory on 0G...');
    try {
      const { commitId } = await api('remember', { text });
      setStatus(`Stored ✓  commitId: ${commitId?.slice(0, 16)}...`);
      setText('');
      await handleLog();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function handleRecall() {
    if (!query.trim()) return;
    setLoading(true);
    setStatus('Recalling from 0G...');
    try {
      const { hits: h } = await api('recall', { query, k: 5 });
      setHits(h ?? []);
      setStatus(`Found ${h?.length ?? 0} results`);
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function handleLog() {
    setLoading(true);
    try {
      const { commits: c } = await api('log', { limit: 10 });
      setCommits(c ?? []);
    } catch {
      // ignore
    }
    setLoading(false);
  }

  async function handleReflect() {
    setLoading(true);
    setStatus('Running reflector (episodic → semantic)...');
    try {
      const { commitId } = await api('reflect', { since: '1h' });
      setStatus(`Reflect commit: ${commitId?.slice(0, 16) ?? 'done'}...`);
      await handleLog();
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 font-mono p-8">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-green-400">ZeroMem</h1>
          <p className="text-gray-400 text-sm mt-1">Git-for-Agent-Memory · Built on 0G</p>
        </div>

        {/* Agent config */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <label className="text-xs text-gray-500 block mb-1">AGENT ID</label>
          <input
            className="bg-transparent text-green-300 w-full outline-none text-sm"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          />
        </div>

        {/* Remember */}
        <div className="space-y-2">
          <h2 className="text-sm text-gray-400 uppercase tracking-wider">Remember</h2>
          <textarea
            className="w-full bg-gray-900 border border-gray-800 rounded-lg p-3 text-sm text-gray-100 outline-none resize-none h-24"
            placeholder="Type a memory to store..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            onClick={handleRemember}
            disabled={loading}
            className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-4 py-2 rounded text-sm font-bold transition-colors"
          >
            {loading ? 'Working...' : 'mem.remember()'}
          </button>
        </div>

        {/* Recall */}
        <div className="space-y-2">
          <h2 className="text-sm text-gray-400 uppercase tracking-wider">Recall</h2>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-100 outline-none"
              placeholder="Semantic query..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRecall()}
            />
            <button
              onClick={handleRecall}
              disabled={loading}
              className="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 px-4 py-2 rounded text-sm font-bold transition-colors"
            >
              mem.recall()
            </button>
          </div>
          {hits.length > 0 && (
            <div className="space-y-2">
              {hits.map((h, i) => (
                <div key={i} className="bg-gray-900 rounded p-3 border border-gray-800">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>{h.commitId?.slice(0, 12)}...</span>
                    <span className="text-green-400">{(h.score * 100).toFixed(1)}%</span>
                  </div>
                  <p className="text-sm text-gray-200">{h.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleLog}
            disabled={loading}
            className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 px-4 py-2 rounded text-sm transition-colors"
          >
            mem.log()
          </button>
          <button
            onClick={handleReflect}
            disabled={loading}
            className="bg-purple-800 hover:bg-purple-700 disabled:opacity-50 px-4 py-2 rounded text-sm transition-colors"
          >
            mem.reflect()
          </button>
        </div>

        {/* Status */}
        {status && (
          <div className="text-xs text-yellow-400 bg-gray-900 rounded p-3 border border-yellow-900">
            {status}
          </div>
        )}

        {/* Commit log */}
        {commits.length > 0 && (
          <div>
            <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-2">Commit DAG</h2>
            <div className="space-y-1">
              {commits.map((c, i) => (
                <div
                  key={i}
                  className="flex gap-3 text-xs font-mono bg-gray-900 rounded p-2 border border-gray-800"
                >
                  <span className="text-yellow-500">{c.commitId?.slice(0, 10)}...</span>
                  <span
                    className={
                      c.op === 'remember' ? 'text-green-400' :
                      c.op === 'reflect'  ? 'text-purple-400' :
                      c.op === 'grant'    ? 'text-blue-400' :
                      'text-gray-400'
                    }
                  >
                    [{c.op}]
                  </span>
                  <span className="text-gray-300 flex-1 truncate">{c.text?.slice(0, 60)}</span>
                  <span className="text-gray-600">
                    {c.ts ? new Date(c.ts).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
