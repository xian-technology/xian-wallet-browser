import { describe, expect, it } from "vitest";

import {
  isPositiveRuntimeAmount,
  parseArgValue,
  parseRuntimeNumberInput
} from "./runtime-input";

describe("runtime input parsing", () => {
  it("keeps integer amounts as JSON integers", () => {
    expect(parseRuntimeNumberInput("42")).toBe(42);
    expect(parseRuntimeNumberInput("9007199254740993")).toBe(9007199254740993n);
  });

  it("encodes decimal amounts as runtime fixed values", () => {
    expect(parseRuntimeNumberInput("12.5")).toEqual({ __fixed__: "12.5" });
    expect(parseRuntimeNumberInput("12,5")).toEqual({ __fixed__: "12.5" });
    expect(isPositiveRuntimeAmount({ __fixed__: "12.5" })).toBe(true);
    expect(isPositiveRuntimeAmount({ __fixed__: "0" })).toBe(false);
  });

  it("encodes typed float arguments as runtime fixed values", () => {
    expect(parseArgValue("0.0001", "float")).toEqual({ __fixed__: "0.0001" });
    expect(parseArgValue("5", "float")).toEqual({ __fixed__: "5" });
    expect(parseArgValue("5oops", "float")).toBe("5oops");
  });
});
