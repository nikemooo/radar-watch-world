/**
 * Locale handling.
 *
 * The system language is the default: whatever the browser reports is what the
 * app speaks, with English as the fallback for languages that do not ship a
 * dictionary yet. A manual choice always wins and is remembered.
 *
 * Detection happens after hydration (the server cannot know the visitor's
 * language), so the first render is identical on both sides and no hydration
 * mismatch is possible.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dictionaries, en, LOCALES, RTL_LOCALES, type Locale, type TranslationKey } from "./dictionary";

export type { Locale, TranslationKey };
export { LOCALES };

const STORAGE_KEY = "radar.locale";

export type TranslateVars = Record<string, string | number>;

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function translate(locale: Locale, key: TranslationKey, vars?: TranslateVars): string {
  const table = dictionaries[locale] ?? en;
  return interpolate(table[key] ?? en[key] ?? key, vars);
}

/** The best supported locale for a list of browser language tags. */
export function matchLocale(preferred: readonly string[]): Locale | null {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0] as Locale;
    if (LOCALES.includes(base)) return base;
  }
  return null;
}

function storedLocale(): Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && LOCALES.includes(raw as Locale) ? (raw as Locale) : null;
  } catch {
    return null;
  }
}

/** The browser's own language, regardless of whether we can speak it. */
function systemLanguageTag(): string {
  return (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
}

type I18nValue = {
  locale: Locale;
  /** True while the app is using the system language rather than a manual pick. */
  usingSystemLanguage: boolean;
  systemTag: string;
  dir: "ltr" | "rtl";
  t: (key: TranslationKey, vars?: TranslateVars) => string;
  setLocale: (locale: Locale | null) => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // "en" on both server and first client render; the real language is applied
  // in the effect below, so hydration always matches.
  const [locale, setLocaleState] = useState<Locale>("en");
  const [manual, setManual] = useState(false);
  const [systemTag, setSystemTag] = useState("en");

  useEffect(() => {
    const stored = storedLocale();
    const tag = systemLanguageTag();
    setSystemTag(tag);
    if (stored) {
      setManual(true);
      setLocaleState(stored);
      return;
    }
    const detected = matchLocale(navigator.languages ?? [navigator.language]);
    if (detected) setLocaleState(detected);
  }, []);

  const dir: "ltr" | "rtl" = RTL_LOCALES.includes(systemTag.split("-")[0]!) && !manual ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const setLocale = useCallback((next: Locale | null) => {
    try {
      if (next) window.localStorage.setItem(STORAGE_KEY, next);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage may be unavailable; the choice still applies for this session */
    }
    if (next) {
      setManual(true);
      setLocaleState(next);
    } else {
      setManual(false);
      setLocaleState(matchLocale(navigator.languages ?? [navigator.language]) ?? "en");
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      usingSystemLanguage: !manual,
      systemTag,
      dir,
      t: (key, vars) => translate(locale, key, vars),
      setLocale,
    }),
    [locale, manual, systemTag, dir, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  // Never crash a component that renders outside the provider (tests, isolated
  // stories): English is always a valid answer.
  return {
    locale: "en",
    usingSystemLanguage: true,
    systemTag: "en",
    dir: "ltr",
    t: (key, vars) => translate("en", key, vars),
    setLocale: () => undefined,
  };
}

/** Shorthand for the common case. */
export function useT() {
  return useI18n().t;
}

/** Locale-aware date/time formatting, so no page hardcodes "sv-SE". */
export function useFormatDateTime() {
  const { locale } = useI18n();
  return useCallback(
    (value: string | Date | null | undefined) => {
      if (!value) return "";
      const date = typeof value === "string" ? new Date(value) : value;
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString(locale);
    },
    [locale],
  );
}

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", sv: "Svenska" };
