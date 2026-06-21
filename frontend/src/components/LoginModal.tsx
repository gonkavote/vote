// Two-option sign-in modal: Google (redirect to /api/auth/login) and
// Telegram (programmatic via window.Telegram.Login.auth).
//
// Instead of letting the official widget render its own square button,
// we load the widget script once and trigger Telegram.Login.auth({...},
// callback) ourselves from a custom pill-shaped button that matches
// the Google one. The script accepts the same params and pops up the
// Telegram approval flow exactly the same way.

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { api, Config } from '../lib/api'

interface Props {
  redirect: string
  onClose: () => void
}

interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  photo_url?: string
  auth_date: number
  hash: string
}

declare global {
  interface Window {
    Telegram?: {
      Login: {
        auth: (
          opts: { bot_id: string; request_access?: 'write' | string; lang?: string },
          callback: (data: TelegramUser | false) => void,
        ) => void
      }
    }
  }
}

const TG_WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js?22'

let scriptPromise: Promise<void> | null = null

/** Load telegram-widget.js exactly once across the whole app. */
function loadTelegramScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.Telegram?.Login) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      `script[src^="${TG_WIDGET_SRC.split('?')[0]}"]`,
    ) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('telegram script failed to load')))
      // Already loaded?
      if (window.Telegram?.Login) resolve()
      return
    }
    const s = document.createElement('script')
    s.src = TG_WIDGET_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('telegram script failed to load'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

export function LoginModal({ redirect, onClose }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<Config>('/config'),
    staleTime: Infinity,
  })

  const [tgError, setTgError] = useState<string | null>(null)
  const [tgPending, setTgPending] = useState(false)
  const [tgReady, setTgReady] = useState(false)
  const cancelledRef = useRef(false)

  const googleHref = `/api/auth/login?redirect=${encodeURIComponent(redirect)}`

  // Pre-load the Telegram script as soon as the modal opens so the
  // 'Continue with Telegram' button is responsive on first click.
  useEffect(() => {
    cancelledRef.current = false
    if (!config?.telegram_bot_id) return
    loadTelegramScript()
      .then(() => {
        if (!cancelledRef.current) setTgReady(true)
      })
      .catch(() => {
        if (!cancelledRef.current) setTgError(t('auth.modal.tgScriptError'))
      })
    return () => {
      cancelledRef.current = true
    }
  }, [config?.telegram_bot_id])

  const onTelegramClick = () => {
    setTgError(null)
    if (!window.Telegram?.Login || !config?.telegram_bot_id) {
      setTgError(t('auth.modal.tgNotReady'))
      return
    }
    setTgPending(true)
    window.Telegram.Login.auth(
      { bot_id: String(config.telegram_bot_id), request_access: 'write' },
      async (data) => {
        if (!data) {
          setTgPending(false)
          setTgError(t('auth.modal.tgCancelled'))
          return
        }
        try {
          await api.post('/auth/telegram', data)
          await qc.invalidateQueries({ queryKey: ['me'] })
          onClose()
        } catch (e) {
          const detail =
            (e as { body?: { detail?: string }; message?: string })?.body?.detail ||
            (e as Error)?.message ||
            t('auth.modal.tgFailed')
          setTgError(detail)
        } finally {
          setTgPending(false)
        }
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-2xl w-full max-w-sm p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label={t('auth.close')}
          className="absolute top-3 right-3 text-text-2 hover:text-text text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5"
        >
          ×
        </button>

        <h2 className="text-lg font-semibold mb-1">{t('auth.modal.title')}</h2>
        <p className="text-text-2 text-sm mb-5">
          {t('auth.modal.subtitle')}
        </p>

        {config?.telegram_bot_id && (
          <>
            <button
              type="button"
              onClick={onTelegramClick}
              disabled={!tgReady || tgPending}
              className="btn-primary w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <TelegramIcon />
              <span>{tgPending ? t('auth.modal.signingIn') : t('auth.modal.telegram')}</span>
            </button>

            {tgError && (
              <p className="text-rose-400 text-xs text-center mt-3 break-words">
                {tgError}
              </p>
            )}

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-text-2 text-xs uppercase tracking-wider">{t('auth.modal.or')}</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          </>
        )}

        <a href={googleHref} className="btn-primary w-full justify-center">
          <GoogleIcon />
          <span>{t('auth.modal.google')}</span>
        </a>

        <p className="text-text-2 text-[11px] text-center mt-5 leading-relaxed">
          <Trans
            i18nKey="auth.modal.terms"
            components={{
              terms: <a href="/terms" className="text-accent hover:underline" />,
              privacy: <a href="/privacy" className="text-accent hover:underline" />,
            }}
          />
        </p>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path fill="#fff" d="M21.6 12.227c0-.709-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.996 3.018v2.51h3.232c1.891-1.742 2.982-4.305 2.982-7.35z" />
      <path fill="#fff" d="M12 22c2.7 0 4.964-.895 6.618-2.422l-3.232-2.51c-.895.6-2.04.955-3.386.955-2.605 0-4.81-1.76-5.596-4.123H3.064v2.59A9.996 9.996 0 0 0 12 22z" opacity=".85" />
      <path fill="#fff" d="M6.404 13.9A6.01 6.01 0 0 1 6.09 12c0-.66.114-1.3.314-1.9V7.51H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.49l3.34-2.59z" opacity=".7" />
      <path fill="#fff" d="M12 5.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C16.96 2.99 14.7 2 12 2A9.996 9.996 0 0 0 3.064 7.51l3.34 2.59C7.19 7.737 9.395 5.977 12 5.977z" opacity=".55" />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
    </svg>
  )
}
