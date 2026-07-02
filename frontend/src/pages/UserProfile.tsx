import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, UserPublicProfile } from '../lib/api'
import { Avatar } from '../components/Avatar'
import { TallyStats } from '../components/TallyStats'
import { formatRelative } from '../lib/format'
import { useAppConfig, useTrackerLinks } from '../lib/useAppConfig'

export function UserProfilePage() {
  const { t } = useTranslation()
  const { uid } = useParams<{ uid: string }>()
  const { data: cfg } = useAppConfig()
  const trackerLinks = useTrackerLinks(cfg)
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
          {data.wallet_address && (
            <p className="text-text-2 text-xs mt-2 flex items-center flex-wrap gap-x-2">
              <span className="uppercase tracking-wider">{t('profile.wallet')}</span>
              {trackerLinks.enabled ? (
                <a
                  href={trackerLinks.address(data.wallet_address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-accent hover:underline break-all"
                >
                  {data.wallet_address}
                </a>
              ) : (
                <span className="font-mono break-all text-text-2">
                  {data.wallet_address}
                </span>
              )}
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
                to={`/proposal/${it.id}`}
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
                <TallyStats tally={it.tally} layout="inline" />
              </Link>
            )})}
          </div>
        )}
      </section>
    </div>
  )
}
