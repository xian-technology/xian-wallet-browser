import type {
  PopupState,
  WalletDetectedAsset
} from "@xian-tech/wallet-core";

import type { PopupRuntimeState } from "../shared/messages";
import { escapeAttribute, escapeHtml } from "./format";

export type DisplayedAsset =
  | PopupState["watchedAssets"][number]
  | WalletDetectedAsset;

const ASSET_GRADIENTS = [
  "linear-gradient(135deg, #5B6CFF, #3730A3)",
  "linear-gradient(135deg, #FF6B9D, #BE185D)",
  "linear-gradient(135deg, #FF8A4C, #C2410C)",
  "linear-gradient(135deg, #2DD4BF, #0F766E)",
  "linear-gradient(135deg, #A78BFA, #6D28D9)",
  "linear-gradient(135deg, #FBBF24, #B45309)",
  "linear-gradient(135deg, #FB7185, #9F1239)",
  "linear-gradient(135deg, #60A5FA, #1D4ED8)",
  "linear-gradient(135deg, #F472B6, #86198F)",
  "linear-gradient(135deg, #818CF8, #3730A3)"
];

export function assetGradient(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return (
    ASSET_GRADIENTS[Math.abs(hash) % ASSET_GRADIENTS.length] ??
    ASSET_GRADIENTS[0]!
  );
}

export function tokenIconSource(icon: string | null | undefined): string | null {
  const trimmed = typeof icon === "string" ? icon.trim() : "";
  if (!trimmed) {
    return null;
  }
  if (/^<svg[\s>]/i.test(trimmed) || /^<\?xml/i.test(trimmed)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

export function renderTokenIcon(options: {
  contract: string;
  symbol: string;
  icon?: string | null;
  className?: string;
  size?: number;
  fontSize?: number;
  background?: string;
  style?: string;
}): string {
  const symbol = options.symbol || options.contract.slice(0, 6);
  const letter = symbol.charAt(0).toUpperCase();
  const size = options.size ?? 36;
  const fontSize = options.fontSize ?? 14;
  const className = options.className ?? "token-icon";
  const src = tokenIconSource(options.icon);
  const isNativeXianLogo = options.contract === "currency" && Boolean(src);
  const imageSize = isNativeXianLogo ? Math.round(size * 0.7) : size;
  const imageStyle = isNativeXianLogo
    ? `width: ${imageSize}px; height: ${imageSize}px; border-radius: 0`
    : "";
  const styleParts = [
    `width: ${size}px`,
    `height: ${size}px`,
    `font-size: ${fontSize}px`
  ];
  const fallbackBackground =
    options.background ?? assetGradient(options.contract);

  if (!src) {
    styleParts.push(`background: ${fallbackBackground}`);
  }
  if (options.style) {
    styleParts.push(options.style);
  }

  const style = escapeAttribute(styleParts.join("; "));
  if (src) {
    return `
      <div class="${className}" style="${style}" data-token-icon-frame data-fallback-bg="${escapeAttribute(fallbackBackground)}">
        <img data-token-icon-image src="${escapeAttribute(src)}" alt="" width="${imageSize}" height="${imageSize}"${imageStyle ? ` style="${escapeAttribute(imageStyle)}"` : ""} />
        <span hidden>${escapeHtml(letter)}</span>
      </div>
    `;
  }

  return `
    <div class="${className}" style="${style}">
      ${escapeHtml(letter)}
    </div>
  `;
}

export function isDetectedAsset(
  asset: DisplayedAsset
): asset is WalletDetectedAsset {
  return "tracked" in asset;
}

export function visibleDetectedAssets(
  state: PopupRuntimeState
): WalletDetectedAsset[] {
  return state.detectedAssets.filter((asset) => !asset.tracked);
}

export function activeAssetNetworkState(
  state: PopupRuntimeState,
  contract: string
) {
  const networkId = state.activeNetworkId ?? "";
  return state.assetNetworkStates?.[networkId]?.[contract];
}

export function isAssetUnavailableOnActiveNetwork(
  state: PopupRuntimeState,
  asset: PopupState["watchedAssets"][number]
): boolean {
  if (asset.contract === "currency") {
    return false;
  }
  return activeAssetNetworkState(state, asset.contract)?.status === "not_found";
}

export function isAssetHiddenOnActiveNetwork(
  state: PopupRuntimeState,
  asset: PopupState["watchedAssets"][number]
): boolean {
  return (
    activeAssetNetworkState(state, asset.contract)?.hidden ??
    asset.hidden === true
  );
}

export function visibleWatchedAssets(
  state: PopupRuntimeState
): PopupState["watchedAssets"] {
  return [...state.watchedAssets]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter(
      (asset) =>
        !isAssetHiddenOnActiveNetwork(state, asset) &&
        !isAssetUnavailableOnActiveNetwork(state, asset)
    );
}

export function hiddenAssetCount(state: PopupRuntimeState): number {
  return state.watchedAssets.filter((asset) =>
    isAssetHiddenOnActiveNetwork(state, asset)
  ).length;
}

export function unavailableAssetCount(state: PopupRuntimeState): number {
  return state.watchedAssets.filter((asset) =>
    isAssetUnavailableOnActiveNetwork(state, asset)
  ).length;
}

export function unavailableAssetLabel(state: PopupRuntimeState): string {
  return state.activeNetworkName
    ? `Unavailable on ${state.activeNetworkName}`
    : "Unavailable on this network";
}

export function findDisplayedAsset(
  state: PopupRuntimeState,
  contract: string
): DisplayedAsset | null {
  return (
    state.watchedAssets.find((asset) => asset.contract === contract) ??
    state.detectedAssets.find((asset) => asset.contract === contract) ??
    null
  );
}

export function assetRawBalance(
  asset: DisplayedAsset,
  state: PopupRuntimeState
): string | null {
  const trackedBalance = state.assetBalances[asset.contract];
  if (trackedBalance != null) {
    return trackedBalance;
  }
  return isDetectedAsset(asset) ? asset.balance : null;
}

export function visibleAssetContracts(state: PopupRuntimeState): string[] {
  const contracts = new Set(
    visibleWatchedAssets(state).map((asset) => asset.contract)
  );
  for (const asset of visibleDetectedAssets(state)) {
    contracts.add(asset.contract);
  }
  return [...contracts];
}

export function balanceStateKey(contract: string, address: string): string {
  return `${contract}.balances:${address}`;
}

export function normalizeLiveBalance(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
