export function resolveRequiredSecret(name: string, configured?: string | null | undefined): string {
  const value = configured?.trim() || process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }

  return value;
}
