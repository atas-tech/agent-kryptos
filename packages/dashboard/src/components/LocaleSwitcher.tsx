import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@blindpass/i18n";
import { applyLocalePreference } from "../i18n/config.js";
import { useAuth } from "../auth/useAuth.js";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "EN",
  vi: "VI",
};

export function LocaleSwitcher() {
  const { i18n } = useTranslation();
  const { updatePreferredLocale } = useAuth();

  function handleChange(locale: SupportedLocale): void {
    const previousLocale = (i18n.language?.startsWith("vi") ? "vi" : "en") as SupportedLocale;
    void (async () => {
      try {
        await updatePreferredLocale(locale);
      } catch (error) {
        console.error("Failed to persist preferred locale:", error);
        await applyLocalePreference(previousLocale);
      }
    })();
  }

  const currentLocale = (i18n.language?.startsWith("vi") ? "vi" : "en") as SupportedLocale;

  return (
    <div className="locale-switcher" role="radiogroup" aria-label="Language">
      {SUPPORTED_LOCALES.map((locale) => (
        <button
          key={locale}
          aria-checked={currentLocale === locale}
          className={`locale-switcher__option${currentLocale === locale ? " locale-switcher__option--active" : ""}`}
          onClick={() => handleChange(locale)}
          role="radio"
          type="button"
        >
          {LOCALE_LABELS[locale]}
        </button>
      ))}
    </div>
  );
}
