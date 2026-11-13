import { describe, expect, it } from "vitest";

import { disjointHandlerGroups } from "./runtime-dispatch";

const answer = async () => null;

describe("handler groups", () => {
  it("passes disjoint groups through unchanged", () => {
    const lock = { wallet_lock: answer };
    const remove = { wallet_remove: answer, wallet_unlock: answer };

    const groups = disjointHandlerGroups(lock, remove);

    expect(groups).toEqual([lock, remove]);
    expect(groups[0]).toBe(lock);
    expect(groups[1]).toBe(remove);
  });

  it("refuses at compile time a message type handled by two groups", () => {
    // @ts-expect-error wallet_lock is handled by the first and third group
    disjointHandlerGroups({ wallet_lock: answer }, { wallet_remove: answer }, { wallet_lock: answer });
    // @ts-expect-error wallet_unlock is handled by the second and third group
    disjointHandlerGroups({ wallet_lock: answer }, { wallet_unlock: answer }, { wallet_unlock: answer });
  });
});
