import copyRegistry from "virtual:tokentracker-copy-registry";
import zhCore from "../content/i18n/zh/core.json";
import zhDashboard from "../content/i18n/zh/dashboard.json";
import zhMarketing from "../content/i18n/zh/marketing.json";
import zhTwCore from "../content/i18n/zh-TW/core.json";
import zhTwDashboard from "../content/i18n/zh-TW/dashboard.json";
import zhTwMarketing from "../content/i18n/zh-TW/marketing.json";
import jaCore from "../content/i18n/ja/core.json";
import jaDashboard from "../content/i18n/ja/dashboard.json";
import jaMarketing from "../content/i18n/ja/marketing.json";
import koCore from "../content/i18n/ko/core.json";
import koDashboard from "../content/i18n/ko/dashboard.json";
import koMarketing from "../content/i18n/ko/marketing.json";
import deCore from "../content/i18n/de/core.json";
import deDashboard from "../content/i18n/de/dashboard.json";
import deMarketing from "../content/i18n/de/marketing.json";
import {
  DE_LOCALE,
  getInitialLocalePreference,
  normalizeResolvedLocale,
  resolvePreferredLocale,
  JA_LOCALE,
  KO_LOCALE,
  ZH_CN_LOCALE,
  ZH_TW_LOCALE,
} from "./locale";

const LOCALE_REGISTRIES: Record<string, TranslationRegistry> = {
  [ZH_CN_LOCALE]: {
    ...zhCore,
    ...zhDashboard,
    ...zhMarketing,
  },
  [ZH_TW_LOCALE]: {
    ...zhTwCore,
    ...zhTwDashboard,
    ...zhTwMarketing,
  },
  [JA_LOCALE]: {
    ...jaCore,
    ...jaDashboard,
    ...jaMarketing,
  },
  [KO_LOCALE]: {
    ...koCore,
    ...koDashboard,
    ...koMarketing,
  },
  [DE_LOCALE]: {
    ...deCore,
    ...deDashboard,
    ...deMarketing,
  },
};

type AnyRecord = Record<string, any>;
type TranslationRegistry = Record<string, string>;

let currentLocale = resolvePreferredLocale(getInitialLocalePreference());

function getLocaleRegistry() {
  return (LOCALE_REGISTRIES[currentLocale] || {}) as TranslationRegistry;
}

function getTranslatedText(key: any) {
  const value = getLocaleRegistry()[String(key)];
  return typeof value === "string" && value.trim() ? value : null;
}

function interpolate(text: any, params?: AnyRecord) {
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => {
    if (params[key] == null) return match;
    return String(params[key]);
  });
}

function normalizeText(text: any) {
  return String(text).replace(/\\n/g, "\n");
}

export function setCopyLocale(locale: any) {
  currentLocale = normalizeResolvedLocale(locale);
}

// The resolved locale that copy() is currently translating into. Mirrors the
// same module-level state copy() reads, so components can localize non-string
// output (e.g. date-fns formatting) without depending on LocaleProvider context.
export function getCopyLocale() {
  return currentLocale;
}

export function copy(key: any, params?: AnyRecord) {
  const normalizedKey = String(key);
  const baseText = Object.hasOwn(copyRegistry, normalizedKey)
    ? copyRegistry[normalizedKey]
    : undefined;
  if (typeof baseText !== "string" && import.meta?.env?.DEV) {
    console.warn(`Missing copy key: ${normalizedKey}`);
  }
  const text = getTranslatedText(normalizedKey) || baseText || normalizedKey;
  return interpolate(normalizeText(text), params);
}
