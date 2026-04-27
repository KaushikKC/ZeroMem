import { ethers } from 'ethers';
import {
  buildCommit,
  signCommit,
  verifyCommit,
  encodeCommit,
  decodeCommit,
} from '../commit';

describe('commit', () => {
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );

  const base = {
    parent: null,
    agentId: 'agent-test-1',
    authorPubkey: wallet.signingKey.publicKey,
    op: 'remember' as const,
    branch: 'main',
    namespace: 'default',
    payloadRoot: '0xdeadbeef',
    metadata: { ts: 1700000000000, embedding_dim: 8, tags: ['test'] },
  };

  test('buildCommit sets version to 1 and passes through all fields', () => {
    const c = buildCommit(base);
    expect(c.version).toBe(1);
    expect(c.parent).toBeNull();
    expect(c.agent_id).toBe('agent-test-1');
    expect(c.op).toBe('remember');
    expect(c.branch).toBe('main');
    expect(c.namespace).toBe('default');
    expect(c.payload_root).toBe('0xdeadbeef');
    expect(c.metadata.ts).toBe(1700000000000);
  });

  test('buildCommit preserves non-null parent', () => {
    const c = buildCommit({ ...base, parent: '0xparent123' });
    expect(c.parent).toBe('0xparent123');
  });

  test('signCommit adds a non-empty sig', async () => {
    const partial = buildCommit(base);
    const signed = await signCommit(partial, wallet);
    expect(signed.sig).toBeTruthy();
    expect(signed.sig.startsWith('0x')).toBe(true);
    expect(signed.sig.length).toBeGreaterThan(10);
  });

  test('verifyCommit returns the signing address', async () => {
    const partial = buildCommit(base);
    const signed = await signCommit(partial, wallet);
    const recovered = verifyCommit(signed);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  test('verifyCommit fails for tampered commit', async () => {
    const partial = buildCommit(base);
    const signed = await signCommit(partial, wallet);
    const tampered = { ...signed, payload_root: '0xhacked' };
    const recovered = verifyCommit(tampered);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  test('encodeCommit / decodeCommit roundtrip', async () => {
    const partial = buildCommit(base);
    const signed = await signCommit(partial, wallet);
    const encoded = encodeCommit(signed);
    const decoded = decodeCommit(encoded);

    expect(decoded.version).toBe(signed.version);
    expect(decoded.parent).toBe(signed.parent);
    expect(decoded.agent_id).toBe(signed.agent_id);
    expect(decoded.op).toBe(signed.op);
    expect(decoded.payload_root).toBe(signed.payload_root);
    expect(decoded.sig).toBe(signed.sig);
    expect(decoded.metadata.ts).toBe(signed.metadata.ts);
  });

  test('different ops produce commits with the same structure', () => {
    const ops = ['remember', 'reflect', 'forget', 'skill_add', 'grant', 'revoke'] as const;
    for (const op of ops) {
      const c = buildCommit({ ...base, op });
      expect(c.op).toBe(op);
      expect(c.version).toBe(1);
    }
  });
});
