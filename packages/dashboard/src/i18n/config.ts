import { resolveLocale, type SupportedLocale } from "@blindpass/i18n";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Import all English locale files
import commonEn from "@blindpass/i18n/locales/en/common.json";
import authEn from "@blindpass/i18n/locales/en/auth.json";
import dashboardEn from "@blindpass/i18n/locales/en/dashboard.json";
import agentsEn from "@blindpass/i18n/locales/en/agents.json";
import membersEn from "@blindpass/i18n/locales/en/members.json";
import billingEn from "@blindpass/i18n/locales/en/billing.json";
import auditEn from "@blindpass/i18n/locales/en/audit.json";
import approvalsEn from "@blindpass/i18n/locales/en/approvals.json";
import settingsEn from "@blindpass/i18n/locales/en/settings.json";
import layoutEn from "@blindpass/i18n/locales/en/layout.json";
import analyticsEn from "@blindpass/i18n/locales/en/analytics.json";
import offersEn from "@blindpass/i18n/locales/en/offers.json";
import policyEn from "@blindpass/i18n/locales/en/policy.json";

// Import all Vietnamese locale files
import commonVi from "@blindpass/i18n/locales/vi/common.json";
import authVi from "@blindpass/i18n/locales/vi/auth.json";
import dashboardVi from "@blindpass/i18n/locales/vi/dashboard.json";
import agentsVi from "@blindpass/i18n/locales/vi/agents.json";
import membersVi from "@blindpass/i18n/locales/vi/members.json";
import billingVi from "@blindpass/i18n/locales/vi/billing.json";
import auditVi from "@blindpass/i18n/locales/vi/audit.json";
import approvalsVi from "@blindpass/i18n/locales/vi/approvals.json";
import settingsVi from "@blindpass/i18n/locales/vi/settings.json";
import layoutVi from "@blindpass/i18n/locales/vi/layout.json";
import analyticsVi from "@blindpass/i18n/locales/vi/analytics.json";
import offersVi from "@blindpass/i18n/locales/vi/offers.json";
import policyVi from "@blindpass/i18n/locales/vi/policy.json";

export const defaultNS = "common";
export const LOCALE_STORAGE_KEY = "blindpass_locale";

export const resources = {
  en: {
    common: commonEn,
    auth: authEn,
    dashboard: dashboardEn,
    agents: agentsEn,
    members: membersEn,
    billing: billingEn,
    audit: auditEn,
    approvals: approvalsEn,
    settings: settingsEn,
    layout: layoutEn,
    analytics: analyticsEn,
    offers: offersEn,
    policy: policyEn,
  },
  vi: {
    common: commonVi,
    auth: authVi,
    dashboard: dashboardVi,
    agents: agentsVi,
    members: membersVi,
    billing: billingVi,
    audit: auditVi,
    approvals: approvalsVi,
    settings: settingsVi,
    layout: layoutVi,
    analytics: analyticsVi,
    offers: offersVi,
    policy: policyVi,
  },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    defaultNS,
    fallbackLng: "en",
    supportedLngs: ["en", "vi"],
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

export function currentLocale(): SupportedLocale {
  return resolveLocale(i18n.resolvedLanguage ?? i18n.language ?? null);
}

export async function applyLocalePreference(raw: string | null | undefined): Promise<SupportedLocale> {
  const locale = resolveLocale(raw);
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }
  if (i18n.resolvedLanguage !== locale) {
    await i18n.changeLanguage(locale);
  }
  return locale;
}

export default i18n;
