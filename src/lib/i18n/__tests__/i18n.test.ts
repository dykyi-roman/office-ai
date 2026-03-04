import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  translations,
  type Locale,
  type TranslationKey,
} from "../translations";

vi.mock("$lib/stores/settings.svelte", () => {
  let language: Locale = "en";
  return {
    getSetting: (key: string) => {
      if (key === "language") return language;
      return undefined;
    },
    setSetting: (key: string, value: string) => {
      if (key === "language") language = value as Locale;
    },
  };
});

import { t, getLocale, SUPPORTED_LOCALES } from "../index";
import { setSetting } from "$lib/stores/settings.svelte";

beforeEach(() => {
  setSetting("language", "en");
});

describe("translations completeness", () => {
  const enKeys = Object.keys(translations.en) as TranslationKey[];
  const locales: Locale[] = ["es", "ru", "fr", "de", "hi", "it", "ar", "pt", "ja", "zh"];

  for (const locale of locales) {
    it(`${locale} has all keys from en`, () => {
      const missing = enKeys.filter(
        (key) => !(key in translations[locale]),
      );
      expect(missing).toEqual([]);
    });

    it(`${locale} has no extra keys beyond en`, () => {
      const localeKeys = Object.keys(translations[locale]);
      const extra = localeKeys.filter(
        (key) => !(key in translations.en),
      );
      expect(extra).toEqual([]);
    });
  }
});

describe("t() function", () => {
  it("returns English text by default", () => {
    expect(t("app.settings")).toBe("Settings");
  });

  it("returns Spanish text when language is es", () => {
    setSetting("language", "es");
    expect(t("app.settings")).toBe("Ajustes");
  });

  it("returns Russian text when language is ru", () => {
    setSetting("language", "ru");
    expect(t("app.settings")).toBe("Настройки");
  });

  it("returns French text when language is fr", () => {
    setSetting("language", "fr");
    expect(t("app.settings")).toBe("Paramètres");
  });

  it("returns Japanese text when language is ja", () => {
    setSetting("language", "ja");
    expect(t("app.settings")).toBe("設定");
  });

  it("returns translated status labels", () => {
    setSetting("language", "ru");
    expect(t("status.idle")).toBe("Свободен");
    expect(t("status.thinking")).toBe("Думает...");
  });

  it("returns Spanish status labels", () => {
    setSetting("language", "es");
    expect(t("status.idle")).toBe("Inactivo");
    expect(t("status.task_complete")).toBe("Tarea completada");
  });

  it("returns German status labels", () => {
    setSetting("language", "de");
    expect(t("status.idle")).toBe("Inaktiv");
    expect(t("status.thinking")).toBe("Denkt nach...");
  });

  it("returns Chinese status labels", () => {
    setSetting("language", "zh");
    expect(t("status.idle")).toBe("空闲");
    expect(t("status.task_complete")).toBe("任务完成");
  });

  it("falls back to English for unknown locale", () => {
    setSetting("language", "xx" as Locale);
    expect(t("app.settings")).toBe("Settings");
  });
});

describe("getLocale()", () => {
  it("returns current locale", () => {
    expect(getLocale()).toBe("en");
    setSetting("language", "ru");
    expect(getLocale()).toBe("ru");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("contains all 11 locales", () => {
    const values = SUPPORTED_LOCALES.map((l) => l.value);
    expect(values).toContain("ar");
    expect(values).toContain("de");
    expect(values).toContain("en");
    expect(values).toContain("es");
    expect(values).toContain("fr");
    expect(values).toContain("hi");
    expect(values).toContain("it");
    expect(values).toContain("ja");
    expect(values).toContain("pt");
    expect(values).toContain("ru");
    expect(values).toContain("zh");
  });

  it("has native language labels", () => {
    const labels = SUPPORTED_LOCALES.map((l) => l.label);
    expect(labels).toContain("English");
    expect(labels).toContain("Español");
    expect(labels).toContain("Русский");
    expect(labels).toContain("Français");
    expect(labels).toContain("Deutsch");
    expect(labels).toContain("日本語");
    expect(labels).toContain("中文");
  });

  it("has exactly 11 locales", () => {
    expect(SUPPORTED_LOCALES).toHaveLength(11);
  });
});

describe("translation values are non-empty strings", () => {
  const locales: Locale[] = ["en", "es", "ru", "fr", "de", "hi", "it", "ar", "pt", "ja", "zh"];

  for (const locale of locales) {
    it(`all values in ${locale} are non-empty`, () => {
      const dict = translations[locale];
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(typeof value, `${locale}.${key}`).toBe("string");
      }
    });
  }
});
