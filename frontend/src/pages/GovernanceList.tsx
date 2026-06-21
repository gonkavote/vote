import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, GovProposalsPage, GovStatus } from '../lib/api'
import { StatusBadge } from '../components/governance/StatusBadge'
import { TallyBar } from '../components/governance/TallyBar'
import { TranslatedText } from '../components/TranslatedText'
import { compactBig, formatRelative } from '../lib/format'
import { humanMsgLabel } from '../lib/msgTypes'

// Reduced set: chain also exposes 'deposit' and 'failed', but they're rare
// and noisy on the index. Showing 4 tabs keeps the focus on what users
// actually want to find. 'All' is the default.
const STATUS_TABS: (GovStatus | 'all')[] = ['all', 'voting', 'passed', 'rejected']

const PAGE_SIZE = 20

export function GovernanceListPage() {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const [searchParams, setSearchParams] = useSearchParams()
  const status = (searchParams.get('status') as GovStatus | 'all' | null) || 'all'
  const search = searchParams.get('q') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)

  // Local input state, debounced into the URL.
  const [searchInput, setSearchInput] = useState(search)
  useEffect(() => setSearchInput(search), [search])
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput === search) return
      const next = new URLSearchParams(searchParams)
      if (searchInput.trim()) next.set('q', searchInput.trim())
      else next.delete('q')
      next.delete('page')
      setSearchParams(next, { replace: true })
    }, 300)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  const setStatus = (s: GovStatus | 'all') => {
    const next = new URLSearchParams(searchParams)
    next.set('status', s)
    next.delete('page')
    setSearchParams(next, { replace: true })
  }
  const setPage = (p: number) => {
    const next = new URLSearchParams(searchParams)
    if (p <= 1) next.delete('page')
    else next.set('page', String(p))
    setSearchParams(next, { replace: true })
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['gov', 'proposals', status, search, page, lng],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (status && status !== 'all') qs.set('status', status)
      if (search) qs.set('search', search)
      qs.set('page', String(page))
      qs.set('page_size', String(PAGE_SIZE))
      return api.get<GovProposalsPage>(`/governance/proposals?${qs.toString()}`)
    },
    refetchInterval: 60_000,
  })

  // Pull governance params once per hour to know the quorum threshold —
  // shown next to each proposal's tally so users see whether it has cleared.
  const { data: params } = useQuery({
    queryKey: ['gov', 'params'],
    queryFn: () => api.get<{ payload_json: string }>('/governance/params'),
    staleTime: 3600_000,
  })
  const quorum = useMemo<number | null>(() => {
    if (!params?.payload_json) return null
    try {
      const obj = JSON.parse(params.payload_json) as { quorum?: number }
      return typeof obj.quorum === 'number' ? obj.quorum : null
    } catch {
      return null
    }
  }, [params])

  const totalPages = useMemo(
    () => (data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1),
    [data],
  )

  return (
    <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12">
      <div className="mb-6">
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
          {t('governance.list.title')}
        </h1>
        <p className="text-text-2 mt-2 max-w-[640px]">
          {t('governance.list.subtitle')}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={tabCls(s === status)}
            >
              {t(`governance.status.${s}`, { defaultValue: s })}
            </button>
          ))}
        </div>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('governance.list.search')}
          className="sm:ml-auto bg-bg-2 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent/50 sm:w-64"
        />
      </div>

      {isLoading && (
        <p className="text-text-2 py-8">{t('tender.loading')}</p>
      )}
      {error && (
        <p className="text-rose-400 py-8">{(error as Error).message}</p>
      )}
      {data && data.proposals.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-text-2">{t('governance.empty.noProposals')}</p>
        </div>
      )}

      {data && data.proposals.length > 0 && (
        <div className="card p-0 overflow-hidden">
          {/* header row */}
          <div className="hidden md:flex items-center gap-4 px-4 py-3 border-b border-border text-[11px] uppercase tracking-wider text-text-2">
            <span className="basis-0 grow-[3] min-w-0">{t('governance.cols.proposal')}</span>
            <span className="w-16 text-right tabular-nums shrink-0">{t('governance.cols.epoch')}</span>
            <span className="basis-0 grow-[2] min-w-[200px]">{t('governance.cols.tally')}</span>
            <span className="w-32 text-right shrink-0 pr-2">{t('governance.cols.voters')}</span>
          </div>
          {data.proposals.map((p) => (
            <Link
              key={p.proposal_id}
              to={`/governance/${p.proposal_id}`}
              className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 px-4 py-3 border-b border-border last:border-b-0 hover:bg-white/5 transition-colors"
            >
              <div className="md:basis-0 md:grow-[3] min-w-0">
                <div className="font-semibold break-words">
                  <span className="text-text-2 tabular-nums mr-2">
                    #{p.proposal_id}
                  </span>
                  <TranslatedText
                    as="span"
                    translated={p.title}
                    original={p.original_title}
                    isTranslated={p.is_translated}
                    status={p.translation_status}
                    mode="translated"
                  />
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <StatusBadge status={p.status} />
                  <span className="text-xs text-text-2">{formatRelative(p.submit_time)}</span>
                  {p.expedited && (
                    <span className="pill bg-pink-500/15 text-pink-400 text-[10px]">
                      {t('governance.expedited')}
                    </span>
                  )}
                </div>
                {p.msg_types.length > 0 && (
                  <div className="text-[11px] text-text-2 mt-1 break-words leading-relaxed">
                    {p.msg_types.map((m) => humanMsgLabel(m, t)).join(', ')}
                  </div>
                )}
              </div>
              <div className="w-16 text-right text-sm tabular-nums hidden md:block shrink-0">
                {p.epoch_at_submit ?? '—'}
              </div>
              <div className="w-full md:basis-0 md:grow-[2] md:min-w-[200px]">
                <TallyBar
                  yes={p.yes_count}
                  no={p.no_count}
                  veto={p.veto_count}
                  abstain={p.abstain_count}
                />
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] mt-1">
                  <span className="text-emerald-400">{shortNum(p.yes_count)} {t('governance.tally.yes')}</span>
                  <span className="text-rose-400">{shortNum(p.no_count)} {t('governance.tally.no')}</span>
                  {bi(p.veto_count) > 0n && (
                    <span className="text-pink-400">{shortNum(p.veto_count)} {t('governance.tally.veto')}</span>
                  )}
                  {bi(p.abstain_count) > 0n && (
                    <span className="text-amber-400">{shortNum(p.abstain_count)} {t('governance.tally.abstain')}</span>
                  )}
                </div>
                {(() => {
                  // Turnout / quorum line. Only render once both numbers are
                  // known (some closed proposals don't carry total_bonded).
                  const bonded = bi(p.total_bonded_at_end)
                  const total = bi(p.yes_count) + bi(p.no_count)
                              + bi(p.abstain_count) + bi(p.veto_count)
                  if (bonded === 0n || quorum == null) return null
                  // Use Number division (rounded by toFixed) instead of
                  // BigInt-truncation — otherwise 33.4456% renders as 33.44%
                  // when tracker shows 33.45%.
                  const turnoutPct = Number(total) / Number(bonded) * 100
                  const quorumPct = quorum * 100
                  const passed = turnoutPct >= quorumPct
                  return (
                    <div className="text-[10px] text-text-2 mt-1 tabular-nums">
                      <span className="uppercase tracking-wider mr-1">
                        {t('governance.cols.turnout')}:
                      </span>
                      <span className={passed ? 'text-emerald-400' : 'text-rose-400'}>
                        {turnoutPct.toFixed(2)}%
                      </span>
                      <span className="text-text-2"> / {quorumPct.toFixed(2)}%</span>
                    </div>
                  )
                })()}
              </div>
              <div className="w-full md:w-32 md:text-right md:shrink-0 md:pr-2 text-xs text-text-2 tabular-nums">
                {p.total_voters_at_end > 0
                  ? `${p.voted_count} / ${p.total_voters_at_end}`
                  : `${p.voted_count}`}
              </div>
            </Link>
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button
            type="button"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
            className="btn-ghost disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← {t('governance.pagination.prev')}
          </button>
          <span className="text-text-2">
            {t('governance.pagination.page', { page, total: totalPages })}
          </span>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
            className="btn-ghost disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('governance.pagination.next')} →
          </button>
        </div>
      )}
    </div>
  )
}

function tabCls(active: boolean): string {
  const base = 'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors'
  return active
    ? `${base} bg-accent/15 text-accent-2`
    : `${base} text-text-2 hover:text-text hover:bg-white/5`
}

function bi(s: string): bigint {
  try { return BigInt(s) } catch { return 0n }
}

function shortNum(s: string): string {
  return compactBig(bi(s))
}

