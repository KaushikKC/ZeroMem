/**
 * acl.ts — Agent-to-Agent Access Control Layer
 *
 * Provides three things:
 *  1. KV text encryption  — per-wallet AES-256-GCM key derived from private key
 *  2. MemoryCapsule       — ECDH-wrapped key grant, stored on 0G Storage
 *  3. Challenge-response  — wallet-ownership proof before granting
 */
import {
  createECDH,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { ethers } from 'ethers';

// ── Symmetric key derivation ────────────────────────────────────────────────

/**
 * Derive a deterministic 32-byte AES-256-GCM key from an agent's private key.
 * The key is per-wallet and never stored — re-derived on every process start.
 */
export function deriveKvSymKey(privateKeyHex: string): Buffer {
  const material = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('zeromem:kv:sym:v1'),
      ethers.getBytes(privateKeyHex),
    ])
  );
  return Buffer.from(material.slice(2), 'hex');
}

// ── KV text encrypt / decrypt (AES-256-GCM) ────────────────────────────────

const ENC_PREFIX = 'zm1:'; // version tag so we can detect encrypted values

/**
 * Encrypt a memory text for KV storage.
 * Returns a base64 string prefixed with 'zm1:'.
 */
export function encryptKvText(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Layout: iv(12) | tag(16) | ciphertext
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt a KV text value.
 * Returns the original plaintext, or the input unchanged if not encrypted.
 */
export function decryptKvText(value: string, key: Buffer): string {
  if (!value.startsWith(ENC_PREFIX)) return value; // plaintext (legacy / test)
  const buf = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function isEncryptedKvText(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

// ── ECDH key wrapping ───────────────────────────────────────────────────────

/**
 * Compute ECDH shared secret between one party's private key and the
 * other's compressed secp256k1 public key.
 * Returns the x-coordinate of the shared point (32 bytes).
 */
function ecdhShared(privKeyHex: string, compressedPubKeyHex: string): Buffer {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privKeyHex.replace(/^0x/, ''), 'hex'));
  const pubBytes = Buffer.from(compressedPubKeyHex.replace(/^0x/, ''), 'hex');
  return ecdh.computeSecret(pubBytes);
}

/**
 * Derive a 32-byte wrapping key from the ECDH shared secret.
 */
function deriveWrapKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(
    ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('zeromem:wrap:v1'),
        sharedSecret,
      ])
    ).slice(2),
    'hex'
  );
}

/**
 * Wrap (encrypt) the KV symmetric key for a specific recipient.
 * Uses ECDH(granterPrivKey, recipientPubKey) to derive the wrapping key.
 * The recipient can unwrap using ECDH(recipientPrivKey, granterPubKey).
 */
export function wrapKeyForRecipient(
  kvSymKey: Buffer,
  recipientCompressedPubKey: string,
  granterPrivKey: string
): string {
  const shared = ecdhShared(granterPrivKey, recipientCompressedPubKey);
  const wrapKey = deriveWrapKey(shared);

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
  const wrapped = Buffer.concat([cipher.update(kvSymKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, wrapped]).toString('base64');
}

/**
 * Unwrap the KV symmetric key using the recipient's private key.
 * Uses ECDH(recipientPrivKey, granterPubKey) to derive the wrapping key.
 */
export function unwrapKey(
  wrappedBase64: string,
  recipientPrivKey: string,
  granterCompressedPubKey: string
): Buffer {
  const shared = ecdhShared(recipientPrivKey, granterCompressedPubKey);
  const wrapKey = deriveWrapKey(shared);

  const buf = Buffer.from(wrappedBase64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', wrapKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── AccessTier ──────────────────────────────────────────────────────────────

export type AccessTier = 'READ_SEMANTIC' | 'READ_FULL' | 'ADMIN';

export const ACCESS_TIER_NAMESPACES: Record<AccessTier, string[]> = {
  READ_SEMANTIC: ['semantic'],              // Only summaries, not raw episodic memories
  READ_FULL: ['default', 'semantic', 'sessions', 'plans'],  // Everything
  ADMIN: ['default', 'semantic', 'sessions', 'plans'],      // Same as FULL + can delegate
};

// ── MemoryCapsule ───────────────────────────────────────────────────────────

export interface MemoryCapsule {
  version: 1;
  /** Deterministic: keccak256(granterAddr + recipientAddr + scope + createdAt) */
  capsuleId: string;
  granterAddress: string;
  granterPubKey: string;
  recipientAddress: string;
  scope: string;
  /** Unix timestamp */
  expiresAt: number;
  /** Access level granted */
  tier: AccessTier;
  /** Namespaces accessible under this grant */
  allowedNamespaces: string[];
  /**
   * Granter's KV symmetric key, wrapped with ECDH(granterPrivKey, recipientPubKey).
   * Only the recipient can unwrap this using their private key.
   */
  wrappedKvKey: string;
  createdAt: number;
  /** secp256k1 signature by granter over all fields above */
  sig: string;
}

/** Build and sign a MemoryCapsule */
export async function createCapsule(opts: {
  granterAddress: string;
  granterPubKey: string;
  granterPrivKey: string;
  recipientAddress: string;
  recipientPubKey: string;
  scope: string;
  ttl: string;
  tier?: AccessTier;
  kvSymKey: Buffer;
}): Promise<MemoryCapsule> {
  const {
    granterAddress, granterPubKey, granterPrivKey,
    recipientAddress, recipientPubKey,
    scope, ttl, tier = 'READ_FULL', kvSymKey,
  } = opts;

  const createdAt = Date.now();
  const expiresAt = createdAt + parseTtlMs(ttl);

  const capsuleId = ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes(granterAddress),
      ethers.toUtf8Bytes(recipientAddress),
      ethers.toUtf8Bytes(scope),
      ethers.toBeHex(BigInt(createdAt), 32),
    ])
  );

  const wrappedKvKey = wrapKeyForRecipient(kvSymKey, recipientPubKey, granterPrivKey);
  const allowedNamespaces = ACCESS_TIER_NAMESPACES[tier];

  const body: Omit<MemoryCapsule, 'sig'> = {
    version: 1,
    capsuleId,
    granterAddress,
    granterPubKey,
    recipientAddress,
    scope,
    expiresAt,
    tier,
    allowedNamespaces,
    wrappedKvKey,
    createdAt,
  };

  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(body)));
  const wallet = new ethers.Wallet(granterPrivKey);
  const sig = await wallet.signMessage(ethers.getBytes(msgHash));

  return { ...body, sig };
}

