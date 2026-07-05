const BRACKETED_IPV6_HOSTNAME_RE = /^\[(.*)\]$/;

export function normalizeUrlHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const bracketedIpv6 = BRACKETED_IPV6_HOSTNAME_RE.exec(trimmed);
  return (bracketedIpv6?.[1] ?? trimmed).toLowerCase();
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = normalizeUrlHostname(url.hostname);
    return (
      url.protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "::1" ||
        /^127(?:\.\d{1,3}){3}$/.test(hostname))
    );
  } catch {
    return false;
  }
}

export function assertRpcTransportAllowed(
  rpcUrl: string,
  allowInsecureHttp: boolean | undefined
): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new TypeError("network preset rpcUrl must be a valid URL");
  }
  if (
    parsed.protocol === "http:" &&
    !allowInsecureHttp &&
    !isLoopbackHttpUrl(rpcUrl)
  ) {
    throw new Error(
      "HTTP RPC URLs are disabled for this network. Enable HTTP data transfers only for endpoints you trust."
    );
  }
}
