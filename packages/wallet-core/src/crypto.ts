import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { Ed25519Signer, isValidEd25519Key } from "@xian-tech/client";

import type { WalletSeedSource } from "./types.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const ITERATIONS = 250_000;
const MNEMONIC_STRENGTH_BY_WORD_COUNT = new Map<number, number>([
  [12, 128],
  [15, 160],
  [18, 192],
  [21, 224],
  [24, 256]
]);

function getWebCrypto(): Crypto {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error("Web Crypto API is not available");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const passwordKey = await getWebCrypto().subtle.importKey(
    "raw",
    ENCODER.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return getWebCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: ITERATIONS,
      salt: toArrayBuffer(salt)
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(value: string, password: string): Promise<string> {
  const salt = getWebCrypto().getRandomValues(new Uint8Array(16));
  const iv = getWebCrypto().getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await getWebCrypto().subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ENCODER.encode(value))
    )
  );
  return JSON.stringify({
    algorithm: "AES-GCM",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  });
}

async function decryptText(payload: string, password: string): Promise<string> {
  const parsed = JSON.parse(payload) as {
    salt: string;
    iv: string;
    ciphertext: string;
  };
  const key = await deriveKey(password, base64ToBytes(parsed.salt));
  try {
    const plaintext = await getWebCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(parsed.iv)) },
      key,
      toArrayBuffer(base64ToBytes(parsed.ciphertext))
    );
    return DECODER.decode(plaintext);
  } catch {
    throw new Error("invalid password");
  }
}

function assertMnemonicWordCount(wordCount: number): void {
  if (!MNEMONIC_STRENGTH_BY_WORD_COUNT.has(wordCount)) {
    throw new Error("mnemonic word count must be one of 12, 15, 18, 21, or 24");
  }
}

export function normalizePrivateKeyInput(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/^0x/, "").toLowerCase();
  if (!isValidEd25519Key(normalized)) {
    throw new Error("private key must be a 32-byte hex seed");
  }
  return normalized;
}

export function normalizeMnemonicInput(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
  if (normalized.length === 0) {
    return undefined;
  }
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("mnemonic must be a valid BIP39 English phrase");
  }
  return normalized;
}

export function generateMnemonicPhrase(wordCount: number = 12): string {
  assertMnemonicWordCount(wordCount);
  return generateMnemonic(wordlist, MNEMONIC_STRENGTH_BY_WORD_COUNT.get(wordCount) ?? 128);
}

export async function derivePrivateKeyFromMnemonic(
  mnemonic: string,
  accountIndex: number = 0
): Promise<string> {
  const normalized = normalizeMnemonicInput(mnemonic);
  if (!normalized) {
    throw new Error("mnemonic must be a valid BIP39 English phrase");
  }
  const seed = await mnemonicToSeed(normalized);
  const context = ENCODER.encode("xian-wallet-seed-v1");
  if (accountIndex === 0) {
    // Index 0: original derivation for backward compatibility
    const buffer = new Uint8Array(seed.length + context.length);
    buffer.set(seed, 0);
    buffer.set(context, seed.length);
    const digest = await getWebCrypto().subtle.digest(
      "SHA-256",
      toArrayBuffer(buffer)
    );
    return bytesToHex(new Uint8Array(digest));
  }
  // Index > 0: append big-endian uint32 index
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, accountIndex, false);
  const buffer = new Uint8Array(seed.length + context.length + 4);
  buffer.set(seed, 0);
  buffer.set(context, seed.length);
  buffer.set(indexBytes, seed.length + context.length);
  const digest = await getWebCrypto().subtle.digest(
    "SHA-256",
    toArrayBuffer(buffer)
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function createWalletSecret(input?: {
  privateKey?: string;
  mnemonic?: string;
  createWithMnemonic?: boolean;
  mnemonicWordCount?: number;
}): Promise<{
  privateKey: string;
  mnemonic?: string;
  generatedMnemonic?: string;
  seedSource: WalletSeedSource;
  mnemonicWordCount?: number;
}> {
  const normalizedPrivateKey = normalizePrivateKeyInput(input?.privateKey);
  const normalizedMnemonic = normalizeMnemonicInput(input?.mnemonic);

  if (normalizedPrivateKey && normalizedMnemonic) {
    throw new Error("provide either a private key or a mnemonic, not both");
  }

  if (normalizedMnemonic || input?.createWithMnemonic) {
    const mnemonic =
      normalizedMnemonic ??
      generateMnemonicPhrase(input?.mnemonicWordCount ?? 12);
    const privateKey = await derivePrivateKeyFromMnemonic(mnemonic);
    return {
      privateKey,
      mnemonic,
      generatedMnemonic: normalizedMnemonic ? undefined : mnemonic,
      seedSource: "mnemonic",
      mnemonicWordCount: mnemonic.split(" ").length
    };
  }

  return {
    privateKey: normalizedPrivateKey ?? new Ed25519Signer().privateKey,
    seedSource: "privateKey"
  };
}

export function createPrivateKey(privateKey?: string): string {
  return normalizePrivateKeyInput(privateKey) ?? new Ed25519Signer().privateKey;
}

export async function encryptPrivateKey(
  privateKey: string,
  password: string
): Promise<string> {
  return encryptText(privateKey, password);
}

export async function decryptPrivateKey(
  payload: string,
  password: string
): Promise<string> {
  const privateKey = normalizePrivateKeyInput(await decryptText(payload, password));
  if (!privateKey) {
    throw new Error("missing private key after decryption");
  }
  return privateKey;
}

export async function encryptMnemonic(
  mnemonic: string,
  password: string
): Promise<string> {
  const normalized = normalizeMnemonicInput(mnemonic);
  if (!normalized) {
    throw new Error("mnemonic must be a valid BIP39 English phrase");
  }
  return encryptText(normalized, password);
}

export async function decryptMnemonic(
  payload: string,
  password: string
): Promise<string> {
  const mnemonic = normalizeMnemonicInput(await decryptText(payload, password));
  if (!mnemonic) {
    throw new Error("missing mnemonic after decryption");
  }
  return mnemonic;
}

export function truncateAddress(address?: string): string {
  if (!address) {
    return "not available";
  }
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function isUnsafeMessageToSign(message: string): boolean {
  if (message.length === 0 || message.length > 10_000) {
    return true;
  }
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed == null) {
      return false;
    }
    return ["payload", "metadata", "chain_id", "contract", "function", "kwargs"].some(
      (key) => key in parsed
    );
  } catch {
    return false;
  }
}
