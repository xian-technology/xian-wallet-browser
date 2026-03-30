import { describe, expect, it } from "vitest";

import {
  createPrivateKey,
  createWalletSecret,
  decryptMnemonic,
  decryptPrivateKey,
  derivePrivateKeyFromMnemonic,
  encryptMnemonic,
  encryptPrivateKey,
  generateMnemonicPhrase,
  isUnsafeMessageToSign,
  normalizeMnemonicInput,
  normalizePrivateKeyInput
} from "../src/crypto";

describe("@xian/wallet-core crypto helpers", () => {
  it("encrypts and decrypts a private key", async () => {
    const privateKey = createPrivateKey();
    const encrypted = await encryptPrivateKey(privateKey, "secret-password");

    await expect(decryptPrivateKey(encrypted, "secret-password")).resolves.toBe(
      privateKey
    );
    await expect(decryptPrivateKey(encrypted, "wrong-password")).rejects.toThrow(
      "invalid password"
    );
  });

  it("encrypts and decrypts a mnemonic", async () => {
    const mnemonic = generateMnemonicPhrase(12);
    const encrypted = await encryptMnemonic(mnemonic, "secret-password");

    await expect(decryptMnemonic(encrypted, "secret-password")).resolves.toBe(
      mnemonic
    );
  });

  it("normalizes and validates private key input", () => {
    const privateKey = createPrivateKey();
    expect(normalizePrivateKeyInput(`0x${privateKey}`)).toBe(privateKey);
    expect(() => normalizePrivateKeyInput("abc")).toThrow(
      "private key must be a 32-byte hex seed"
    );
  });

  it("normalizes and validates mnemonic input", () => {
    const mnemonic = generateMnemonicPhrase(12);
    expect(normalizeMnemonicInput(`  ${mnemonic.toUpperCase()}  `)).toBe(mnemonic);
    expect(() => normalizeMnemonicInput("hello world")).toThrow(
      "mnemonic must be a valid BIP39 English phrase"
    );
  });

  it("derives the same private key from the same mnemonic", async () => {
    const mnemonic = generateMnemonicPhrase(12);
    await expect(derivePrivateKeyFromMnemonic(mnemonic)).resolves.toMatch(
      /^[0-9a-f]{64}$/
    );
    await expect(derivePrivateKeyFromMnemonic(mnemonic)).resolves.toBe(
      await derivePrivateKeyFromMnemonic(mnemonic)
    );
  });

  it("creates mnemonic-backed wallet secrets", async () => {
    const result = await createWalletSecret({
      createWithMnemonic: true
    });

    expect(result.seedSource).toBe("mnemonic");
    expect(result.generatedMnemonic).toBeDefined();
    expect(result.mnemonicWordCount).toBe(12);
    expect(result.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags transaction-like messages as unsafe", () => {
    expect(isUnsafeMessageToSign("hello world")).toBe(false);
    expect(
      isUnsafeMessageToSign(
        JSON.stringify({ payload: { chain_id: "xian-local" } })
      )
    ).toBe(true);
  });
});
