import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { api, LinkedWallet } from '../lib/api'
import { useAppConfig } from '../lib/useAppConfig'
import { formatGNK, formatRelative } from '../lib/format'
import { WalletConnectModal, type WalletConnectOp } from './WalletConnectModal'

export function LinkedWallets({ accountUid }: { accountUid: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cfg } = useAppConfig()
  const [wcOp, setWcOp] = useState<WalletConnectOp | null>(null)
  const [copied, setCopied] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const refresh = useMutation({
    mutationFn: () => api.post<{ wallets: number }>('/wallets/refresh', {}),
    onSuccess: () => {
      setRefreshError(null)
      qc.invalidateQueries({ queryKey: ['wallets', 'mine'] })
    },
    onError: (err: any) => {
      const status = err?.status
      if (status === 429) {
        setRefreshError(t('me.wallets.refreshRateLimited'))
      } else {
        setRefreshError(t('me.wallets.refreshFailed'))
      }
    },
  })

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
  const hasContract = !!cfg?.link_contract_address

  const cliCmd = hasContract
    ? `./inferenced tx wasm execute ${cfg!.link_contract_address} '{"link_account":{"account_uid":"${accountUid}"}}' --from <your-key> --chain-id ${cfg!.chain_id} --keyring-backend file --node ${cfg!.rpc_url}/ -y`
    : ''

  const cliPretty = hasContract
    ? `./inferenced tx wasm execute ${cfg!.link_contract_address} \\
  '{"link_account":{"account_uid":"${accountUid}"}}' \\
  --from <your-key> --chain-id ${cfg!.chain_id} \\
  --keyring-backend file \\
  --node ${cfg!.rpc_url}/ -y`
    : ''

  const copyCli = async () => {
    if (!cliCmd) return
    await navigator.clipboard.writeText(cliCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="card space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">{t('me.wallets.title')}</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-2">
            {t('me.wallets.totalWeight')}: <span className="font-bold text-text">{formatGNK(totalWeight.toString(), { integer: true, compactPrecision: 1 })}</span>
          </span>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="btn-ghost text-xs px-2 py-1 disabled:opacity-50"
            title={t('me.wallets.refreshHint')}
          >
            {refresh.isPending ? t('me.wallets.refreshing') : t('me.wallets.refresh')}
          </button>
        </div>
      </div>
      <p className="text-text-2 text-xs leading-relaxed">
        {t('me.wallets.hint')}
      </p>
      {refreshError && <p className="text-rose-400 text-xs">{refreshError}</p>}

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
      ) : !hasContract ? (
        <p className="text-xs text-text-2">{t('me.wallets.notConfigured')}</p>
      ) : null}

      {hasContract && (
        <div className="border-t border-border pt-4">
          <p className="text-xs uppercase tracking-wider text-text-2 mb-1">
            {t('me.wallets.cliTitle')}
          </p>
          <p className="text-text-2 text-xs mb-2">
            <Trans i18nKey="me.wallets.cliHint" components={{ code: <code className="font-mono bg-bg-2 px-1 rounded" /> }} />
          </p>
          <pre className="bg-bg-2 border border-border rounded-lg p-3 text-xs overflow-x-auto whitespace-pre">
            {cliPretty}
          </pre>
          <button
            type="button"
            onClick={copyCli}
            className="btn-ghost mt-3 w-full justify-center"
          >
            {copied ? t('me.wallets.copied') : t('me.wallets.copy')}
          </button>
        </div>
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
