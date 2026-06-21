import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../lib/markdown'
import { api, TenderDetail } from '../lib/api'
import { useAppConfig, useTrackerLinks } from '../lib/useAppConfig'
import { TallyStats } from '../components/TallyStats'
import { Comments } from '../components/Comments'
import { HowToVote } from '../components/HowToVote'
import { Avatar } from '../components/Avatar'
import { CountdownPill, CountdownBig } from '../components/Countdown'
import { TranslatedText, TranslationToggle, type TranslationMode } from '../components/TranslatedText'
import { formatCount, formatDateTime, formatGNK, formatRelative } from '../lib/format'
import { useMe } from '../hooks/useMe'

export function TenderDetailPage() {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { data: me } = useMe()
  const { data: tender, isLoading, error } = useQuery({
    queryKey: ['tender', id, lng],
    queryFn: () => api.get<TenderDetail>(`/tenders/${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  })

  // Single source of truth for "show original ↔ show translation" — flips
  // title, summary, and description together. Resets on every reload.
  const [translationMode, setTranslationMode] = useState<TranslationMode>('translated')

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/tenders/${id}`),
    onSuccess: () => nav('/'),
  })

  const onDelete = () => {
    if (!tender) return
    if (window.confirm(t('tender.deleteConfirm', { title: tender.title }))) {
      deleteMut.mutate()
    }
  }
  const { data: config } = useAppConfig()

  if (isLoading) return <p className="text-text-2 max-w-[1400px] mx-auto px-5 py-12">{t('tender.loading')}</p>
  if (error || !tender) {
    return (
      <div className="max-w-[1400px] mx-auto px-5 py-12">
        <p className="text-rose-400">{t('tender.notFound')}</p>
        <Link to="/" className="btn-ghost mt-4 inline-flex">{t('tender.back2')}</Link>
      </div>
    )
  }

  const closed = tender.status === 'closed'
  // Indexer flips status='open' → 'closed' a few minutes after closes_at;
  // until then we show a single "expired" badge instead of stacking
  // 'open' + 'expired' contradictorily.
  const expired = !closed && !!tender.closes_at &&
    new Date(tender.closes_at).getTime() <= Date.now()
  const showOpenBadge = !closed && !expired
  const effectiveStatus: 'open' | 'closed' = expired ? 'closed' : tender.status

  // Sidebar contents — re-used in two slots: between description-area and
  // comments on mobile, and as the right column on desktop.
  const sidebar = (
    <div className="space-y-4">
      {tender.closes_at && (
        <div className="card">
          <CountdownBig closesAt={tender.closes_at} status={tender.status} />
          <div className="text-text-2 text-xs mt-2">
            {formatDateTime(tender.closes_at)}
          </div>
        </div>
      )}
      <HowToVote
        tenderId={tender.id}
        config={config}
        disabled={closed}
        defaultBidNgonka={tender.tally.weighted_avg_bid_ngonka}
      />
      <div className="card text-xs text-text-2 space-y-2 leading-relaxed">
        <p><strong className="text-text">{t('tender.sidebar.tenderId')}</strong></p>
        <p className="font-mono break-all">{tender.id}</p>
        {config?.contract_address && (
          <>
            <p className="pt-2"><strong className="text-text">{t('tender.sidebar.contract')}</strong></p>
            <p className="font-mono break-all">{config.contract_address}</p>
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12">
      <div className="mb-8">
        <Link to="/" className="text-text-2 text-sm hover:text-accent">
          {t('tender.back')}
        </Link>
      </div>

      {/* Header — width matches the left column (1fr) on desktop so title
          and summary don't stretch the full page. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-8 mb-8">
        <header className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {showOpenBadge && (
              <span className="pill bg-emerald-500/10 text-emerald-400">
                {t('tender.status.open')}
              </span>
            )}
            {closed && (
              <span className="pill bg-white/5 text-text-2">
                {t('tender.status.closed')}
              </span>
            )}
            {expired && (
              <span className="pill bg-rose-500/15 text-rose-400">
                {t('countdown.expired')}
              </span>
            )}
            <CountdownPill closesAt={tender.closes_at} status={effectiveStatus} />
            <TranslationToggle
              isTranslated={tender.is_translated}
              status={tender.translation_status}
              mode={translationMode}
              onChange={setTranslationMode}
              sourceLang={tender.source_lang}
            />
            <span className="text-xs text-text-2 flex items-center gap-1">
              {t('tender.by')}{' '}
              {tender.creator_uid ? (
                <Link
                  to={`/u/${tender.creator_uid}`}
                  className="hover:text-accent inline-flex items-center gap-1.5"
                >
                  <Avatar
                    src={tender.creator_image}
                    name={tender.creator_name}
                    email={tender.creator_uid}
                    size={6}
                  />
                  <span>{tender.creator_name || tender.creator_uid}</span>
                </Link>
              ) : (
                <span>{t('tender.unknown')}</span>
              )}
              {' · '}
              {formatRelative(tender.created_at)}
            </span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <TranslatedText
              as="h1"
              className="text-3xl md:text-4xl font-extrabold leading-tight tracking-tight"
              translated={tender.title}
              original={tender.original_title}
              isTranslated={tender.is_translated}
              status={tender.translation_status}
              mode={translationMode}
            />
            {me?.is_admin && (
              <button
                onClick={onDelete}
                disabled={deleteMut.isPending}
                className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
                title={t('tender.delete')}
              >
                {deleteMut.isPending ? t('tender.deleting') : t('tender.delete')}
              </button>
            )}
          </div>
          {tender.summary && (
            <TranslatedText
              as="p"
              className="mt-4 text-text-2 text-base md:text-lg leading-relaxed"
              translated={tender.summary}
              original={tender.original_summary}
              isTranslated={tender.is_translated}
              status={tender.translation_status}
              mode={translationMode}
            />
          )}
        </header>
        {/* Empty cell on the right column under the header — keeps the
            sidebar starting flush with the description below. */}
      </div>

      {/* Body: 2-column grid below the header. Sidebar starts at the same
          vertical line as the description and scrolls with the page. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-8 items-start">
        <div className="space-y-8 min-w-0">
          <TranslatedText
            as="article"
            className="card prose prose-invert prose-sm max-w-none prose-a:text-accent prose-headings:text-text"
            translated={tender.description}
            original={tender.original_description}
            isTranslated={tender.is_translated}
            status={tender.translation_status}
            mode={translationMode}
            render={(text) => <Markdown>{text}</Markdown>}
          />

          <section className="card">
            <TallyStats tally={tender.tally} />
            {tender.tally.refreshed_at && (
              <p className="text-[11px] text-text-2 mt-4">
                {t('tender.tally.refreshed', { when: formatRelative(tender.tally.refreshed_at) })}
              </p>
            )}
          </section>

          {tender.voters.length > 0 && (
            <section className="card">
              <h2 className="text-lg font-bold mb-4">
                {t('tender.voters.title')}{' '}
                <span className="text-text-2 text-sm font-normal">
                  ({tender.voters.length})
                </span>
              </h2>
              <VotersTable voters={tender.voters} />
            </section>
          )}

          {/* Sidebar inline on mobile only — sits between Voters and Comments. */}
          <div className="lg:hidden">{sidebar}</div>

          <Comments tenderId={tender.id} />
        </div>

        <aside className="hidden lg:block">{sidebar}</aside>
      </div>
    </div>
  )
}

/**
 * Voters table — flex row so the Address column shrinks first when space is
 * tight. Numeric cells stay at their natural width and never wrap. The Hosts
 * column is hidden on small screens (it's a niche per-host metric).
 *
 * Pagination: client-side, 10 rows per page. The full list is already in
 * memory from /api/tenders/{id}, so "Show next 10" just bumps a counter.
 */
const PAGE_SIZE = 10

type VotersSortKey = 'address' | 'grant' | 'balance' | 'hosts' | 'voted'
type Order = 'asc' | 'desc'

const VOTERS_DEFAULT_ORDER: Record<VotersSortKey, Order> = {
  address: 'asc',
  grant: 'desc',
  balance: 'desc',
  hosts: 'desc',
  voted: 'desc',
}

function bi(s: string | number | null | undefined): bigint {
  if (s === undefined || s === null || s === '') return 0n
  try {
    return BigInt(typeof s === 'number' ? Math.floor(s) : s)
  } catch {
    return 0n
  }
}

function VotersTable({ voters }: { voters: TenderDetail['voters'] }) {
  const { t } = useTranslation()
  const { data: cfg } = useAppConfig()
  const trackerLinks = useTrackerLinks(cfg)
  const [shown, setShown] = useState(PAGE_SIZE)
  const [sortKey, setSortKey] = useState<VotersSortKey>('balance')
  const [order, setOrder] = useState<Order>('desc')
  const headerCls =
    'text-[11px] text-text-2 uppercase tracking-wider whitespace-nowrap'
  const valueCls = 'text-text-2 text-xs whitespace-nowrap tabular-nums'

  const sorted = useMemo(() => {
    const arr = [...voters]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'address':
          cmp = a.voter.localeCompare(b.voter)
          break
        case 'grant': {
          const av = bi(a.amount_ngonka), bv = bi(b.amount_ngonka)
          cmp = av < bv ? -1 : av > bv ? 1 : 0
          break
        }
        case 'balance': {
          const av = bi(a.community_weight_ngonka), bv = bi(b.community_weight_ngonka)
          cmp = av < bv ? -1 : av > bv ? 1 : 0
          break
        }
        case 'hosts': {
          const av = bi(a.hosts_weight_ngonka), bv = bi(b.hosts_weight_ngonka)
          cmp = av < bv ? -1 : av > bv ? 1 : 0
          break
        }
        case 'voted': {
          const at = a.voted_at ? Date.parse(a.voted_at) : 0
          const bt = b.voted_at ? Date.parse(b.voted_at) : 0
          cmp = at - bt
          break
        }
      }
      return order === 'asc' ? cmp : -cmp
    })
    return arr
  }, [voters, sortKey, order])

  const visible = sorted.slice(0, shown)
  const remaining = sorted.length - visible.length

  const click = (k: VotersSortKey) => {
    if (k === sortKey) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(k)
      setOrder(VOTERS_DEFAULT_ORDER[k])
    }
    setShown(PAGE_SIZE)  // reset pagination on sort change
  }

  return (
    <div className="space-y-1.5">
      {/* header */}
      <div className="flex items-center gap-3 px-1 mb-1">
        <SortHeader className={`flex-1 min-w-0 ${headerCls}`} active={sortKey === 'address'} order={order} onClick={() => click('address')}>
          {t('tender.voters.address')}
        </SortHeader>
        <SortHeader className={`w-20 justify-end ${headerCls}`} active={sortKey === 'grant'} order={order} onClick={() => click('grant')}>
          {t('tender.voters.grant')}
        </SortHeader>
        <SortHeader className={`w-20 justify-end ${headerCls}`} active={sortKey === 'balance'} order={order} onClick={() => click('balance')}>
          {t('tender.voters.weight')}
        </SortHeader>
        <SortHeader className={`w-16 justify-end ${headerCls} hidden md:inline-flex`} active={sortKey === 'hosts'} order={order} onClick={() => click('hosts')}>
          {t('tender.voters.hostsCol')}
        </SortHeader>
        <SortHeader className={`w-20 justify-end ${headerCls}`} active={sortKey === 'voted'} order={order} onClick={() => click('voted')}>
          {t('tender.voters.voted')}
        </SortHeader>
        <span className={`w-6 text-right ${headerCls}`}>{t('tender.voters.tx')}</span>
      </div>

      {visible.map((v) => (
        <div
          key={v.voter}
          className="flex items-center gap-3 text-sm px-1 py-1 rounded hover:bg-white/5"
        >
          {trackerLinks.enabled ? (
            <a
              href={trackerLinks.address(v.voter)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 min-w-0 font-mono text-accent hover:underline truncate"
              title={v.voter}
            >
              {v.voter}
            </a>
          ) : (
            <span className="flex-1 min-w-0 font-mono truncate" title={v.voter}>
              {v.voter}
            </span>
          )}
          <span className="w-20 text-right font-semibold whitespace-nowrap tabular-nums">
            {formatGNK(v.amount_ngonka, { integer: true })}
          </span>
          <span className={`w-20 text-right ${valueCls}`}>
            {formatGNK(v.community_weight_ngonka, { integer: true, noUnit: true })}
          </span>
          <span className={`w-16 text-right ${valueCls} hidden md:inline`}>
            {formatCount(v.hosts_weight_ngonka)}
          </span>
          <span
            className={`w-20 text-right ${valueCls}`}
            title={v.voted_at ? formatDateTime(v.voted_at) : undefined}
          >
            {v.voted_at ? formatRelative(v.voted_at) : '—'}
          </span>
          <span className="w-6 text-right">
            {v.tx_hash && trackerLinks.enabled ? (
              <a
                href={trackerLinks.tx(v.tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
                title={t('tender.voters.openTx', { hash: v.tx_hash })}
                aria-label={t('tender.voters.openTracker')}
                className="text-accent hover:text-accent-2 inline-flex items-center justify-center"
              >
                <ExternalLinkIcon />
              </a>
            ) : (
              <span className="text-text-2 text-xs">—</span>
            )}
          </span>
        </div>
      ))}

      {remaining > 0 && (
        <div className="flex items-center justify-between gap-2 pt-3 mt-2 border-t border-border">
          <span className="text-xs text-text-2">
            {t('tender.voters.showingOf', { shown: visible.length, total: sorted.length })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="btn-ghost text-xs"
            >
              {t('tender.voters.showMore', { n: Math.min(PAGE_SIZE, remaining) })}
            </button>
            {remaining > PAGE_SIZE && (
              <button
                type="button"
                onClick={() => setShown(sorted.length)}
                className="btn-ghost text-xs"
              >
                {t('tender.voters.showAll')}
              </button>
            )}
          </div>
        </div>
      )}

      {shown > PAGE_SIZE && remaining === 0 && sorted.length > PAGE_SIZE && (
        <div className="flex justify-end pt-3 mt-2 border-t border-border">
          <button
            type="button"
            onClick={() => setShown(PAGE_SIZE)}
            className="btn-ghost text-xs"
          >
            {t('tender.voters.showLess')}
          </button>
        </div>
      )}
    </div>
  )
}

// Clickable column header: arrow + accent color when active.
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
      className={`inline-flex items-center gap-1 cursor-pointer hover:text-text transition-colors text-left ${
        active ? 'text-accent-2' : ''
      } ${className || ''}`}
    >
      <span className="truncate">{children}</span>
      {arrow && <span className="shrink-0">{arrow}</span>}
    </button>
  )
}

function ExternalLinkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}
