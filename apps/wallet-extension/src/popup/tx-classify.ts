import { ICONS } from "./icons";

/**
 * Transaction activity row returned by the `/txs_by_sender` RPC. Fields are
 * kept optional where the backend has historically omitted them.
 */
export interface ActivityTx {
  hash: string;
  contract: string;
  function: string;
  sender: string;
  success: boolean;
  chi_used?: number | null;
  created_at?: string | null;
  block_height?: number | null;
  block_hash?: string | null;
  block_time?: string | number | null;
  tx_index?: number | null;
  nonce?: number | null;
  status_code?: number | null;
  result?: unknown;
  payload?: {
    sender?: string;
    nonce?: number;
    contract?: string;
    function?: string;
    kwargs?: Record<string, unknown>;
    stamps_supplied?: number;
    [key: string]: unknown;
  } | null;
  envelope?: unknown;
}

export type TxCategory =
  | "send"
  | "receive"
  | "buy"
  | "sell"
  | "swap"
  | "add_liquidity"
  | "remove_liquidity"
  | "create_token"
  | "approve"
  | "contract";

export type TxAccent = "success" | "danger" | "info" | "warning" | "accent" | "neutral";

export interface TxClassification {
  category: TxCategory;
  label: string;
  icon: string;
  accent: TxAccent;
}

export const TX_ACCENT_BG: Record<TxAccent, string> = {
  success: "var(--success-soft, rgba(173,255,47,0.12))",
  danger: "var(--danger-soft, rgba(255,77,79,0.12))",
  info: "var(--accent-soft, rgba(173,255,47,0.08))",
  warning: "var(--warning-soft, rgba(250,173,20,0.12))",
  accent: "var(--accent-soft, rgba(173,255,47,0.08))",
  neutral: "var(--bg-3, rgba(255,255,255,0.06))",
};

export const TX_ACCENT_FG: Record<TxAccent, string> = {
  success: "var(--success, #adff2f)",
  danger: "var(--danger, #ff4d4f)",
  info: "var(--accent, #adff2f)",
  warning: "var(--warning, #faad14)",
  accent: "var(--accent, #adff2f)",
  neutral: "var(--muted, #888)",
};

const DEX_CONTRACT = "con_dex";
const TOKEN_FACTORY_CONTRACT = "token_factory";

export function classifyTx(tx: ActivityTx): TxClassification {
  const contract = tx.contract ?? "";
  const fn = tx.function ?? "";
  const kwargs = (tx.payload?.kwargs ?? {}) as Record<string, unknown>;

  if (contract === TOKEN_FACTORY_CONTRACT && fn === "create_token") {
    return { category: "create_token", label: "Create token", icon: ICONS.sparkles, accent: "accent" };
  }

  if (contract === DEX_CONTRACT) {
    if (fn === "addLiquidity") {
      return { category: "add_liquidity", label: "Add liquidity", icon: ICONS.dropletPlus, accent: "info" };
    }
    if (fn === "removeLiquidity") {
      return { category: "remove_liquidity", label: "Remove liquidity", icon: ICONS.dropletMinus, accent: "warning" };
    }
    if (fn.startsWith("swap")) {
      const src = typeof kwargs.src === "string" ? (kwargs.src as string) : null;
      const path = Array.isArray(kwargs.path) ? (kwargs.path as unknown[]) : null;
      const last = path && path.length > 0 ? path[path.length - 1] : null;
      if (src === "currency") {
        return { category: "buy", label: "Buy", icon: ICONS.trendingUp, accent: "success" };
      }
      if (typeof last === "string" && last === "currency") {
        return { category: "sell", label: "Sell", icon: ICONS.trendingDown, accent: "danger" };
      }
      return { category: "swap", label: "Swap", icon: ICONS.repeat, accent: "info" };
    }
  }

  if (fn === "transfer") {
    return { category: "send", label: "Send", icon: ICONS.arrowUp, accent: "danger" };
  }
  if (fn === "transfer_from") {
    return { category: "send", label: "Transfer from", icon: ICONS.arrowUp, accent: "danger" };
  }
  if (fn === "approve") {
    return { category: "approve", label: "Approve", icon: ICONS.shieldCheck, accent: "warning" };
  }

  return { category: "contract", label: "Contract call", icon: ICONS.zap, accent: "neutral" };
}

export function formatTxAmount(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
    }
    return trimmed;
  }
  if (typeof value === "object" && value && "__fixed__" in (value as Record<string, unknown>)) {
    const fixed = (value as Record<string, unknown>).__fixed__;
    if (typeof fixed === "string" || typeof fixed === "number") {
      return formatTxAmount(fixed);
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function formatTxArgValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "__fixed__" in (value as Record<string, unknown>)) {
    const fixed = (value as Record<string, unknown>).__fixed__;
    if (typeof fixed === "string" || typeof fixed === "number") return String(fixed);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatTxTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toLocaleString();
    }
    return trimmed;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const asMillis = raw > 1e12 ? raw : raw * 1000;
    return new Date(asMillis).toLocaleString();
  }
  return null;
}
