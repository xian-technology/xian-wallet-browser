import { describe, expect, it } from "vitest";

import { formatBalance, safeOriginLabel } from "./format";

describe("formatBalance", () => {
  it("truncates displayed decimals instead of rounding balances", () => {
    expect(formatBalance("99659.39826748014", 2)).toBe("99,659.39");
    expect(formatBalance("999.999", 2)).toBe("999.99");
    expect(formatBalance("0.009", 2)).toBe("0");
  });

  it("keeps grouping and removes unnecessary trailing zeros", () => {
    expect(formatBalance("1234567.4000", 8)).toBe("1,234,567.4");
    expect(formatBalance("1234567.0000", 8)).toBe("1,234,567");
  });

  it("supports zero configured decimals without rounding up", () => {
    expect(formatBalance("999.999", 0)).toBe("999");
    expect(formatBalance("1000.1", 0)).toBe("1,000");
  });

  it("formats scientific notation without rounding", () => {
    expect(formatBalance("1.234567e5", 2)).toBe("123,456.7");
    expect(formatBalance("1.234567e-3", 5)).toBe("0.00123");
  });

  it("returns placeholder or raw text for missing and non-decimal balances", () => {
    expect(formatBalance(null, 2)).toBe("—");
    expect(formatBalance("", 2)).toBe("—");
    expect(formatBalance("not-a-number", 2)).toBe("not-a-number");
  });
});

describe("safeOriginLabel", () => {
  it("formats bracketed IPv6 origins without preserving URL parser brackets", () => {
    expect(safeOriginLabel("http://[::1]:3000")).toBe("::1");
    expect(safeOriginLabel("http://[2001:db8::1]:3000")).toBe("2001:db8::1");
  });

  it("preserves existing local origin labels", () => {
    expect(safeOriginLabel("http://localhost:3000")).toBe("localhost");
    expect(safeOriginLabel("http://127.0.0.1:3000")).toBe("127.0.0.1");
  });
});
