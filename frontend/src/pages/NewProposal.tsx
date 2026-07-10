import { FormEvent, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, ProposalSummary } from '../lib/api'
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

export function NewProposalPage() {
  const { t } = useTranslation()
  const { data: me, isLoading } = useMe()
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [closesAt, setClosesAt] = useState<string>(() => presetValue(7))
  const [requestedUsdt, setRequestedUsdt] = useState<string>('')
  const [requestedGnk, setRequestedGnk] = useState<string>('')

  const minLocal = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + MIN_DAYS)
    return toLocalInputValue(d)
  }, [])

  const closesAtMs = closesAt ? new Date(closesAt).getTime() : NaN
  const minMs = new Date(minLocal).getTime()
  const deadlineValid = !Number.isNaN(closesAtMs) && closesAtMs >= minMs - 60_000

  const usdtNum = parseInt(requestedUsdt || '0', 10)
  const gnkNum = parseInt(requestedGnk || '0', 10)
  const usdtValid = !Number.isNaN(usdtNum) && usdtNum >= 0 && usdtNum <= 1_000_000_000_000
  const gnkValid = !Number.isNaN(gnkNum) && gnkNum >= 0 && gnkNum <= 1_000_000_000_000
  const amountValid = usdtValid && gnkValid && (usdtNum > 0 || gnkNum > 0)

  const create = useMutation({
    mutationFn: () =>
      api.post<ProposalSummary>('/proposal', {
        title: title.trim(),
        summary: summary.trim(),
        description: description.trim(),
        closes_at: new Date(closesAt).toISOString(),
        requested_amount_usdt: usdtNum,
        requested_amount_gnk: gnkNum,
      }),
    onSuccess: (t) => nav(`/proposal/${t.id}`),
  })

  const titleLen = title.trim().length
  const summaryLen = summary.trim().length
  const descLen = description.trim().length
  const titleValid = titleLen >= 3 && titleLen <= 80
  const summaryValid = summaryLen >= 10 && summaryLen <= 200
  const descValid = descLen >= 1 && descLen <= 20_000

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!titleValid || !summaryValid || !descValid || !deadlineValid || !amountValid) return
    create.mutate()
  }

  if (isLoading) return null
  if (!me) {
    return <NotSignedIn />
  }

  const formIncomplete = !titleValid || !summaryValid || !descValid || !deadlineValid || !amountValid

  return (
    <div className="max-w-[760px] mx-auto px-5 md:px-12 py-12">
      <h1 className="text-3xl font-extrabold tracking-tight mb-1">{t('newProposal.title')}</h1>
      <p className="text-text-2 text-sm mb-8">
        {t('newProposal.intro')}
      </p>

      <form onSubmit={submit} className="space-y-6">
        <label className="block">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">{t('newProposal.titleField')}</span>
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
            placeholder={t('newProposal.titlePlaceholder')}
          />
        </label>

        <label className="block">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">{t('newProposal.summary')}</span>
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
            placeholder={t('newProposal.summaryPlaceholder')}
          />
          <p className="text-text-2 text-xs mt-1">
            {t('newProposal.summaryHint')}
          </p>
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">{t('newProposal.description')}</span>
            <div className="flex items-center gap-3">
              <span className={`text-xs ${descLen > 20_000 ? 'text-rose-400' : 'text-text-2'}`}>
                {descLen} / 20000
              </span>
              <div className="flex gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setTab('edit')}
                  className={`px-2 py-1 rounded ${tab === 'edit' ? 'bg-white/10' : 'text-text-2'}`}
                >
                  {t('newProposal.edit')}
                </button>
                <button
                  type="button"
                  onClick={() => setTab('preview')}
                  className={`px-2 py-1 rounded ${tab === 'preview' ? 'bg-white/10' : 'text-text-2'}`}
                >
                  {t('newProposal.preview')}
                </button>
              </div>
            </div>
          </div>
          {tab === 'edit' ? (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={14}
              required
              maxLength={20_000}
              className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm font-mono focus:outline-none focus:border-accent/50"
              placeholder={t('newProposal.descriptionPlaceholder')}
            />
          ) : (
            <div className="card prose prose-invert prose-sm max-w-none min-h-[300px]">
              {description ? (
                <Markdown>{description}</Markdown>
              ) : (
                <p className="text-text-2">{t('newProposal.previewEmpty')}</p>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-semibold">{t('newProposal.requestedAmount')}</span>
            <span className="text-xs text-text-2">{t('newProposal.requestedHint')}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-text-2 mb-1 block">USDT</span>
              <input
                type="number"
                min="0"
                step="1"
                value={requestedUsdt}
                onChange={(e) => setRequestedUsdt(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="0"
                className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm focus:outline-none focus:border-accent/50"
              />
            </label>
            <label className="block">
              <span className="text-xs text-text-2 mb-1 block">GNK</span>
              <input
                type="number"
                min="0"
                step="1"
                value={requestedGnk}
                onChange={(e) => setRequestedGnk(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="0"
                className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm focus:outline-none focus:border-accent/50"
              />
            </label>
          </div>
          {!amountValid && (requestedUsdt !== '' || requestedGnk !== '') && (
            <p className="text-rose-400 text-xs mt-1">{t('newProposal.requestedError')}</p>
          )}
        </div>

        <div>
          <span className="text-sm font-semibold mb-2 block">
            {t('newProposal.deadline')} <span className="text-text-2 font-normal">{t('newProposal.deadlineHint', { days: MIN_DAYS })}</span>
          </span>
          <div className="flex flex-wrap gap-2 mb-3">
            {PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setClosesAt(presetValue(p.days))}
                className="btn-ghost text-xs"
              >
                {t(`newProposal.preset.${p.key}`)}
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
              {t('newProposal.deadlineMinError', { days: MIN_DAYS })}
            </p>
          )}
          {deadlineValid && closesAt && (
            <p className="text-text-2 text-xs mt-1">
              {t('newProposal.deadlinePreview', { when: formatDateTime(new Date(closesAt).toISOString()) })}
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
            {create.isPending ? t('newProposal.publishing') : t('newProposal.publish')}
          </button>
          <button type="button" onClick={() => nav(-1)} className="btn-ghost">
            {t('newProposal.back')}
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
      <h1 className="text-2xl font-bold mb-4">{t('newProposal.signInTitle')}</h1>
      <button
        type="button"
        onClick={() => openLogin('/proposal/new')}
        className="btn-primary"
      >
        {t('auth.signIn')}
      </button>
    </div>
  )
}
