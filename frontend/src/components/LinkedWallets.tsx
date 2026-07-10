import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, LinkedWallet } from '../lib/api'
import { useAppConfig } from '../lib/useAppConfig'
import { formatGNK, formatRelative } from '../lib/format'
import { WalletConnectModal, type WalletConnectOp } from './WalletConnectModal'

export function LinkedWallets({ accountUid }: { accountUid: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cfg } = useAppConfig()
  const [wcOp, setWcOp] = useState<WalletConnectOp | null>(null)

  const { data: wallets, isLoading } = useQuery({
    queryKey: ['wallets', 'mine'],
    queryFn: () => api.get<LinkedWallet[]>('/wallets/mine'),
    refetchInterval: 30_000,
  })

  const totalWeight = (wallets || []).reduce(
    (acc, w) => acc + BigInt(w.balance_ngonka || '0'),
    0n,
  )

  const canLink = !!cfg?.link_contract_address && !!cfg?.wc_project_id

  return (
    <section className="card space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">{t('me.wallets.title')}</h2>
        <span className="text-xs text-text-2">
          {t('me.wallets.totalWeight')}: <span className="font-bold text-text">{formatGNK(totalWeight.toString(), { integer: true, compactPrecision: 1 })}</span>
        </span>
      </div>
      <p className="text-text-2 text-xs leading-relaxed">
        {t('me.wallets.hint')}
      </p>

      {isLoading ? (
        <p className="text-text-2 text-sm">{t('me.wallets.loading')}</p>
      ) : (wallets || []).length === 0 ? (
        <p className="text-text-2 text-sm">{t('me.wallets.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {wallets!.map((w) => (
            <li
              key={w.wallet}
              className="flex items-center justify-between gap-3 p-3 rounded-lg bg-bg-2/60 border border-border"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs break-all">{w.wallet}</div>
                <div className="text-[11px] text-text-2 mt-1">
                  {t('me.wallets.balance')}: <span className="font-semibold text-text">
                    {formatGNK(w.balance_ngonka, { integer: true, compactPrecision: 1 })}
                  </span>
                  {w.balance_refreshed_at && (
                    <> · {t('me.wallets.refreshed', { when: formatRelative(w.balance_refreshed_at) })}</>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canLink ? (
        <button
          type="button"
          onClick={() =>
            setWcOp({
              kind: 'link_account',
              accountUid,
              contractAddress: cfg!.link_contract_address,
            })
          }
          className="btn-primary w-full"
        >
          {t('me.wallets.linkNew')}
        </button>
      ) : (
        <p className="text-xs text-text-2">{t('me.wallets.notConfigured')}</p>
      )}

      {wcOp && (
        <WalletConnectModal
          op={wcOp}
          onClose={() => {
            setWcOp(null)
            qc.invalidateQueries({ queryKey: ['wallets', 'mine'] })
          }}
        />
      )}
    </section>
  )
}
