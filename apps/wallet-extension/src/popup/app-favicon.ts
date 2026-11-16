import { escapeAttribute, escapeHtml } from "./format";

/**
 * A connected dapp's icon frame: the dapp's own icon (collected from its page)
 * over a letter placeholder. Without an icon only the placeholder shows; no
 * third-party favicon service is asked, so nobody learns which dapps the user
 * connected.
 */
export function renderAppFavicon(icon: {
  letter: string;
  background: string;
  iconUrl: string | undefined;
}): string {
  const image = icon.iconUrl
    ? `<img class="app-favicon" data-app-favicon src="${escapeAttribute(icon.iconUrl)}" alt="" width="32" height="32" />`
    : "";
  return `<div class="app-favicon-frame" style="--app-favicon-bg: ${escapeAttribute(icon.background)}">
          <span class="app-favicon-placeholder" aria-hidden="true">${escapeHtml(icon.letter)}</span>
          ${image}
        </div>`;
}
