/** Supported locale codes */
export const SUPPORTED_LOCALES = ["en", "vi"] as const;

/** Type representing a supported locale */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Default locale used as fallback */
export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Check if a locale code is supported */
export function isSupportedLocale(code: string): code is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(code);
}
