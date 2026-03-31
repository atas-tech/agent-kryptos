import { ChevronDown, Globe, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@blindpass/i18n";
import { applyLocalePreference } from "../i18n/config.js";
import { useAuth } from "../auth/useAuth.js";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  vi: "Tiếng Việt",
};

const LOCALE_SHORT: Record<SupportedLocale, string> = {
  en: "EN",
  vi: "VI",
};

export function LocaleSwitcher() {
  const { i18n } = useTranslation();
  const { updatePreferredLocale } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentLocale = (i18n.language?.startsWith("vi") ? "vi" : "en") as SupportedLocale;

  function handleSelect(locale: SupportedLocale): void {
    if (locale === currentLocale) {
      setOpen(false);
      return;
    }

    const previousLocale = currentLocale;
    setOpen(false);

    void (async () => {
      try {
        await updatePreferredLocale(locale);
      } catch (error) {
        console.error("Failed to persist preferred locale:", error);
        await applyLocalePreference(previousLocale);
      }
    })();
  }

  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
      setOpen(false);
    }
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, handleClickOutside, handleKeyDown]);

  return (
    <div className="locale-switcher" ref={containerRef}>
      <button
        className="locale-switcher__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Change language"
        data-testid="locale-select"
        type="button"
      >
        <Globe className="locale-switcher__icon" size={14} />
        <span className="locale-switcher__label">{LOCALE_SHORT[currentLocale]}</span>
        <ChevronDown className={`locale-switcher__chevron${open ? " locale-switcher__chevron--open" : ""}`} size={14} />
      </button>

      {open && (
        <div className="locale-switcher__menu" role="listbox" aria-activedescendant={`locale-${currentLocale}`}>
          {(Object.keys(LOCALE_LABELS) as SupportedLocale[]).map((locale) => (
            <button
              key={locale}
              id={`locale-${locale}`}
              className={`locale-switcher__item${currentLocale === locale ? " locale-switcher__item--active" : ""}`}
              onClick={() => handleSelect(locale)}
              role="option"
              aria-selected={currentLocale === locale}
              data-testid={`locale-option-${locale}`}
              type="button"
            >
              <span className="locale-switcher__item-label">
                <span className="locale-switcher__item-short">{LOCALE_SHORT[locale]}</span>
                {LOCALE_LABELS[locale]}
              </span>
              {currentLocale === locale && <Check size={14} className="locale-switcher__check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
