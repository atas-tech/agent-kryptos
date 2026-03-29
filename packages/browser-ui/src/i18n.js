import { resolveLocale, resolveLocaleFromBrowser } from "@blindpass/i18n";
import en from "@blindpass/i18n/locales/en/browser-ui.json";
import vi from "@blindpass/i18n/locales/vi/browser-ui.json";

export const LOCALE_STORAGE_KEY = "blindpass_locale";

const translations = {
  en,
  vi
};

let activeLocale = "en";

function getValueByPath(source, path) {
  return path.split(".").reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), source);
}

function interpolate(template, params = {}) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => String(params[key] ?? ""));
}

function readStoredLocale() {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function currentLocale() {
  return activeLocale;
}

export function t(path, params) {
  const template = getValueByPath(translations[activeLocale], path) ?? getValueByPath(translations.en, path) ?? path;
  return typeof template === "string" ? interpolate(template, params) : path;
}

export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (!key) {
      return;
    }
    element.textContent = t(key);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder;
    if (!key || !("placeholder" in element)) {
      return;
    }
    element.placeholder = t(key);
  });

  document.title = t("meta.title");
}

export function initI18n(root = document) {
  activeLocale = resolveLocale(readStoredLocale() ?? resolveLocaleFromBrowser());
  root.documentElement.lang = activeLocale;
  applyTranslations(root);
  return activeLocale;
}
