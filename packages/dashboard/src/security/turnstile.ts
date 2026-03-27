export interface TurnstileRenderOptions {
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions & { sitekey: string }): string;
  reset(widgetId: string): void;
  remove?(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function turnstileSiteKey(): string | null {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
  return siteKey ? siteKey : null;
}

export function turnstileEnabled(): boolean {
  return turnstileSiteKey() !== null;
}
