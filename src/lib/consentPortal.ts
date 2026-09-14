/** Use only the deployed portal origin. Never navigate to a tool-supplied OAuth URL. */
export function consentPortalUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.search || url.hash || url.pathname !== '/' ||
        !/^[a-z0-9-]+\.consent-portal\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) return '';
    return url.origin;
  } catch { return ''; }
}
