import { namespaceFromSessionKey } from '../namespace.js';

describe('namespaceFromSessionKey', () => {
  test('main:* → default', () => {
    expect(namespaceFromSessionKey('main:uuid-123')).toBe('default');
  });

  test('agent:<name>:* → name', () => {
    expect(namespaceFromSessionKey('agent:researcher:uuid-456')).toBe('researcher');
    expect(namespaceFromSessionKey('agent:coder:uuid-789')).toBe('coder');
  });

  test('undefined → fallback', () => {
    expect(namespaceFromSessionKey(undefined)).toBe('default');
    expect(namespaceFromSessionKey(undefined, 'custom')).toBe('custom');
  });

  test('agent without name part falls back', () => {
    expect(namespaceFromSessionKey('agent:')).toBe('default');
  });
});
