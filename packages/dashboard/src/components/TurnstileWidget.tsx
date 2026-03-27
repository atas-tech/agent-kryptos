import { useEffect, useRef, useState } from "react";
import { turnstileEnabled, turnstileSiteKey } from "../security/turnstile.js";

const TURNSTILE_SCRIPT_ID = "blindpass-turnstile-script";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if (window.turnstile) {
    return Promise.resolve();
  }

  const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    if (existing.dataset.loaded === "true") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Turnstile")), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Failed to load Turnstile")), { once: true });
    document.head.appendChild(script);
  });
}

interface TurnstileWidgetProps {
  onTokenChange: (token: string | null) => void;
}

export function TurnstileWidget({ onTokenChange }: TurnstileWidgetProps) {
  const enabled = turnstileEnabled();
  const siteKey = turnstileSiteKey();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !siteKey || !containerRef.current) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !containerRef.current || !window.turnstile || widgetIdRef.current) {
          return;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (token) => {
            onTokenChange(token);
            setLoadError(null);
          },
          "error-callback": () => {
            onTokenChange(null);
            setLoadError("Human verification could not be initialized. Retry in a moment.");
          },
          "expired-callback": () => {
            onTokenChange(null);
          }
        });
      } catch {
        if (!cancelled) {
          onTokenChange(null);
          setLoadError("Human verification could not be initialized. Retry in a moment.");
        }
      }
    })();

    return () => {
      cancelled = true;
      const widgetId = widgetIdRef.current;
      if (widgetId && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
      widgetIdRef.current = null;
    };
  }, [enabled, onTokenChange, siteKey]);

  if (!enabled) {
    return (
      <div className="turnstile-placeholder turnstile-placeholder--info">
        <div className="checkbox-proxy" />
        <div>
          <strong>Human verification disabled</strong>
          <span>Turnstile is skipped because no site key is configured for this environment.</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="turnstile-placeholder turnstile-placeholder--warning">
        <div className="checkbox-proxy" />
        <div>
          <strong>Human verification unavailable</strong>
          <span>{loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="turnstile-placeholder">
      <div aria-hidden="true" className="checkbox-proxy" />
      <div className="turnstile-placeholder__copy">
        <strong>Verify you are human</strong>
        <span>Complete the Turnstile challenge before continuing.</span>
      </div>
      <div className="turnstile-widget" ref={containerRef} />
    </div>
  );
}
