import { Link, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMe } from '../hooks/useMe'
import { Avatar } from '../components/Avatar'
import { LinkedWallets } from '../components/LinkedWallets'

export function MePage() {
  const { t } = useTranslation()
  const { data: me, isLoading } = useMe()

  if (isLoading) return null
  if (!me) return <Navigate to="/" replace />

  return (
    <div className="max-w-[680px] mx-auto px-5 md:px-12 py-12 space-y-8">
      <header className="flex items-center gap-4">
        <Avatar src={me.image} name={me.name} email={me.uid} size={16} />
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight truncate">
            {me.name || me.uid}
          </h1>
          <p className="text-text-2 text-sm truncate">{me.email}</p>
          <p className="text-text-2 text-xs font-mono mt-1">{me.uid}</p>
        </div>
      </header>

      {me.uid && (
        <Link
          to={`/u/${me.uid}`}
          className="btn-ghost inline-flex"
        >
          {t('me.viewPublic')}
        </Link>
      )}

      <LinkedWallets accountUid={me.uid} />

      <form action="/api/auth/logout" method="post">
        <button type="submit" className="btn-ghost text-rose-400 hover:text-rose-300">
          {t('me.signOut')}
        </button>
      </form>
    </div>
  )
}
