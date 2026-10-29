import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { StoredWalletState } from "@xian-tech/wallet-core";
import { cleanupExtension, createWalletInPopup, launchExtension, openExtensionPage, sendRuntimeMessage } from "./helpers";

function legacyWallet(state: StoredWalletState, password: string): StoredWalletState {
  const salt = Buffer.from(state.walletEncryptionSalt, "base64");
  const currentKey = pbkdf2Sync(password, salt, state.walletEncryptionIterations!, 32, "sha256");
  const legacyKey = pbkdf2Sync(password, salt, 250_000, 32, "sha256");
  const reencrypt = (value: string): string => {
    const payload = JSON.parse(value);
    const encrypted = Buffer.from(payload.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", currentKey, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ ...payload, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64") });
  };
  return {
    ...state,
    walletEncryptionIterations: undefined,
    encryptedPrivateKey: reencrypt(state.encryptedPrivateKey),
    encryptedMnemonic: state.encryptedMnemonic ? reencrypt(state.encryptedMnemonic) : undefined,
    accounts: state.accounts?.map(account => ({ ...account, encryptedPrivateKey: reencrypt(account.encryptedPrivateKey) }))
  };
}

test("migrates a legacy encrypted wallet through the real extension storage adapter", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();
  const password = "correct horse battery";
  try {
    const popup = await openExtensionPage(context, extensionId, "popup.html");
    await createWalletInPopup(popup, password);
    await sendRuntimeMessage(popup, { type: "wallet_lock" });
    const envelope = await popup.evaluate(async () =>
      (await chrome.storage.local.get("xianWalletShellState")).xianWalletShellState
    ) as { wallet: StoredWalletState };
    envelope.wallet = legacyWallet(envelope.wallet, password);
    await popup.evaluate(async value => {
      await chrome.storage.local.set({ xianWalletShellState: value });
    }, envelope);
    const unlocked = await sendRuntimeMessage<{ publicKey: string; unlocked: boolean }>(popup, {
      type: "wallet_unlock", password
    });
    expect(unlocked).toMatchObject({ publicKey: envelope.wallet.publicKey, unlocked: true });
    const upgraded = await popup.evaluate(async () =>
      (await chrome.storage.local.get("xianWalletShellState")).xianWalletShellState.wallet
    ) as StoredWalletState;
    expect(upgraded.walletEncryptionIterations).toBe(600_000);
    expect(upgraded.walletEncryptionSalt).not.toBe(envelope.wallet.walletEncryptionSalt);
    await sendRuntimeMessage(popup, { type: "wallet_lock" });
    await expect(sendRuntimeMessage(popup, { type: "wallet_unlock", password })).resolves.toMatchObject({
      publicKey: envelope.wallet.publicKey, unlocked: true
    });
  } finally {
    await cleanupExtension(context, userDataDir);
  }
});
