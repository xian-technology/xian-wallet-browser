import { encode as encodeQr } from "uqr";

export function escapeHtml(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

export function escapeAttribute(value: unknown): string {
  return escapeHtml(value).split("`").join("&#96;");
}

export function safeOriginLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname || origin;
  } catch {
    return origin;
  }
}

export function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function normalizeDecimalParts(value: string):
  | { negative: boolean; integer: string; fraction: string }
  | null {
  const match = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(
    value
  );
  if (!match) {
    return null;
  }

  const integerPart = match[2] ?? "";
  const fractionPart = match[3] ?? match[4] ?? "";
  const exponent = match[5] ? Number.parseInt(match[5], 10) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    return null;
  }
  const digits = `${integerPart}${fractionPart}`;
  const decimalIndex = integerPart.length + exponent;

  let integer: string;
  let fraction: string;
  if (decimalIndex <= 0) {
    integer = "0";
    fraction = `${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  } else if (decimalIndex >= digits.length) {
    integer = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    fraction = "";
  } else {
    integer = digits.slice(0, decimalIndex);
    fraction = digits.slice(decimalIndex);
  }

  integer = integer.replace(/^0+(?=\d)/, "") || "0";
  return {
    negative: match[1] === "-",
    integer,
    fraction
  };
}

function groupIntegerDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatBalance(
  raw: string | null | undefined,
  decimals: number | undefined
): string {
  const value = raw?.trim();
  if (!value) {
    return "—";
  }

  const parts = normalizeDecimalParts(value);
  if (!parts) {
    return raw ?? "—";
  }

  const decimalPlaces =
    typeof decimals === "number" && Number.isInteger(decimals)
      ? Math.min(Math.max(decimals, 0), 18)
      : 8;
  const fraction =
    decimalPlaces > 0
      ? parts.fraction.slice(0, decimalPlaces).replace(/0+$/, "")
      : "";
  const hasValue =
    parts.integer !== "0" || [...fraction].some((digit) => digit !== "0");
  const sign = parts.negative && hasValue ? "-" : "";
  const groupedInteger = groupIntegerDigits(parts.integer);

  return fraction
    ? `${sign}${groupedInteger}.${fraction}`
    : `${sign}${groupedInteger}`;
}

export function isValidXianAddress(addr: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(addr);
}

export function truncateHash(hash: string, headLen = 10, tailLen = 8): string {
  if (hash.length <= headLen + tailLen + 3) {
    return hash;
  }
  return `${hash.slice(0, headLen)}...${hash.slice(-tailLen)}`;
}

export function generateQrSvg(text: string): string {
  const { data } = encodeQr(text, { ecc: "M" });
  const count = data.length;
  const margin = 2;
  const total = count + margin * 2;
  let d = "";
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (data[y]![x]) {
        d += `M${x + margin},${y + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#fff" rx="1"/><path d="${d}" fill="#000"/></svg>`;
}
