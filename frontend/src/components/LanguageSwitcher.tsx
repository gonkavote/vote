// Compact language picker that lives in the page header.
// Persists to localStorage via i18next-browser-languagedetector's caches.

import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '../i18n'

const LABELS: Record<string, string> = {
  en: 'EN',
  ru: 'RU',
}

export function LanguageSwitcher() {
  const { i18n } = useTranslation()
  const current = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)

  return (
    <select
      aria-label="Language"
      value={current}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="bg-white/5 border border-border text-text text-sm font-medium rounded-lg px-3 py-2 leading-none hover:bg-white/10 focus:outline-none focus:border-accent/50 cursor-pointer transition-all"
    >
      {SUPPORTED_LANGUAGES.map((lng) => (
        <option key={lng} value={lng} className="bg-bg-card text-text">
          {LABELS[lng] ?? lng.toUpperCase()}
        </option>
      ))}
    </select>
  )
}
