import { FormEvent, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, Me } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { Avatar } from '../components/Avatar'
import { LinkedWallets } from '../components/LinkedWallets'

export function MePage() {
  const { t } = useTranslation()
  const { data: me, isLoading } = useMe()
  const qc = useQueryClient()
  const [wallet, setWallet] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (me) setWallet(me.wallet_address || '')
  }, [me])

  const update = useMutation({
    mutationFn: (addr: string | null) => api.patch<Me>('/me', { wallet_address: addr }),
    onSuccess: (m) => {
      qc.setQueryData(['me'], m)
      setSavedAt(Date.now())
      setError(null)
    },
    onError: (err: any) => {
      const detail = err?.body?.detail
      setError(typeof detail === 'string' ? detail : 'Failed to save')
    },
  })

  if (isLoading) return null
  if (!me) return <Navigate to="/" replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    update.mutate(wallet.trim() === '' ? null : wallet.trim())
  }

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

      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="text-sm font-semibold block mb-1">{t('me.rewardWalletLabel')}</label>
          <p className="text-text-2 text-xs leading-relaxed mb-3">
            {t('me.rewardWalletHint')}
          </p>
          <input
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="gonka1…"
            className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm font-mono focus:outline-none focus:border-accent/50"
          />
        </div>
        {error && <p className="text-rose-400 text-sm">{error}</p>}
        <div className="flex items-center justify-between">
          <button type="submit" disabled={update.isPending} className="btn-primary">
            {update.isPending ? t('me.saving') : t('me.save')}
          </button>
          {savedAt && Date.now() - savedAt < 3000 && (
            <span className="text-emerald-400 text-sm">{t('me.saved')}</span>
          )}
        </div>
      </form>

      <form action="/api/auth/logout" method="post">
        <button type="submit" className="btn-ghost text-rose-400 hover:text-rose-300">
          {t('me.signOut')}
        </button>
      </form>
    </div>
  )
}
