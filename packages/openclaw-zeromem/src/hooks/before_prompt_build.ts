import type { PluginContext, OpenClawHookCtx, RecallHookResult } from '../types.js';
import { namespaceFromSessionKey } from '../namespace.js';
import { detectInjection, htmlEscape, wrapMemoryBlock } from '../security.js';

const NAMESPACE_INSTRUCTION = (ns: string) =>
  `When calling memory_search or memory_store, use namespace="${ns}".`;

export function makeBeforePromptBuild(plugin: PluginContext) {
  return async function beforePromptBuild(
    ctx: OpenClawHookCtx,
  ): Promise<RecallHookResult> {
    const ns = namespaceFromSessionKey(
      ctx.sessionKey ?? ctx.agentName,
      plugin.cfg.defaultNamespace,
    );

    const sysCtx: RecallHookResult = {
      appendSystemContext: NAMESPACE_INSTRUCTION(ns),
    };

    if (!plugin.cfg.autoRecall) return sysCtx;

    const prompt = (ctx.prompt ?? '').trim();
    if (prompt.length < 10) return sysCtx;

    let hits: { text: string; score: number }[] = [];
    try {
      hits = await plugin.mem.recall(prompt, {
        k: plugin.cfg.maxRecallResults,
        ns,
      });
    } catch {
      return sysCtx;
    }

    const filtered = hits
      .filter((h) => h.score >= plugin.cfg.minRelevance)
      .filter((h) => !detectInjection(h.text))
      .map((h) => htmlEscape(h.text));

    if (filtered.length === 0) return sysCtx;

    return {
      prependContext: wrapMemoryBlock(filtered),
      appendSystemContext: sysCtx.appendSystemContext,
    };
  };
}
