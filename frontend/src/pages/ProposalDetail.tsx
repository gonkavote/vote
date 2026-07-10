import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ExpandableMarkdown } from '../components/ExpandableMarkdown'
import { api, ProposalDetail } from '../lib/api'
import { ReactionStats } from '../components/ReactionStats'
import { useProposalReaction } from '../components/ProposalReactionButtons'
import { Comments } from '../components/Comments'
import { Avatar } from '../components/Avatar'
import { CountdownPill, CountdownBig } from '../components/Countdown'
import { TranslatedText, TranslationToggle, type TranslationMode } from '../components/TranslatedText'
import { formatDateTime, formatRelative } from '../lib/format'
import { useMe } from '../hooks/useMe'

export function ProposalDetailPage() {
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { data: me } = useMe()
  const { data: proposal, isLoading, error } = useQuery({
    queryKey: ['proposal', id, lng],
    queryFn: () => api.get<ProposalDetail>(`/proposal/${id}`),
    enabled: !!id,
    refetchInterval: 30_000,
  })

  // Single source of truth for "show original ↔ show translation" — flips
  // title, summary, and description together. Resets on every reload.
  const [translationMode, setTranslationMode] = useState<TranslationMode>('translated')

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/proposal/${id}`),
    onSuccess: () => nav('/'),
  })

  const onDelete = () => {
    if (!proposal) return
    if (window.confirm(t('proposal.deleteConfirm', { title: proposal.title }))) {
      deleteMut.mutate()
    }
  }
  if (isLoading) return <p className="text-text-2 max-w-[980px] mx-auto px-5 py-12">{t('proposal.loading')}</p>
  if (error || !proposal) {
    return (
      <div className="max-w-[980px] mx-auto px-5 py-12">
        <p className="text-rose-400">{t('proposal.notFound')}</p>
        <Link to="/" className="btn-ghost mt-4 inline-flex">{t('proposal.back2')}</Link>
      </div>
    )
  }

  const closed = proposal.status === 'closed'
  // Indexer flips status='open' → 'closed' a few minutes after closes_at;
  // until then we show a single "expired" badge instead of stacking
  // 'open' + 'expired' contradictorily.
  const expired = !closed && !!proposal.closes_at &&
    new Date(proposal.closes_at).getTime() <= Date.now()
  const showOpenBadge = !closed && !expired
  const effectiveStatus: 'open' | 'closed' = expired ? 'closed' : proposal.status

  return (
    <div className="max-w-[980px] mx-auto px-5 md:px-12 py-12">
      <div className="mb-8">
        <Link to="/" className="text-text-2 text-sm hover:text-accent">
          {t('proposal.back')}
        </Link>
      </div>

      <div className="mb-8">
        <header className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {showOpenBadge && (
              <span className="pill bg-emerald-500/10 text-emerald-400">
                {t('proposal.status.open')}
              </span>
            )}
            {closed && (
              <span className="pill bg-white/5 text-text-2">
                {t('proposal.status.closed')}
              </span>
            )}
            {expired && (
              <span className="pill bg-rose-500/15 text-rose-400">
                {t('countdown.expired')}
              </span>
            )}
            <CountdownPill closesAt={proposal.closes_at} status={effectiveStatus} />
            <TranslationToggle
              isTranslated={proposal.is_translated}
              status={proposal.translation_status}
              mode={translationMode}
              onChange={setTranslationMode}
              sourceLang={proposal.source_lang}
            />
            <span className="text-xs text-text-2 flex items-center gap-1">
              {t('proposal.by')}{' '}
              {proposal.creator_uid ? (
                <Link
                  to={`/u/${proposal.creator_uid}`}
                  className="hover:text-accent inline-flex items-center gap-1.5"
                >
                  <Avatar
                    src={proposal.creator_image}
                    name={proposal.creator_name}
                    email={proposal.creator_uid}
                    size={6}
                  />
                  <span>{proposal.creator_name || proposal.creator_uid}</span>
                </Link>
              ) : (
                <span>{t('proposal.unknown')}</span>
              )}
              {' · '}
              {formatRelative(proposal.created_at)}
            </span>
          </div>
          <div className="flex items-start justify-between gap-4">
            <TranslatedText
              as="h1"
              className="text-3xl md:text-4xl font-extrabold leading-tight tracking-tight"
              translated={proposal.title}
              original={proposal.original_title}
              isTranslated={proposal.is_translated}
              status={proposal.translation_status}
              mode={translationMode}
            />
            {me?.is_admin && (
              <button
                onClick={onDelete}
                disabled={deleteMut.isPending}
                className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
                title={t('proposal.delete')}
              >
                {deleteMut.isPending ? t('proposal.deleting') : t('proposal.delete')}
              </button>
            )}
          </div>
          {proposal.summary && (
            <TranslatedText
              as="p"
              className="mt-4 text-text-2 text-base md:text-lg leading-relaxed"
              translated={proposal.summary}
              original={proposal.original_summary}
              isTranslated={proposal.is_translated}
              status={proposal.translation_status}
              mode={translationMode}
            />
          )}
        </header>
      </div>

      <div className="space-y-8 min-w-0">
        <TranslatedText
          as="article"
          className="card prose prose-invert prose-sm max-w-none min-w-0 overflow-hidden prose-a:text-accent prose-a:break-words prose-headings:text-text prose-p:break-words"
          translated={proposal.description}
          original={proposal.original_description}
          isTranslated={proposal.is_translated}
          status={proposal.translation_status}
          mode={translationMode}
          render={(text) => <ExpandableMarkdown text={text} />}
        />

        <RequestedAndCountdown
          usdt={proposal.requested_amount_usdt}
          gnk={proposal.requested_amount_gnk}
          closesAt={proposal.closes_at}
          status={proposal.status}
        />

        <section className="card">
          <ReactionStatsWithReactions
            proposalId={id || proposal.id}
            lng={lng}
            likesCount={proposal.likes_count}
            dislikesCount={proposal.dislikes_count}
            likesWeightNgonka={proposal.likes_weight_ngonka}
            dislikesWeightNgonka={proposal.dislikes_weight_ngonka}
            myReaction={proposal.my_reaction}
          />
        </section>

        <Comments proposalId={proposal.id} />
      </div>
    </div>
  )
}

function fmtRequested(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return n.toLocaleString()
}

function RequestedAndCountdown({
  usdt, gnk, closesAt, status,
}: {
  usdt: number
  gnk: number
  closesAt: string | null
  status: 'open' | 'closed'
}) {
  const { t } = useTranslation()
  const hasRequested = usdt > 0 || gnk > 0
  const parts: string[] = []
  if (usdt > 0) parts.push(`${fmtRequested(usdt)} USDT`)
  if (gnk > 0) parts.push(`${fmtRequested(gnk)} GNK`)
  if (!hasRequested && !closesAt) return null
  return (
    <div className={`grid gap-4 ${hasRequested && closesAt ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
      {hasRequested && (
        <section className="card">
          <div className="text-[11px] uppercase tracking-wider text-text-2 mb-2">
            {t('proposal.reactions.requestedAmount')}
          </div>
          <div className="text-2xl md:text-3xl font-extrabold">{parts.join(' + ')}</div>
        </section>
      )}
      {closesAt && (
        <section className="card">
          <CountdownBig closesAt={closesAt} status={status} />
          <div className="text-text-2 text-xs mt-2">{formatDateTime(closesAt)}</div>
        </section>
      )}
    </div>
  )
}

function ReactionStatsWithReactions({
  proposalId, lng, likesCount, dislikesCount,
  likesWeightNgonka, dislikesWeightNgonka, myReaction,
}: {
  proposalId: string
  lng: string
  likesCount: number
  dislikesCount: number
  likesWeightNgonka: string
  dislikesWeightNgonka: string
  myReaction: 'like' | 'dislike' | null
}) {
  const { toggle, isPending } = useProposalReaction(proposalId, lng)
  return (
    <ReactionStats
      likesCount={likesCount}
      dislikesCount={dislikesCount}
      likesWeightNgonka={likesWeightNgonka}
      dislikesWeightNgonka={dislikesWeightNgonka}
      requestedAmountUsdt={0}
      requestedAmountGnk={0}
      layout="card"
      onReact={toggle}
      myReaction={myReaction}
      reactDisabled={isPending}
    />
  )
}
