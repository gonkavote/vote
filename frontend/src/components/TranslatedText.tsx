// Renders user-generated text (proposal title/summary/description, comment body)
// with a small toggle that lets the reader flip between the translation and
// the original. The actual choice is *controlled* from outside (`mode` prop)
// so several fields of one entity (e.g. title + summary + description of a
// proposal) can be flipped together by a single header button.
//
// Flow:
//   - status='pending' → show original + 🌐 Translating… pill (no toggle yet).
//   - status='ready' AND isTranslated=true → show translated, with toggle.
//   - status='ready' AND isTranslated=false → show original, no UI.
//   - status='failed' → show original, no UI (silent fallback).

import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TranslationStatus } from '../lib/api'

export type TranslationMode = 'translated' | 'original'

interface Props {
  /** The translated text returned by the API for the current ui locale. */
  translated: string
  /** The author's original. Required when isTranslated=true. */
  original?: string | null
  isTranslated: boolean
  status: TranslationStatus
  mode: TranslationMode
  /** Optional rich renderer (e.g. <ReactMarkdown>) applied to the chosen text. */
  render?: (text: string) => ReactNode
  /** Wrapper element/className for the rendered text. */
  as?: keyof JSX.IntrinsicElements
  className?: string
}

export function TranslatedText({
  translated,
  original,
  isTranslated,
  status,
  mode,
  render,
  as: Tag = 'span',
  className,
}: Props) {
  const showOriginal = mode === 'original' && isTranslated && original != null
  const text = showOriginal ? (original as string) : translated
  const content = render ? render(text) : text
  return <Tag className={className}>{content}</Tag>
}

/**
 * Pill-shaped button that flips between translated ↔ original. Also surfaces
 * the 'pending' state. Use it once per entity (one button for the whole
 * proposal, not three).
 */
export function TranslationToggle({
  isTranslated,
  status,
  mode,
  onChange,
  sourceLang,
  className,
}: {
  isTranslated: boolean
  status: TranslationStatus
  mode: TranslationMode
  onChange: (next: TranslationMode) => void
  /** ISO 2-letter, used to label the original ("Show original (Русский)"). */
  sourceLang: string
  className?: string
}) {
  const { t } = useTranslation()
  if (status === 'pending') {
    return (
      <span
        className={`pill bg-accent/10 text-accent-2 text-xs ${className || ''}`}
        title={t('translation.pending')}
      >
        {t('translation.pending')}
      </span>
    )
  }
  if (status === 'failed' || !isTranslated) return null

  const langLabel = labelForLang(sourceLang, t)
  const isShowingOriginal = mode === 'original'
  return (
    <button
      type="button"
      onClick={() => onChange(isShowingOriginal ? 'translated' : 'original')}
      className={`pill bg-white/5 text-text-2 hover:bg-white/10 text-xs cursor-pointer transition-colors ${className || ''}`}
      title={t('translation.translatedFromShort', { lang: langLabel })}
    >
      {isShowingOriginal
        ? t('translation.showTranslation')
        : `${t('translation.showOriginal')} (${langLabel})`}
    </button>
  )
}

function labelForLang(code: string, t: (k: string) => string): string {
  const c = (code || '').toLowerCase()
  if (c === 'en') return t('lang.english')
  if (c === 'ru') return t('lang.russian')
  return code.toUpperCase() || '—'
}
