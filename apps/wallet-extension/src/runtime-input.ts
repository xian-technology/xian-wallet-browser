import { fixed, parseContractJson } from "@xian-tech/client";

export type RuntimeFixed = { __fixed__: string };
type RuntimeBigInt = { __big_int__: string };
export type RuntimeNumeric = number | RuntimeBigInt | RuntimeFixed;
export type RuntimeArgType =
  | "str"
  | "int"
  | "decimal"
  | "bool"
  | "dict"
  | "list"
  | "datetime"
  | "timedelta"
  | "Any";

const INTEGER_PATTERN = /^-?\d+$/;
const XIAN_ADDRESS_PATTERN = /^[0-9a-fA-F]{64}$/;
const XIAN_CONTRACT_NAME_PATTERN = /^(?:currency|con_[a-z0-9_]+)$/;

function normalizeDecimalText(value: string): string {
  return value.trim().replace(",", ".");
}

function parseFixedInput(value: string): RuntimeFixed | null {
  try {
    return fixed(normalizeDecimalText(value));
  } catch {
    return null;
  }
}

export function isRuntimeFixed(value: unknown): value is RuntimeFixed {
  return (
    typeof value === "object" &&
    value != null &&
    typeof (value as { __fixed__?: unknown }).__fixed__ === "string"
  );
}

export function isRecognizedXianRecipient(value: string): boolean {
  return (
    XIAN_ADDRESS_PATTERN.test(value) || XIAN_CONTRACT_NAME_PATTERN.test(value)
  );
}

export function parseIntegerInput(value: string): number | RuntimeBigInt | null {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= -(1n << 512n) || parsed >= (1n << 512n)) return null;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  return parsed >= minSafe && parsed <= maxSafe ? Number(parsed) : { __big_int__: parsed.toString() };
}

export function parseRuntimeNumberInput(value: string): RuntimeNumeric | null {
  const trimmed = normalizeDecimalText(value);
  if (INTEGER_PATTERN.test(trimmed)) {
    return parseIntegerInput(trimmed);
  }
  return parseFixedInput(trimmed);
}

export function isPositiveRuntimeAmount(value: RuntimeNumeric): boolean {
  if (typeof value === "number") {
    return value > 0;
  }
  if ("__big_int__" in value) return !value.__big_int__.startsWith("-");
  return value.__fixed__ !== "0" && !value.__fixed__.startsWith("-");
}

export function parseArgValue(val: string, type: RuntimeArgType): unknown {
  switch (type) {
    case "str":
    case "Any":
      return val;
    case "int": {
      const integer = parseIntegerInput(val);
      if (integer == null) throw new Error("Enter an integer within the 512-bit limit.");
      return integer;
    }
    case "decimal":
      return fixed(normalizeDecimalText(val));
    case "bool":
      return val.toLowerCase() === "true" || val === "1";
    case "dict":
    case "list":
      return parseContractJson(val);
    case "datetime": {
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) {
        return val;
      }
      return {
        __time__: [
          d.getFullYear(),
          d.getMonth() + 1,
          d.getDate(),
          d.getHours(),
          d.getMinutes(),
          d.getSeconds()
        ]
      };
    }
    case "timedelta": {
      const secs = parseInt(val, 10);
      if (!Number.isFinite(secs)) {
        return val;
      }
      return { __delta__: [Math.floor(secs / 86400), secs % 86400] };
    }
  }
}
