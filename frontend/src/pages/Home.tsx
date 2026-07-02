import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { api, Tally, ProposalSummary } from '../lib/api'
import { TallyStats } from '../components/TallyStats'
import { CountdownPill } from '../components/Countdown'
import { formatRelative } from '../lib/format'
import { useMe } from '../hooks/useMe'

type SortKey =
  | 'newest'
  | 'voters_desc'    | 'voters_asc'
  | 'community_desc' | 'community_asc'
  | 'hosts_desc'     | 'hosts_asc'
  | 'bid_desc'       | 'bid_asc'

const SORT_KEYS: SortKey[] = [
  'newest',
  'voters_desc', 'voters_asc',
  'community_desc', 'community_asc',
  'hosts_desc', 'hosts_asc',
  'bid_desc', 'bid_asc',
]

/** Numeric value picker so we can sort by any tally column without dupes. */
function tallyValue(t: Tally, key: SortKey): bigint {
  switch (key) {
    case 'voters_desc':
    case 'voters_asc':
      return BigInt(t.voter_count || 0)
    case 'community_desc':
    case 'community_asc':
      return BigInt(t.community_weight_ngonka || '0')
    case 'hosts_desc':
    case 'hosts_asc':
      return BigInt(t.hosts_weight_ngonka || '0')
    case 'bid_desc':
    case 'bid_asc':
      return BigInt(t.weighted_avg_bid_ngonka || '0')
    default:
      return 0n
  }
}

type Bucket = 'all' | 'active' | 'expired'

/** A proposal is "expired" when the chain marks it closed OR its deadline
 *  has already passed (the indexer flips the status with a small lag). */
function isExpired(t: ProposalSummary): boolean {
  if (t.status === 'closed') return true
  if (!t.closes_at) return false
  return new Date(t.closes_at).getTime() <= Date.now()
}

