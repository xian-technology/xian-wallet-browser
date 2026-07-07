import { describe, expect, it } from "vitest";

import {
  createWalletSessionKey,
  createPrivateKey,
  createWalletSecret,
  decryptMnemonic,
  decryptMnemonicWithSessionKey,
  decryptPrivateKey,
  decryptPrivateKeyWithSessionKey,
  decryptWalletBackup,
  deriveWalletSessionKey,
  derivePrivateKeyFromMnemonic,
  encryptMnemonic,
  encryptMnemonicWithSessionKey,
  encryptPrivateKey,
  encryptPrivateKeyWithSessionKey,
  generateMnemonicPhrase,
  isUnsafeMessageToSign,
  normalizeMnemonicInput,
  normalizePrivateKeyInput
} from "../src/crypto";
import type { WalletBackup } from "../src/types";

describe("@xian-tech/wallet-core crypto helpers", () => {
  const vectorMnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

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

  it("derives a stable wallet session key and encrypts with it", async () => {
    const privateKey = createPrivateKey();
    const mnemonic = generateMnemonicPhrase(12);
    const material = await createWalletSessionKey("secret-password");
    const sameSessionKey = await deriveWalletSessionKey(
      "secret-password",
      material.walletEncryptionSalt
    );

    expect(sameSessionKey).toBe(material.sessionKey);

    const encryptedPrivateKey = await encryptPrivateKeyWithSessionKey(
      privateKey,
      material.sessionKey
    );
    const encryptedMnemonic = await encryptMnemonicWithSessionKey(
      mnemonic,
      material.sessionKey
    );

    await expect(
      decryptPrivateKeyWithSessionKey(encryptedPrivateKey, sameSessionKey)
    ).resolves.toBe(privateKey);
    await expect(
      decryptMnemonicWithSessionKey(encryptedMnemonic, sameSessionKey)
    ).resolves.toBe(mnemonic);
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

  it("derives canonical indexed mnemonic private keys", async () => {
    await expect(derivePrivateKeyFromMnemonic(vectorMnemonic, 0)).resolves.toBe(
      "b3aee0ed179a18a754136d3d134c03e9c1ad97eb2e9912401dc2d9ffc96882e0"
    );
    await expect(derivePrivateKeyFromMnemonic(vectorMnemonic, 1)).resolves.toBe(
      "f1f4674448f4d17a78af6b150a7fa45a752d0014fb0235604a339a898695ce69"
    );
  });

  it("rejects invalid mnemonic account indexes", async () => {
    await expect(derivePrivateKeyFromMnemonic(vectorMnemonic, -1)).rejects.toThrow(
      "account index"
    );
    await expect(derivePrivateKeyFromMnemonic(vectorMnemonic, 1.5)).rejects.toThrow(
      "account index"
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

  it("rejects plaintext wallet backups", async () => {
    await expect(
      decryptWalletBackup(
        {
          version: 1,
          type: "privateKey",
          privateKey: "11".repeat(32)
        } as unknown as WalletBackup,
        "unused"
      )
    ).rejects.toThrow("invalid wallet backup");
  });
});
