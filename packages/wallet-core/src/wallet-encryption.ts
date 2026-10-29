import {
  createWalletSessionKey,
  decryptSecretTextWithSessionKey,
  encryptSecretTextWithSessionKey
} from "./crypto.js";
import type { StoredWalletState } from "./types.js";

/** Prepare all ciphertexts before the caller replaces the persisted record. */
export async function reencryptWalletState(
  state: StoredWalletState,
  password: string,
  previousSessionKey: string
): Promise<{ state: StoredWalletState; sessionKey: string }> {
  const material = await createWalletSessionKey(password);
  const reencrypt = async (value: string) => encryptSecretTextWithSessionKey(
    await decryptSecretTextWithSessionKey(value, previousSessionKey), material.sessionKey
  );
  return {
    sessionKey: material.sessionKey,
    state: {
      ...state,
      walletEncryptionSalt: material.walletEncryptionSalt,
      walletEncryptionIterations: material.walletEncryptionIterations,
      encryptedPrivateKey: await reencrypt(state.encryptedPrivateKey),
      encryptedMnemonic: state.encryptedMnemonic ? await reencrypt(state.encryptedMnemonic) : undefined,
      accounts: await Promise.all((state.accounts ?? []).map(async account => ({
        ...account, encryptedPrivateKey: await reencrypt(account.encryptedPrivateKey)
      }))),
      shieldedWalletSnapshots: await Promise.all((state.shieldedWalletSnapshots ?? []).map(async snapshot => ({
        ...snapshot, encryptedStateSnapshot: await reencrypt(snapshot.encryptedStateSnapshot)
      })))
    }
  };
}
