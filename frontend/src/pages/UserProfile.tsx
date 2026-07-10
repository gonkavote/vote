import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, UserPublicProfile } from '../lib/api'
import { Avatar } from '../components/Avatar'
import { ReactionStats } from '../components/ReactionStats'
import { formatGNK, formatRelative } from '../lib/format'

export function UserProfilePage() {
  const { t } = useTranslation()
  const { uid } = useParams<{ uid: string }>()
  const { data, isLoading, error } = useQuery({
    queryKey: ['user', uid],
    queryFn: () => api.get<UserPublicProfile>(`/users/${uid}`),
    enabled: !!uid,
  })

  if (isLoading) {
    return (
      <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12">
        <p className="text-text-2">{t('profile.loading')}</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12">
        <p className="text-rose-400">{t('profile.notFound')}</p>
        <Link to="/" className="btn-ghost mt-4 inline-flex">{t('profile.home')}</Link>
      </div>
    )
  }

  return (
    <div className="max-w-[1400px] mx-auto px-5 md:px-12 py-12 space-y-10">
      <Link to="/" className="text-text-2 text-sm hover:text-accent">{t('profile.back')}</Link>

      <header className="flex items-center gap-5">
        <Avatar src={data.image} name={data.name} email={data.uid} size={20} />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight truncate">
            {data.name || data.uid}
          </h1>
          <p className="text-text-2 text-sm font-mono">{data.uid}</p>
          {data.linked_wallets_count > 0 && (
            <p className="text-text-2 text-xs mt-2 flex items-center flex-wrap gap-x-2">
              <span className="uppercase tracking-wider">{t('profile.totalWeight')}</span>
              <span className="font-bold text-text">
                {formatGNK(data.total_weight_ngonka, { integer: true, compactPrecision: 0 })}
              </span>
              <span className="text-text-2/70">
                · {t('profile.linkedWallets', { n: data.linked_wallets_count })}
              </span>
            </p>
          )}
        </div>
      </header>

      <section>
        <h2 className="text-lg font-bold mb-4">
          {t('profile.proposalsTitle')}{' '}
          <span className="text-text-2 text-sm font-normal">
            {t('profile.proposalsCount', { n: data.proposals.length })}
          </span>
        </h2>
        {data.proposals.length === 0 ? (
          <div className="card text-center py-10 text-text-2">
            {t('profile.noProposals')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.proposals.map((it) => {
              const expired = it.status === 'closed' || (!!it.closes_at && new Date(it.closes_at).getTime() <= Date.now())
              const showExpiredBadge = expired && it.status === 'open'
              const showClosedBadge = it.status === 'closed'
              const showOpenBadge = !expired && it.status === 'open'
              return (
              <Link
                key={it.id}
                to={`/proposal/${it.short_id || it.id}`}
                className="card card-hover block"
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
                  </div>
                  <span className="text-xs text-text-2 flex-shrink-0">
                    {formatRelative(it.created_at)}
                  </span>
                </div>
                <h3 className="text-lg font-semibold mb-1 line-clamp-2">
                  {it.title}
                </h3>
                {it.summary && (
                  <p className="text-text-2 text-[13px] leading-snug mb-4">
                    {it.summary}
                  </p>
                )}
                <ReactionStats
                  likesCount={it.likes_count}
                  dislikesCount={it.dislikes_count}
                  likesWeightNgonka={it.likes_weight_ngonka}
                  dislikesWeightNgonka={it.dislikes_weight_ngonka}
                  requestedAmountUsdt={it.requested_amount_usdt}
                  requestedAmountGnk={it.requested_amount_gnk}
                  layout="inline"
                />
              </Link>
            )})}
          </div>
        )}
      </section>
    </div>
  )
}
