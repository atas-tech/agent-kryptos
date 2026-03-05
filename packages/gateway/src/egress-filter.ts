export function sanitizeOutbound(text: string): { filtered: boolean; sanitized: string } {
  const urlRegex = /https?:\/\/\S+/g;
  const sanitized = text.replace(urlRegex, "[REDACTED_URL]");
  return { filtered: sanitized !== text, sanitized };
}
