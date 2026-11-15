import { describe, expect, it } from "vitest";

import { simulationFailure } from "../src/simulation";

describe("simulationFailure", () => {
  it.each([
    ["a successful simulation", { status: 0, result: null }],
    ["a simulation without a status", { result: "x" }],
    ["a non-numeric status", { status: "1", result: "x" }],
    ["no simulation", undefined],
    ["a non-record", "failed"]
  ])("finds no failure in %s", (_case, simulation) => {
    expect(simulationFailure(simulation)).toBeNull();
  });

  it.each([
    ["its text result", { status: 1, result: "AssertionError('Not enough coins to send.')" }, "AssertionError('Not enough coins to send.')"],
    ["a structured result as JSON", { status: 1, result: { error: "boom" } }, '{"error":"boom"}'],
    ["a placeholder without a result", { status: 2 }, '"unknown failure"']
  ])("reports a failed simulation with %s", (_case, simulation, failure) => {
    expect(simulationFailure(simulation)).toBe(failure);
  });
});