/**
 * Verify a capsule's signature and expiry.
 * Returns the granter address recovered from the signature.
 */
export function verifyCapsule(capsule: MemoryCapsule): {
  valid: boolean;
  recovered: string;
  reason?: string;
} {
  if (capsule.expiresAt < Date.now()) {
    return { valid: false, recovered: '', reason: 'Capsule expired' };
  }
  const { sig, ...body } = capsule;
  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(body)));
  try {
    const recovered = ethers.verifyMessage(ethers.getBytes(msgHash), sig);
    const valid = recovered.toLowerCase() === capsule.granterAddress.toLowerCase();
    return { valid, recovered, reason: valid ? undefined : 'Signature mismatch' };
  } catch (e: any) {
    return { valid: false, recovered: '', reason: e.message };
  }
}

/** Encode capsule to bytes for 0G Storage */
export function encodeCapsule(c: MemoryCapsule): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(c));
}

export function decodeCapsule(bytes: Uint8Array): MemoryCapsule {
  return JSON.parse(new TextDecoder().decode(bytes)) as MemoryCapsule;
}

// ── Challenge-Response wallet verification ─────────────────────────────────

export interface AccessChallenge {
  nonce: string;
  granterAddress: string;
  recipientAddress: string;
  scope: string;
  expiresAt: number;
  /** Granter signs over nonce+recipient+scope so it can't be replayed */
  granterSig: string;
}

/**
 * Step 1 (granter): Create a challenge that the recipient must sign.
 */
export async function createAccessChallenge(
  granterPrivKey: string,
  recipientAddress: string,
  scope: string
): Promise<AccessChallenge> {
  const wallet = new ethers.Wallet(granterPrivKey);
  const nonce = ethers.hexlify(randomBytes(16));
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min

  const msg = challengeMsg(nonce, wallet.address, recipientAddress, scope, expiresAt);
  const granterSig = await wallet.signMessage(msg);

  return {
    nonce,
    granterAddress: wallet.address,
    recipientAddress,
    scope,
    expiresAt,
    granterSig,
  };
}

/**
 * Step 2 (recipient): Sign the challenge to prove wallet ownership.
 */
export async function respondToChallenge(
  recipientPrivKey: string,
  challenge: AccessChallenge
): Promise<string> {
  const wallet = new ethers.Wallet(recipientPrivKey);
  const msg = challengeMsg(
    challenge.nonce,
    challenge.granterAddress,
    challenge.recipientAddress,
    challenge.scope,
    challenge.expiresAt
  );
  return wallet.signMessage(msg);
}

/**
 * Step 3 (granter): Verify the recipient's proof before creating the grant.
 */
export function verifyChallenge(
  challenge: AccessChallenge,
  recipientProof: string
): { valid: boolean; reason?: string } {
  if (challenge.expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'Challenge expired' };
  }
  const msg = challengeMsg(
    challenge.nonce,
    challenge.granterAddress,
    challenge.recipientAddress,
    challenge.scope,
    challenge.expiresAt
  );
  try {
    const recovered = ethers.verifyMessage(msg, recipientProof);
    if (recovered.toLowerCase() !== challenge.recipientAddress.toLowerCase()) {
      return {
        valid: false,
        reason: `Signature recovered ${recovered}, expected ${challenge.recipientAddress}`,
      };
    }
    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: e.message };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function challengeMsg(
  nonce: string,
  granter: string,
  recipient: string,
  scope: string,
  expiresAt: number
): string {
  return [
    'ZeroMem access challenge',
    `Granter: ${granter}`,
    `Recipient: ${recipient}`,
    `Scope: ${scope}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join('\n');
}

function parseTtlMs(ttl: string): number {
  const m = ttl.match(/^(\d+)(s|m|h|d)$/);
  if (!m) throw new Error(`Invalid TTL: ${ttl}`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return unit === 's' ? n * 1000
    : unit === 'm' ? n * 60_000
    : unit === 'h' ? n * 3_600_000
    : n * 86_400_000;
}
