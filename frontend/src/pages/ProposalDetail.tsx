import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../lib/markdown'
import { api, ProposalDetail } from '../lib/api'
import { useAppConfig } from '../lib/useAppConfig'
import { ReactionStats } from '../components/ReactionStats'
import { ProposalReactionButtons } from '../components/ProposalReactionButtons'
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
  const { data: config } = useAppConfig()

  if (isLoading) return <p className="text-text-2 max-w-[1400px] mx-auto px-5 py-12">{t('proposal.loading')}</p>
  if (error || !proposal) {
    return (
      <div className="max-w-[1400px] mx-auto px-5 py-12">
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

  // Sidebar contents — re-used in two slots: between description-area and
  // comments on mobile, and as the right column on desktop.
  const sidebar = (
    <div className="space-y-4">
      {proposal.closes_at && (
        <div className="card">
          <CountdownBig closesAt={proposal.closes_at} status={proposal.status} />
          <div className="text-text-2 text-xs mt-2">
            {formatDateTime(proposal.closes_at)}
          </div>
        </div>
      )}
      <ProposalReactionButtons proposalId={proposal.id} lng={lng} />
      <div className="card text-xs text-text-2 space-y-2 leading-relaxed">
        <p><strong className="text-text">{t('proposal.sidebar.proposalId')}</strong></p>
        <p className="font-mono break-all">{proposal.id}</p>
        {config?.contract_address && (
          <>
            <p className="pt-2"><strong className="text-text">{t('proposal.sidebar.contract')}</strong></p>
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
          {t('proposal.back')}
        </Link>
      </div>

      {/* Header — width matches the left column (1fr) on desktop so title
          and summary don't stretch the full page. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-8 mb-8">
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
            translated={proposal.description}
            original={proposal.original_description}
            isTranslated={proposal.is_translated}
            status={proposal.translation_status}
            mode={translationMode}
            render={(text) => <Markdown>{text}</Markdown>}
          />

          <section className="card">
            <ReactionStats
              likesCount={proposal.likes_count}
              dislikesCount={proposal.dislikes_count}
              likesWeightNgonka={proposal.likes_weight_ngonka}
              dislikesWeightNgonka={proposal.dislikes_weight_ngonka}
              requestedAmountUsdt={proposal.requested_amount_usdt}
              requestedAmountGnk={proposal.requested_amount_gnk}
            />
          </section>

          {/* Sidebar inline on mobile only — sits between reactions and Comments. */}
          <div className="lg:hidden">{sidebar}</div>

          <Comments proposalId={proposal.id} />
        </div>

        <aside className="hidden lg:block">{sidebar}</aside>
      </div>
    </div>
  )
}
