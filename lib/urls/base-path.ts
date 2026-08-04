function normalizeBasePath(basePath: string | undefined) {
  const trimmed = basePath?.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * Prefix a same-origin, root-relative URL with the Next.js deployment path.
 * Absolute and protocol-relative URLs are intentionally left unchanged.
 */
export function withBasePath(
  url: string,
  basePath = process.env.NEXT_PUBLIC_BASE_PATH
) {
  const normalizedBasePath = normalizeBasePath(basePath);
  if (
    !normalizedBasePath ||
    !url.startsWith("/") ||
    url.startsWith("//") ||
    url === normalizedBasePath ||
    url.startsWith(`${normalizedBasePath}/`) ||
    url.startsWith(`${normalizedBasePath}?`) ||
    url.startsWith(`${normalizedBasePath}#`)
  ) {
    return url;
  }
  return `${normalizedBasePath}${url}`;
}
