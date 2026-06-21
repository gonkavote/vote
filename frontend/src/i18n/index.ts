// i18next setup. Imported once from main.tsx — initialises a shared
// instance reachable via useTranslation() and a direct `i18n.language`
// read for non-React utilities (e.g. format.ts).

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import enCommon from './locales/en/common.json'
import ruCommon from './locales/ru/common.json'

export const SUPPORTED_LANGUAGES = ['en', 'ru'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon },
      ru: { common: ruCommon },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'gonka_vote_locale',
      // Map e.g. ru-RU / ru-UA → ru, everything else → en. Keeps the set
      // of accepted codes tiny so we never accidentally try to render a
      // missing dictionary.
      convertDetectedLanguage: (lng: string) =>
        lng.toLowerCase().startsWith('ru') ? 'ru' : 'en',
    },
  })

export default i18n
