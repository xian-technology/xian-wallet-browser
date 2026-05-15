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
