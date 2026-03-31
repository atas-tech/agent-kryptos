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
    <div className="locale-switcher" role="radiogroup">
      {(["en", "vi"] as const).map((locale) => (
        <label
          key={locale}
          className={`locale-switcher__option${currentLocale === locale ? " locale-switcher__option--active" : ""}`}
          data-testid={`locale-label-${locale}`}
        >
          <input
            className="locale-switcher__input"
            name="locale-switcher"
            onChange={() => handleChange(locale)}
            type="radio"
            checked={currentLocale === locale}
            data-testid={`locale-toggle-${locale}`}
          />
          {LOCALE_LABELS[locale]}
        </label>
      ))}
    </div>
  );
}
