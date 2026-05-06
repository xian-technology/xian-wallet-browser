export type RuntimeFixed = { __fixed__: string };
export type RuntimeNumeric = number | bigint | RuntimeFixed;
export type RuntimeArgType =
  | "str"
  | "int"
  | "float"
  | "bool"
  | "dict"
  | "list"
  | "datetime"
  | "timedelta"
  | "Any";

const INTEGER_PATTERN = /^-?\d+$/;
const DECIMAL_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;
const XIAN_ADDRESS_PATTERN = /^[0-9a-fA-F]{64}$/;
const XIAN_CONTRACT_NAME_PATTERN = /^(?:currency|con_[a-z0-9_]+)$/;

function normalizeDecimalText(value: string): string {
  return value.trim().replace(",", ".");
}

function fixed(value: string): RuntimeFixed {
  return { __fixed__: value };
}

function parseFixedInput(value: string): RuntimeFixed | null {
  const trimmed = normalizeDecimalText(value);
  if (!DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }
  return Number.isFinite(Number(trimmed)) ? fixed(trimmed) : null;
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

export function parseIntegerInput(value: string): number | bigint | null {
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  return parsed >= minSafe && parsed <= maxSafe ? Number(parsed) : parsed;
}

export function parseRuntimeNumberInput(value: string): RuntimeNumeric | null {
  const trimmed = normalizeDecimalText(value);
  if (INTEGER_PATTERN.test(trimmed)) {
    return parseIntegerInput(trimmed);
  }
  return parseFixedInput(trimmed);
}

export function isPositiveRuntimeAmount(value: RuntimeNumeric): boolean {
  if (typeof value === "bigint") {
    return value > 0n;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return Number(value.__fixed__) > 0;
}

export function parseArgValue(val: string, type: RuntimeArgType): unknown {
  switch (type) {
    case "str":
    case "Any":
      return val;
    case "int":
      return parseIntegerInput(val) ?? val;
    case "float":
      return parseFixedInput(val) ?? val;
    case "bool":
      return val.toLowerCase() === "true" || val === "1";
    case "dict":
    case "list":
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
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
