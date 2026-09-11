import type { WalletControllerStore } from "./types.js";

const claims = new WeakMap<WalletControllerStore, Set<string>>();

/** Synchronous ownership before the first store read. Durable stores also CAS. */
export function beginApprovalResolution(store: WalletControllerStore, id: string): (() => void) | null {
  let active = claims.get(store);
  if (!active) { active = new Set(); claims.set(store, active); }
  if (active.has(id)) return null;
  active.add(id);
  return () => { active.delete(id); };
}


export function isApprovalResolutionActive(store: WalletControllerStore, id?: string): boolean {
  return id !== undefined && (claims.get(store)?.has(id) ?? false);
}
