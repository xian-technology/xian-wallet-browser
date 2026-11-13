import { UNLOCKED_SESSION_TIMEOUT_MS } from "@xian-tech/wallet-core";

import {
  loadUnlockedSession,
  saveAutoLock,
  saveUnlockedSession
} from "../shared/storage";

const DISABLED_AUTO_LOCK_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

/** When an unlocked session started or touched at `now` expires. */
export function unlockedSessionExpiry(autoLock: boolean, now: number): number {
  return autoLock
    ? now + UNLOCKED_SESSION_TIMEOUT_MS
    : DISABLED_AUTO_LOCK_EXPIRES_AT;
}

/** Store the auto-lock preference and re-time a live unlocked session to it. */
export async function setAutoLock(enabled: boolean): Promise<void> {
  await saveAutoLock(enabled);
  const session = await loadUnlockedSession();
  if (session) {
    session.expiresAt = unlockedSessionExpiry(enabled, Date.now());
    await saveUnlockedSession(session);
  }
}
