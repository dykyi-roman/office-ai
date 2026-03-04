// Reactive i18n module — reads language from settings store

import { getSetting } from "$lib/stores/settings.svelte";
import { translations, type Locale, type TranslationKey } from "./translations";

export type { Locale, TranslationKey };

export function t(key: TranslationKey): string {
  const locale = getSetting("language") as Locale;
  const dict = translations[locale] ?? translations.en;
  return dict[key] ?? translations.en[key] ?? key;
}

export function getLocale(): Locale {
  return getSetting("language") as Locale;
}

export const SUPPORTED_LOCALES: readonly { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "hi", label: "हिन्दी" },
  { value: "it", label: "Italiano" },
  { value: "ja", label: "日本語" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
  { value: "zh", label: "中文" },
];