export function HomePage() {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const { data: proposals, isLoading } = useQuery({
    queryKey: ['proposals', lng],
    queryFn: () => api.get<ProposalSummary[]>('/proposals'),
    refetchInterval: 30_000,
  })
  const { data: me } = useMe()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')
  const [bucket, setBucket] = useState<Bucket>('all')

  const sortFn = useMemo(() => {
    if (sort === 'newest') {
      return (a: ProposalSummary, b: ProposalSummary) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }
    const asc = sort.endsWith('_asc')
    return (a: ProposalSummary, b: ProposalSummary) => {
      const va = tallyValue(a.tally, sort)
      const vb = tallyValue(b.tally, sort)
      if (va === vb) return 0
      return asc ? (va < vb ? -1 : 1) : (vb < va ? -1 : 1)
    }
  }, [sort])

  const { activeList, expiredList, totalMatching } = useMemo(() => {
    if (!proposals) return { activeList: [], expiredList: [], totalMatching: 0 }
    const q = query.trim().toLowerCase()
    const matchesQuery = (t: ProposalSummary) =>
      !q || (t.title + ' ' + (t.summary || '')).toLowerCase().includes(q)
    const active: ProposalSummary[] = []
    const expired: ProposalSummary[] = []
    for (const t of proposals) {
      if (!matchesQuery(t)) continue
      ;(isExpired(t) ? expired : active).push(t)
    }
    active.sort(sortFn)
    // Closed: most recently created first by default; user's sort still
    // applies when something other than 'newest' is selected.
    expired.sort(sort === 'newest' ? sortFn : sortFn)
    return {
      activeList: active,
      expiredList: expired,
      totalMatching: active.length + expired.length,
    }
  }, [proposals, query, sortFn, sort])

  const showActive = bucket !== 'expired'
  const showExpired = bucket !== 'active'

  return (
    <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12 relative">
      {/* Hero */}
      <div className="relative text-center pb-16">
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] max-w-full h-[500px] pointer-events-none"
          style={{ background: 'radial-gradient(ellipse, rgba(59,130,246,0.15) 0%, transparent 70%)' }}
        />
        <span className="pill bg-accent/10 border border-accent/20 text-accent-2 mb-6 relative">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          {t('home.hero.badge')}
        </span>
        <h1 className="text-4xl md:text-6xl font-extrabold leading-tight tracking-tight mb-5 relative">
          {t('home.hero.titleLine1')} <br />
          <span className="grad-text">{t('home.hero.titleLine2')}</span>
        </h1>
        <p className="text-text-2 text-base md:text-lg max-w-[560px] mx-auto leading-relaxed relative">
          <Trans i18nKey="home.hero.subtitle" components={{ strong: <strong className="text-text" /> }} />
        </p>
        {me && (
          <div className="mt-8 relative">
            <Link to="/proposal/new" className="btn-primary">{t('home.hero.propose')}</Link>
          </div>
        )}
      </div>

      {/* Toolbar: title + bucket tabs + search + sort */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <h2 className="text-xl font-bold flex-shrink-0">
          {t('home.list.title')}{' '}
          {proposals && (
            <span className="text-text-2 text-sm font-normal">
              {totalMatching !== proposals.length
                ? t('home.list.countOf', { shown: totalMatching, total: proposals.length })
                : t('home.list.count', { n: proposals.length })}
            </span>
          )}
        </h2>
        <div className="flex-1 flex flex-col sm:flex-row gap-2 sm:justify-end">
          <div className="inline-flex bg-bg-2 border border-border rounded-lg p-0.5 self-start sm:self-auto">
            {(['all', 'active', 'expired'] as Bucket[]).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBucket(b)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  bucket === b
                    ? 'bg-accent/15 text-accent-2'
                    : 'text-text-2 hover:text-text'
                }`}
              >
                {t(`home.bucket.${b}`)}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('home.list.search')}
            className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent/50 sm:w-64"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-bg-2 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent/50"
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>{t(`home.sort.${k}`)}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <p className="text-text-2">{t('proposal.loading')}</p>}
      {!isLoading && (!proposals || proposals.length === 0) && (
        <div className="card text-center py-16">
          <p className="text-text-2">
            {t('home.empty.noneSignedIn')}{' '}
            {me ? (
              <Link className="text-accent" to="/proposal/new">{t('home.empty.beTheFirst')}</Link>
            ) : (
              t('home.empty.noneSignedOut')
            )}
          </p>
        </div>
      )}
      {!isLoading && proposals && proposals.length > 0 && totalMatching === 0 && (
        <div className="card text-center py-16">
          <p className="text-text-2">
            {t('home.empty.noMatch')}
            {query && <> <span className="text-text font-mono">{query}</span></>}.
          </p>
        </div>
      )}

      {showActive && activeList.length > 0 && (
        <Section
          title={t('home.section.active', { n: activeList.length })}
          accent="emerald"
          items={activeList}
        />
      )}

      {showExpired && expiredList.length > 0 && (
        <Section
          title={t('home.section.expired', { n: expiredList.length })}
          accent="muted"
          items={expiredList}
          dim
        />
      )}
    </div>
  )
}

function Section({
  title, accent, items, dim,
}: {
  title: string
  accent: 'emerald' | 'muted'
  items: ProposalSummary[]
  dim?: boolean
}) {
  return (
    <section className={dim ? 'mt-12' : 'mt-2'}>
      <h3 className="text-sm font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
        <span className={
          accent === 'emerald' ? 'text-emerald-400' : 'text-text-2'
        }>{title}</span>
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((it) => (
          <ProposalCard key={it.id} it={it} dim={dim} />
        ))}
      </div>
    </section>
  )
}

function ProposalCard({ it, dim }: { it: ProposalSummary; dim?: boolean }) {
  const { t } = useTranslation()
  // The chain may still report status 'open' for a few minutes after the
  // deadline until the indexer flips it. Show a single "expired" badge in
  // that window instead of stacking 'open' + 'expired' contradictorily.
  const expired = isExpired(it)
  const showExpiredBadge = expired && it.status === 'open'
  const showClosedBadge = it.status === 'closed'
  const showOpenBadge = !expired && it.status === 'open'
  return (
    <Link
      to={`/proposal/${it.id}`}
      className={`card card-hover block ${dim ? 'opacity-80 hover:opacity-100 transition-opacity' : ''}`}
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {showOpenBadge && (
            <span className="pill flex-shrink-0 bg-emerald-500/10 text-emerald-400">
              {t('proposal.status.open')}
            </span>
          )}
          {showClosedBadge && (
            <span className="pill flex-shrink-0 bg-white/5 text-text-2">
              {t('proposal.status.closed')}
            </span>
          )}
          {showExpiredBadge && (
            <span className="pill flex-shrink-0 bg-rose-500/15 text-rose-400">
              {t('countdown.expired')}
            </span>
          )}
          <CountdownPill
            closesAt={it.closes_at}
            status={expired ? 'closed' : it.status}
            compact
          />
          {it.comment_count > 0 && (
            <span className="pill bg-white/5 text-text-2 flex-shrink-0 inline-flex items-center gap-1 tabular-nums">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {it.comment_count}
            </span>
          )}
        </div>
        <span className="text-xs text-text-2 flex-shrink-0">{formatRelative(it.created_at)}</span>
      </div>
      <h3 className="text-lg font-semibold mb-1 line-clamp-2">{it.title}</h3>
      {it.summary && (
        <p className="text-text-2 text-[13px] leading-snug mb-4">{it.summary}</p>
      )}
      <TallyStats tally={it.tally} layout="inline" />
    </Link>
  )
}
