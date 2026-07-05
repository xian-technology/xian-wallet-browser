import { describe, expect, it } from "vitest";

import {
  assertRpcTransportAllowed,
  isLoopbackHttpUrl,
  normalizeUrlHostname
} from "../src/index";

describe("@xian-tech/wallet-core network URL helpers", () => {
  it("normalizes bracketed IPv6 hostnames from WHATWG URLs", () => {
    expect(normalizeUrlHostname("[::1]")).toBe("::1");
    expect(normalizeUrlHostname("[2001:DB8::1]")).toBe("2001:db8::1");
    expect(normalizeUrlHostname("LOCALHOST")).toBe("localhost");
  });

  it("accepts loopback HTTP URLs without requiring insecure HTTP opt-in", () => {
    expect(isLoopbackHttpUrl("http://localhost:26657")).toBe(true);
    expect(isLoopbackHttpUrl("http://127.0.0.1:26657")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:26657")).toBe(true);

    expect(() => assertRpcTransportAllowed("http://localhost:26657", false)).not.toThrow();
    expect(() => assertRpcTransportAllowed("http://127.0.0.1:26657", false)).not.toThrow();
    expect(() => assertRpcTransportAllowed("http://[::1]:26657", false)).not.toThrow();
  });

  it("does not treat arbitrary HTTP IPv6 URLs as loopback", () => {
    expect(isLoopbackHttpUrl("http://[2001:db8::1]:26657")).toBe(false);
    expect(() =>
      assertRpcTransportAllowed("http://[2001:db8::1]:26657", false)
    ).toThrow("HTTP RPC URLs are disabled");
    expect(() =>
      assertRpcTransportAllowed("http://[2001:db8::1]:26657", true)
    ).not.toThrow();
  });

  it("rejects invalid RPC URLs", () => {
    expect(() => assertRpcTransportAllowed("not a url", false)).toThrow(
      "network preset rpcUrl must be a valid URL"
    );
  });
});
