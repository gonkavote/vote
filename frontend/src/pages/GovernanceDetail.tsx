import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../lib/markdown'
import {
  api,
  Config,
  GovDeposit,
  GovMetadata,
  GovProposalDetail,
  GovVote,
} from '../lib/api'
import { useAppConfig, useTrackerLinks } from '../lib/useAppConfig'
import { CountdownBig } from '../components/Countdown'
import { StatusBadge } from '../components/governance/StatusBadge'
import { TallyBar } from '../components/governance/TallyBar'
import { GovVoteCard } from '../components/governance/GovVoteCard'
import { Comments } from '../components/Comments'
import {
  TranslatedText,
  TranslationToggle,
  type TranslationMode,
} from '../components/TranslatedText'
import { compactBig, formatDateTime, formatRelative } from '../lib/format'
import { humanMsgLabel } from '../lib/msgTypes'
import { linkify } from '../lib/linkify'

type Tab = 'discussion' | 'details' | 'votes' | 'deposits' | 'json'

export function GovernanceDetailPage() {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const { id } = useParams<{ id: string }>()
  const pid = parseInt(id || '0', 10)
  const [tab, setTab] = useState<Tab>('discussion')
  const [mode, setMode] = useState<TranslationMode>('translated')

  const { data: p, isLoading, error } = useQuery({
    queryKey: ['gov', 'proposal', pid, lng],
    queryFn: () => api.get<GovProposalDetail>(`/governance/proposals/${pid}`),
    enabled: pid > 0,
    refetchInterval: 60_000,
  })
  const { data: config } = useAppConfig()

  if (isLoading) return <p className="text-text-2 max-w-[1400px] mx-auto px-5 py-12">{t('tender.loading')}</p>
  if (error || !p) {
    return (
      <div className="max-w-[1400px] mx-auto px-5 py-12">
        <p className="text-rose-400">{t('governance.notFound')}</p>
        <Link to="/governance" className="btn-ghost mt-4 inline-flex">{t('governance.back')}</Link>
      </div>
    )
  }

  return (
    <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12">
      <div className="mb-8">
        <Link to="/governance" className="text-text-2 text-sm hover:text-accent">
          {t('governance.back')}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-8 items-start">
        <div className="space-y-6 min-w-0">
          <header>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <StatusBadge status={p.status} />
              {p.expedited && (
                <span className="pill bg-pink-500/15 text-pink-400 text-[10px]">
                  {t('governance.expedited')}
                </span>
              )}
              {p.msg_types.map((m) => (
                <span key={m}
                      className="pill bg-white/5 text-text-2 text-[10px]"
                      title={m}>
                  {humanMsgLabel(m, t)}
                </span>
              ))}
              <span className="text-xs text-text-2">#{p.proposal_id}</span>
              <span className="text-xs text-text-2">· {formatRelative(p.submit_time)}</span>
              <TranslationToggle
                isTranslated={p.is_translated}
                status={p.translation_status}
                mode={mode}
                onChange={setMode}
                sourceLang={p.source_lang}
              />
            </div>
            <TranslatedText
              as="h1"
              className="text-2xl md:text-3xl font-extrabold leading-tight tracking-tight break-words"
              translated={p.title}
              original={p.original_title}
              isTranslated={p.is_translated}
              status={p.translation_status}
              mode={mode}
            />
            {p.summary && (
              <TranslatedText
                as="p"
                className="mt-3 text-text-2 text-base leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                translated={p.summary}
                original={p.original_summary}
                isTranslated={p.is_translated}
                status={p.translation_status}
                mode={mode}
                render={(text) => linkify(text)}
              />
            )}
            {p.failed_reason && (
              <div className="mt-3 card border-rose-500/30 bg-rose-500/5">
                <div className="text-xs uppercase tracking-wider text-rose-400 mb-1">
                  {t('governance.detail.failedReason')}
                </div>
                <TranslatedText
                  as="p"
                  className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  translated={p.failed_reason}
                  original={p.original_failed_reason}
                  isTranslated={p.is_translated}
                  status={p.translation_status}
                  mode={mode}
                  render={(text) => linkify(text)}
                />
              </div>
            )}
          </header>

          <div className="flex gap-1 border-b border-border overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {(['discussion', 'details', 'votes', 'deposits', 'json'] as Tab[]).map((tk) => (
              <button
                key={tk}
                type="button"
                onClick={() => setTab(tk)}
                className={tabCls(tab === tk)}
              >
                {t(`governance.tabs.${tk}`)}
              </button>
            ))}
          </div>

          {tab === 'discussion' && (
            <Comments
              ownerId={`gov:${pid}`}
              apiBase={`/governance/proposals/${pid}`}
            />
          )}
          {tab === 'details' && <DetailsTab p={p} />}
          {tab === 'votes' && <VotesTab pid={pid} />}
          {tab === 'deposits' && <DepositsTab pid={pid} />}
          {tab === 'json' && (
            <pre className="card text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(rawProposal(p), null, 2)}
            </pre>
          )}
        </div>

        <aside className="hidden lg:block">
          <Sidebar p={p} config={config} />
        </aside>
      </div>

      <div className="lg:hidden mt-8">
        <Sidebar p={p} config={config} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Sidebar({ p, config }: { p: GovProposalDetail; config: Config | undefined }) {
  const { t } = useTranslation()
  const trackerLinks = useTrackerLinks(config)
  // Pull governance params for the quorum threshold; cached for an hour.
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

  const totalVoted = bi(p.yes_count) + bi(p.no_count) + bi(p.abstain_count) + bi(p.veto_count)
  const bonded = bi(p.total_bonded_at_end)
  // Number division (rounded by toFixed) — BigInt division truncates and
  // would render 33.4456% as 33.44% instead of tracker's 33.45%.
  const turnoutPct = bonded > 0n ? Number(totalVoted) / Number(bonded) * 100 : null
  const quorumPct = quorum != null ? quorum * 100 : null
  const turnoutPassed = turnoutPct != null && quorumPct != null ? turnoutPct >= quorumPct : null

  return (
    <div className="space-y-4">
      {p.voting_end_time && (
        <div className="card">
          <CountdownBig
            closesAt={p.voting_end_time}
            status={p.status === 'voting' ? 'open' : 'closed'}
          />
          <div className="text-text-2 text-[11px] uppercase tracking-wider mt-3">
            {t('governance.detail.votingPeriod')}
          </div>
          <div className="text-text-2 text-xs mt-0.5">
            {p.voting_start_time
              ? `${formatDateTime(p.voting_start_time)} → ${formatDateTime(p.voting_end_time)}`
              : formatDateTime(p.voting_end_time)}
          </div>
        </div>
      )}

      <div className="card text-sm space-y-3">
        <Stat label={t('governance.detail.epoch')} value={p.epoch_at_submit?.toString() ?? '—'} />
        <Stat
          label={t('governance.detail.proposer')}
          value={trackerLinks.enabled
            ? <a href={trackerLinks.address(p.proposer)}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-accent hover:underline break-all">{p.proposer}</a>
            : <span className="font-mono break-all">{p.proposer}</span>}
        />
      </div>

      <div className="card text-sm grid grid-cols-2 gap-3">
        <Stat
          label={t('governance.detail.turnoutQuorum')}
          value={
            <span>
              {turnoutPct != null ? (
                <span className={turnoutPassed === false ? 'text-rose-400' : 'text-emerald-400'}>
                  {turnoutPct.toFixed(2)}%
                </span>
              ) : '—'}
              <span className="text-text-2">
                {' '}/ {quorumPct != null ? `${quorumPct.toFixed(2)}%` : '—'}
              </span>
            </span>
          }
        />
        <Stat
          label={t('governance.detail.weight')}
          value={
            bonded > 0n
              ? `${shortNum(totalVoted.toString())} / ${shortNum(p.total_bonded_at_end)}`
              : shortNum(totalVoted.toString())
          }
        />
        <Stat
          label={t('governance.detail.voters')}
          value={
            p.total_voters_at_end > 0
              ? `${p.voted_count} / ${p.total_voters_at_end}`
              : `${p.voted_count}`
          }
        />
        <Stat
          label={t('governance.detail.totalDeposit')}
          value={`${shortNum(p.total_deposit_ngonka)} ngonka`}
        />
      </div>

      <div className="card">
        <div className="text-xs uppercase tracking-wider text-text-2 mb-3">
          {t('governance.detail.tally')}
        </div>
        <TallyBar
          yes={p.yes_count}
          no={p.no_count}
          veto={p.veto_count}
          abstain={p.abstain_count}
          variant="large"
        />
      </div>

      {p.status === 'voting' && (
        <GovVoteCard proposalId={p.proposal_id} config={config} />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-2 mb-0.5">{label}</div>
      <div className="text-sm break-words">{value}</div>
    </div>
  )
}

function bi(s: string | number | undefined): bigint {
  if (s === undefined || s === null || s === '') return 0n
  try {
    return BigInt(typeof s === 'number' ? Math.floor(s) : s)
  } catch {
    return 0n
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function DetailsTab({ p }: { p: GovProposalDetail }) {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const [mode, setMode] = useState<TranslationMode>('translated')
  const { data, isLoading } = useQuery({
    queryKey: ['gov', 'metadata', p.proposal_id, lng],
    queryFn: () => api.get<GovMetadata>(`/governance/proposals/${p.proposal_id}/metadata`),
  })
  return (
    <div className="space-y-4">
      {p.metadata_url && (
        <p className="text-text-2 text-xs">
          {t('governance.detail.metadataLink')}{' '}
          <a href={p.metadata_url} target="_blank" rel="noopener noreferrer"
             className="text-accent hover:underline break-all">{p.metadata_url}</a>
        </p>
      )}
      {isLoading && <p className="text-text-2 text-sm">{t('tender.loading')}</p>}
      {data && data.markdown && (
        <>
          <div className="flex items-center gap-2">
            <TranslationToggle
              isTranslated={data.is_translated}
              status={data.translation_status}
              mode={mode}
              onChange={setMode}
              sourceLang={p.source_lang}
            />
          </div>
          <TranslatedText
            as="article"
            className="card prose prose-invert prose-sm max-w-none prose-a:text-accent prose-headings:text-text [overflow-wrap:anywhere] prose-pre:[overflow-wrap:normal] prose-pre:overflow-x-auto"
            translated={data.markdown}
            original={data.original_markdown}
            isTranslated={data.is_translated}
            status={data.translation_status}
            mode={mode}
            render={(text) => <Markdown>{text}</Markdown>}
          />
        </>
      )}
      {!isLoading && (!data || !data.markdown) && (
        <p className="text-text-2 text-sm">{t('governance.detail.noMetadata')}</p>
      )}
    </div>
  )
}

type VotesSortKey = 'voter' | 'option' | 'power' | 'voted'
type Order = 'asc' | 'desc'

// Default direction per column. Numeric/date columns default to descending
// (newest / largest first); textual columns default to ascending (alphabetic).
const VOTES_DEFAULT_ORDER: Record<VotesSortKey, Order> = {
  voter: 'asc',
  option: 'asc',
  power: 'desc',
  voted: 'desc',
}

// VOTE_OPTION_* enum → stable rank for the 'Vote' column sort.
const OPTION_RANK: Record<string, number> = {
  VOTE_OPTION_YES: 1,
  VOTE_OPTION_NO: 2,
  VOTE_OPTION_NO_WITH_VETO: 3,
  VOTE_OPTION_ABSTAIN: 4,
}

function VotesTab({ pid }: { pid: number }) {
  const { t } = useTranslation()
  const { data: cfg } = useAppConfig()
  const trackerLinks = useTrackerLinks(cfg)
  const [sortKey, setSortKey] = useState<VotesSortKey>('power')
  const [order, setOrder] = useState<Order>('desc')
  const { data: votes, isLoading } = useQuery({
    queryKey: ['gov', 'votes', pid],
    queryFn: () => api.get<GovVote[]>(`/governance/proposals/${pid}/votes?page_size=500`),
  })

  const click = (k: VotesSortKey) => {
    if (k === sortKey) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(k)
      setOrder(VOTES_DEFAULT_ORDER[k])
    }
  }

  const sorted = useMemo(() => {
    if (!votes) return []
    const arr = [...votes]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'voter':
          cmp = a.voter.localeCompare(b.voter)
          break
        case 'option':
          cmp = (OPTION_RANK[a.option] ?? 99) - (OPTION_RANK[b.option] ?? 99)
          break
        case 'power': {
          const av = bi(a.voting_power)
          const bv = bi(b.voting_power)
          cmp = av < bv ? -1 : av > bv ? 1 : 0
          break
        }
        case 'voted':
          cmp = (a.voted_height ?? 0) - (b.voted_height ?? 0)
          break
      }
      return order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [votes, sortKey, order])

  if (isLoading) return <p className="text-text-2 text-sm">{t('tender.loading')}</p>
  if (!votes || votes.length === 0) {
    return <p className="text-text-2 text-sm">{t('governance.empty.noVotes')}</p>
  }
  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 border-b border-border text-[11px] uppercase tracking-wider text-text-2">
        <SortHeader className="flex-1 min-w-0" active={sortKey === 'voter'} order={order} onClick={() => click('voter')}>
          {t('governance.votesCols.voter')}
        </SortHeader>
        <SortHeader className="w-16 md:w-24 shrink-0" active={sortKey === 'option'} order={order} onClick={() => click('option')}>
          {t('governance.votesCols.option')}
        </SortHeader>
        <SortHeader className="w-16 md:w-28 shrink-0 justify-end" active={sortKey === 'power'} order={order} onClick={() => click('power')}>
          {t('governance.votesCols.power')}
        </SortHeader>
        <SortHeader className="hidden md:inline-flex w-28 shrink-0 justify-end" active={sortKey === 'voted'} order={order} onClick={() => click('voted')}>
          {t('governance.votesCols.voted')}
        </SortHeader>
        <span className="w-6 md:w-8 text-right shrink-0">{t('governance.votesCols.tx')}</span>
      </div>
      {sorted.map((v) => (
        <div key={`${v.voter}|${v.option}`} className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 border-b border-border last:border-b-0 text-sm hover:bg-white/5">
          {trackerLinks.enabled ? (
            <a href={trackerLinks.address(v.voter)}
               target="_blank" rel="noopener noreferrer"
               className="flex-1 min-w-0 font-mono text-accent hover:underline truncate">
              {v.voter}
            </a>
          ) : (
            <span className="flex-1 min-w-0 font-mono truncate">{v.voter}</span>
          )}
          <span className="w-16 md:w-24 shrink-0 text-xs">
            <OptionPill option={v.option} />
          </span>
          <span className="w-16 md:w-28 text-right shrink-0 tabular-nums text-text-2 text-xs">
            {shortNum(v.voting_power)}
          </span>
          <span className="hidden md:inline w-28 text-right shrink-0 tabular-nums text-text-2 text-xs"
                title={v.voted_at ? formatDateTime(v.voted_at) : undefined}>
            {v.voted_at ? formatRelative(v.voted_at) : '—'}
          </span>
          <span className="w-6 md:w-8 text-right shrink-0">
            {v.tx_hash && trackerLinks.enabled && (
              <a href={trackerLinks.tx(v.tx_hash)}
                 target="_blank" rel="noopener noreferrer"
                 className="text-accent hover:text-accent-2 text-xs">↗</a>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

type DepositsSortKey = 'depositor' | 'amount' | 'deposited'

const DEPOSITS_DEFAULT_ORDER: Record<DepositsSortKey, Order> = {
  depositor: 'asc',
  amount: 'desc',
  deposited: 'desc',
}

function DepositsTab({ pid }: { pid: number }) {
  const { t } = useTranslation()
  const { data: cfg } = useAppConfig()
  const trackerLinks = useTrackerLinks(cfg)
  const [sortKey, setSortKey] = useState<DepositsSortKey>('amount')
  const [order, setOrder] = useState<Order>('desc')
  const { data, isLoading } = useQuery({
    queryKey: ['gov', 'deposits', pid],
    queryFn: () => api.get<GovDeposit[]>(`/governance/proposals/${pid}/deposits`),
  })

  const click = (k: DepositsSortKey) => {
    if (k === sortKey) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(k)
      setOrder(DEPOSITS_DEFAULT_ORDER[k])
    }
  }

  const sorted = useMemo(() => {
    if (!data) return []
    const arr = [...data]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'depositor':
          cmp = a.depositor.localeCompare(b.depositor)
          break
        case 'amount': {
          const av = bi(a.amount_ngonka)
          const bv = bi(b.amount_ngonka)
          cmp = av < bv ? -1 : av > bv ? 1 : 0
          break
        }
        case 'deposited': {
          const at = a.deposited_at ? Date.parse(a.deposited_at) : 0
          const bt = b.deposited_at ? Date.parse(b.deposited_at) : 0
          cmp = at - bt
          break
        }
      }
      return order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [data, sortKey, order])

  if (isLoading) return <p className="text-text-2 text-sm">{t('tender.loading')}</p>
  if (!data || data.length === 0) {
    return <p className="text-text-2 text-sm">{t('governance.empty.noDeposits')}</p>
  }
  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 border-b border-border text-[11px] uppercase tracking-wider text-text-2">
        <SortHeader className="flex-1 min-w-0" active={sortKey === 'depositor'} order={order} onClick={() => click('depositor')}>
          {t('governance.depositsCols.depositor')}
        </SortHeader>
        <SortHeader className="w-24 md:w-32 shrink-0 justify-end" active={sortKey === 'amount'} order={order} onClick={() => click('amount')}>
          {t('governance.depositsCols.amount')}
        </SortHeader>
        <SortHeader className="hidden md:inline-flex w-28 shrink-0 justify-end" active={sortKey === 'deposited'} order={order} onClick={() => click('deposited')}>
          {t('governance.depositsCols.deposited')}
        </SortHeader>
        <span className="w-6 md:w-8 text-right shrink-0">{t('governance.depositsCols.tx')}</span>
      </div>
      {sorted.map((d) => (
        <div key={`${d.depositor}-${d.deposited_at}`} className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 border-b border-border last:border-b-0 text-sm hover:bg-white/5">
          {trackerLinks.enabled ? (
            <a href={trackerLinks.address(d.depositor)}
               target="_blank" rel="noopener noreferrer"
               className="flex-1 min-w-0 font-mono text-accent hover:underline truncate">
              {d.depositor}
            </a>
          ) : (
            <span className="flex-1 min-w-0 font-mono truncate">{d.depositor}</span>
          )}
          <span className="w-24 md:w-32 text-right shrink-0 tabular-nums text-xs">
            {shortNum(d.amount_ngonka)} ngonka
          </span>
          <span className="hidden md:inline w-28 text-right shrink-0 tabular-nums text-text-2 text-xs"
                title={d.deposited_at ? formatDateTime(d.deposited_at) : undefined}>
            {d.deposited_at ? formatRelative(d.deposited_at) : '—'}
          </span>
          <span className="w-6 md:w-8 text-right shrink-0">
            {d.tx_hash && trackerLinks.enabled && (
              <a href={trackerLinks.tx(d.tx_hash)}
                 target="_blank" rel="noopener noreferrer"
                 className="text-accent hover:text-accent-2 text-xs">↗</a>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tabCls(active: boolean): string {
  const base =
    'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors shrink-0 whitespace-nowrap'
  return active
    ? `${base} border-accent text-accent`
    : `${base} border-transparent text-text-2 hover:text-text`
}

// Clickable column header that toggles sort. The arrow only renders when
// this column is the active one; clicking the active column flips order,
// clicking another column makes it active with its default order.
function SortHeader({
  active, order, onClick, className, children,
}: {
  active: boolean
  order: Order
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  const arrow = active ? (order === 'asc' ? '↑' : '↓') : ''
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 cursor-pointer hover:text-text transition-colors text-[11px] uppercase tracking-wider text-left ${
        active ? 'text-accent-2' : 'text-text-2'
      } ${className || ''}`}
    >
      <span className="truncate">{children}</span>
      {arrow && <span className="shrink-0">{arrow}</span>}
    </button>
  )
}

function OptionPill({ option }: { option: string }) {
  // VOTE_OPTION_YES → YES
  const short = option.replace(/^VOTE_OPTION_/, '').replace('NO_WITH_VETO', 'VETO')
  const cls =
    short === 'YES' ? 'bg-emerald-500/15 text-emerald-400'
    : short === 'NO' ? 'bg-rose-500/15 text-rose-400'
    : short === 'VETO' ? 'bg-pink-500/15 text-pink-400'
    : 'bg-amber-500/15 text-amber-400'
  return <span className={`pill text-[10px] ${cls}`}>{short}</span>
}

/** Strip translation overlay so the JSON tab shows the proposal as the chain
 * sees it: original title/summary/failed_reason, no is_translated/original_*
 * /translation_status noise. */
function rawProposal(p: GovProposalDetail): Record<string, unknown> {
  const {
    is_translated, original_title, original_summary, original_failed_reason,
    translation_status, source_lang, ...rest
  } = p
  void is_translated; void translation_status; void source_lang
  return {
    ...rest,
    title: original_title ?? p.title,
    summary: original_summary ?? p.summary,
    failed_reason: original_failed_reason ?? p.failed_reason,
  }
}

function shortNum(s: string | number): string {
  let n: bigint
  try { n = BigInt(typeof s === 'number' ? Math.floor(s) : s) } catch { return String(s) }
  return compactBig(n)
}
