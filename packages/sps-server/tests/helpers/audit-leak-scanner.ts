const SECRET_PATTERNS = [
  /\bak_[A-Za-z0-9._-]+\b/,
  /\bsk_[A-Za-z0-9._-]+\b/,
  /"ciphertext"\s*:/i,
  /"temporary_password"\s*:/i
];

export function findAuditLeaks(payload: unknown): string[] {
  const serialized = JSON.stringify(payload);
  if (!serialized) {
    return [];
  }

  return SECRET_PATTERNS.flatMap((pattern) => {
    const match = serialized.match(pattern);
    return match ? [match[0]] : [];
  });
}
