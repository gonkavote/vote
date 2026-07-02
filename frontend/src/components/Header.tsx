import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useMe } from '../hooks/useMe'
import { useLogin } from '../lib/loginContext'
import { api, type GovProposalsPage } from '../lib/api'
import { Avatar } from './Avatar'
import { LanguageSwitcher } from './LanguageSwitcher'

// Visible from every page: small red badge next to the Governance link
// when at least one proposal is currently in voting. Polled once per
// minute; shared cache across routes via the queryKey.
function useActiveProposalsCount(): number {
  const { data } = useQuery<number>({
    queryKey: ['governance', 'active-count'],
    queryFn: async () => {
      const page = await api.get<GovProposalsPage>(
        '/governance/proposals?status=voting&page=1&page_size=1',
      )
      return Number(page?.total ?? 0)
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })
  return data ?? 0
}

export function Header() {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const loc = useLocation()
  const { openLogin } = useLogin()

  const onGovernance = loc.pathname.startsWith('/governance')
  // The Governance link uses the same .btn-ghost style as the other header
  // buttons, with an extra accent overlay when the user is on that page.
  const govActiveCls = onGovernance ? 'bg-accent/15 text-accent-2' : ''
  const activeProposalsCount = useActiveProposalsCount()

  return (
    <header className="fixed top-0 inset-x-0 z-50 h-16 flex items-center justify-between px-5 md:px-12 bg-bg/80 backdrop-blur-xl border-b border-border">
      <Link to="/" className="flex items-center gap-2 font-extrabold text-lg shrink-0">
        <img src="/images/logo.svg" alt="" className="w-7 h-7 rounded-[7px]" />
        <span className="hidden md:inline">
          Gonka <em className="not-italic text-accent">Vote</em>
        </span>
      </Link>
      <nav className="flex items-center gap-1 sm:gap-2">
        <Link to="/governance" className={`btn-ghost ${govActiveCls} relative`}>
          {t('header.governance')}
          {activeProposalsCount > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none shadow-md ring-2 ring-bg"
              title={`${activeProposalsCount} active proposal${activeProposalsCount === 1 ? '' : 's'}`}
            >
              {activeProposalsCount > 99 ? '99+' : activeProposalsCount}
            </span>
          )}
        </Link>
        <Link to="/proposal/new" className="hidden sm:inline-flex btn-ghost">
          {t('header.newProposal')}
        </Link>
        {me ? (
          <Link to="/me" className="btn-ghost flex items-center gap-2">
            <Avatar src={me.image} name={me.name} email={me.uid} size={6} />
            <span className="hidden sm:inline">{me.name || me.uid}</span>
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => openLogin(loc.pathname + loc.search)}
            className="btn-primary"
          >
            {t('header.signIn')}
          </button>
        )}
        <LanguageSwitcher />
      </nav>
    </header>
  )
}
