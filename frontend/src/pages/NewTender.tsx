import { FormEvent, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, TenderSummary } from '../lib/api'
import { Markdown } from '../lib/markdown'
import { useMe } from '../hooks/useMe'
import { useLogin } from '../lib/loginContext'
import { formatDateTime } from '../lib/format'

const MIN_DAYS = 7
const PRESETS: { key: '1w' | '2w' | '1m' | '3m'; days: number }[] = [
  { key: '1w', days: 7 },
  { key: '2w', days: 14 },
  { key: '1m', days: 30 },
  { key: '3m', days: 90 },
]

/** ISO YYYY-MM-DDTHH:mm in *local* time (what <input type="datetime-local"> wants). */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function presetValue(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return toLocalInputValue(d)
}

export function NewTenderPage() {
  const { t } = useTranslation()
  const { data: me, isLoading } = useMe()
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [closesAt, setClosesAt] = useState<string>(() => presetValue(7))

  const minLocal = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + MIN_DAYS)
    return toLocalInputValue(d)
  }, [])

  const closesAtMs = closesAt ? new Date(closesAt).getTime() : NaN
  const minMs = new Date(minLocal).getTime()
  const deadlineValid = !Number.isNaN(closesAtMs) && closesAtMs >= minMs - 60_000

  const create = useMutation({
    mutationFn: () =>
      api.post<TenderSummary>('/tenders', {
        title: title.trim(),
        summary: summary.trim(),
        description: description.trim(),
        // datetime-local has no timezone; treat as local and convert to UTC ISO.
        closes_at: new Date(closesAt).toISOString(),
      }),
    onSuccess: (t) => nav(`/tenders/${t.id}`),
  })

  const titleLen = title.trim().length
  const summaryLen = summary.trim().length
  const titleValid = titleLen >= 3 && titleLen <= 80
  const summaryValid = summaryLen >= 10 && summaryLen <= 200

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (
      !titleValid ||
      !summaryValid ||
      description.trim().length === 0 ||
      !deadlineValid
    ) return
    create.mutate()
  }

  if (isLoading) return null
  if (!me) {
    return <NotSignedIn />
  }

  const formIncomplete =
    !titleValid ||
    !summaryValid ||
    description.trim().length === 0 ||
    !deadlineValid

  return (
    <div className="max-w-[760px] mx-auto px-5 md:px-12 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight mb-1">{t('newTender.title')}</h1>
      <p className="text-text-2 text-sm mb-8">
        {t('newTender.intro')}
      </p>

      <form onSubmit={submit} className="space-y-6">
        <label className="block">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">{t('newTender.titleField')}</span>
            <span className={`text-xs ${titleLen > 80 ? 'text-rose-400' : 'text-text-2'}`}>
              {titleLen} / 80
            </span>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            required
            className="w-full bg-bg-2 border border-border rounded-lg p-3 text-base focus:outline-none focus:border-accent/50"
            placeholder={t('newTender.titlePlaceholder')}
          />
        </label>

        <label className="block">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">{t('newTender.summary')}</span>
            <span className={`text-xs ${
              summaryLen > 200 || (summaryLen > 0 && summaryLen < 10) ? 'text-rose-400' : 'text-text-2'
            }`}>
              {summaryLen} / 200
            </span>
          </div>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={200}
            rows={3}
            required
            className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm focus:outline-none focus:border-accent/50"
            placeholder={t('newTender.summaryPlaceholder')}
          />
          <p className="text-text-2 text-xs mt-1">
            {t('newTender.summaryHint')}
          </p>
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">{t('newTender.description')}</span>
            <div className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={() => setTab('edit')}
                className={`px-2 py-1 rounded ${tab === 'edit' ? 'bg-white/10' : 'text-text-2'}`}
              >
                {t('newTender.edit')}
              </button>
              <button
                type="button"
                onClick={() => setTab('preview')}
                className={`px-2 py-1 rounded ${tab === 'preview' ? 'bg-white/10' : 'text-text-2'}`}
              >
                {t('newTender.preview')}
              </button>
            </div>
          </div>
          {tab === 'edit' ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={14}
              required
              className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm font-mono focus:outline-none focus:border-accent/50"
              placeholder={t('newTender.descriptionPlaceholder')}
            />
          ) : (
            <div className="card prose prose-invert prose-sm max-w-none min-h-[300px]">
              {description ? (
                <Markdown>{description}</Markdown>
              ) : (
                <p className="text-text-2">{t('newTender.previewEmpty')}</p>
              )}
            </div>
          )}
        </div>

        <div>
          <span className="text-sm font-semibold mb-2 block">
            {t('newTender.deadline')} <span className="text-text-2 font-normal">{t('newTender.deadlineHint', { days: MIN_DAYS })}</span>
          </span>
          <div className="flex flex-wrap gap-2 mb-3">
            {PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setClosesAt(presetValue(p.days))}
                className="btn-ghost text-xs"
              >
                {t(`newTender.preset.${p.key}`)}
              </button>
            ))}
          </div>
          <input
            type="datetime-local"
            value={closesAt}
            min={minLocal}
            onChange={(e) => setClosesAt(e.target.value)}
            required
            className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm font-mono focus:outline-none focus:border-accent/50"
          />
          {!deadlineValid && closesAt && (
            <p className="text-rose-400 text-xs mt-1">
              {t('newTender.deadlineMinError', { days: MIN_DAYS })}
            </p>
          )}
          {deadlineValid && closesAt && (
            <p className="text-text-2 text-xs mt-1">
              {t('newTender.deadlinePreview', { when: formatDateTime(new Date(closesAt).toISOString()) })}
            </p>
          )}
        </div>

        {create.error && (
          <p className="text-rose-400 text-sm">{(create.error as Error).message}</p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={create.isPending || formIncomplete}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {create.isPending ? t('newTender.publishing') : t('newTender.publish')}
          </button>
          <button type="button" onClick={() => nav(-1)} className="btn-ghost">
            {t('newTender.back')}
          </button>
        </div>
      </form>
    </div>
  )
}

function NotSignedIn() {
  const { t } = useTranslation()
  const { openLogin } = useLogin()
  return (
    <div className="max-w-[680px] mx-auto px-5 py-16 text-center">
      <h1 className="text-2xl font-bold mb-4">{t('newTender.signInTitle')}</h1>
      <button
        type="button"
        onClick={() => openLogin('/tenders/new')}
        className="btn-primary"
      >
        {t('auth.signIn')}
      </button>
    </div>
  )
}
