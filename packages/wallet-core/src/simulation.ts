import { SimulationError } from "@xian-tech/client";

/**
 * The failure text of a simulation that did not succeed, or undefined when
 * it succeeded or reports no status. The simulator answers a failing call with a
 * non-zero status and the failure as its result; sending that call anyway
 * executes, fails and pays its chi.
 */
export function simulationFailure(simulation: unknown): string | undefined {
  if (typeof simulation !== "object" || simulation === null) {
    return undefined;
  }
  const { status, result } = simulation as { status?: unknown; result?: unknown };
  if (typeof status !== "number" || status === 0) {
    return undefined;
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "unknown failure");
}

/** Refuses a failing simulation: sending that call would execute, fail and pay its chi. */
export function assertSimulationSucceeds(simulation: unknown): void {
  const failure = simulationFailure(simulation);
  if (failure !== undefined) {
    throw new SimulationError(`This transaction would fail: ${failure}`, simulation);
  }
}
