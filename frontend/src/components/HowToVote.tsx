import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Config } from '../lib/api'
import { gnkToNgonka, NGONKA_PER_GNK } from '../lib/format'
import i18n from '../i18n'
import { WalletConnectModal } from './WalletConnectModal'

const FALLBACK_DEFAULT_GNK = '10000'

/** Round ngonka string down to whole GNK; "" / "0" → fallback. */
function defaultGnkFromAvg(avgNgonka: string | undefined): string {
  if (!avgNgonka) return FALLBACK_DEFAULT_GNK
  let amount: bigint
  try {
    amount = BigInt(avgNgonka)
  } catch {
    return FALLBACK_DEFAULT_GNK
  }
  if (amount <= 0n) return FALLBACK_DEFAULT_GNK
  const wholeGnk = amount / NGONKA_PER_GNK
  return wholeGnk > 0n ? wholeGnk.toString() : FALLBACK_DEFAULT_GNK
}

export function HowToVote({ tenderId, config, disabled, defaultBidNgonka }: {
  tenderId: string
  config: Config | undefined
  disabled?: boolean
  defaultBidNgonka?: string
}) {
  const { t } = useTranslation()
  // gnk holds the raw digits-only string (e.g. "10000"). The input shows it
  // formatted with locale separators ("10,000"); on each keystroke we strip
  // anything non-digit before storing.
  // Initial value: current weighted-average bid (rounded down to whole GNK)
  // when there's at least one prior voter; otherwise 10,000.
  const [gnk, setGnk] = useState<string>(() => defaultGnkFromAvg(defaultBidNgonka))

  // BigInt-safe locale formatting: avoids losing precision for huge bids.
  const formattedGnk = gnk ? BigInt(gnk).toLocaleString(i18n.language) : ''
  const [copied, setCopied] = useState(false)
  const [wcOpen, setWcOpen] = useState(false)
  const qc = useQueryClient()

  if (!config?.contract_address) {
    return <p className="text-text-2 text-sm">{t('cast.notConfigured')}</p>
  }

  const valid = /^\d+$/.test(gnk) && BigInt(gnk || '0') > 0n
  const ngonka = valid ? gnkToNgonka(gnk) : '1000000000'

  // Single-line form for clipboard (paste-and-run in any shell, no zsh
  // brace-expansion gotchas).
  const cmd = `./inferenced tx wasm execute ${config.contract_address} '{"vote":{"tender_id":"${tenderId}","amount":"${ngonka}"}}' --from <your-key> --chain-id ${config.chain_id} --keyring-backend file --node ${config.rpc_url}/ -y`

  // Pretty multiline form for display only — easier to read in the card.
  const cmdPretty = `./inferenced tx wasm execute ${config.contract_address} \\
  '{"vote":{"tender_id":"${tenderId}","amount":"${ngonka}"}}' \\
  --from <your-key> --chain-id ${config.chain_id} \\
  --keyring-backend file \\
  --node ${config.rpc_url}/ -y`

  const copy = async () => {
    await navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="card">
      <h3 className="text-base font-semibold mb-1">{t('cast.title')}</h3>
      <p className="text-text-2 text-sm mb-4">
        <Trans i18nKey="cast.description" components={{ strong: <strong className="text-text" /> }} />
      </p>

      <label className="block mb-4">
        <span className="text-xs uppercase tracking-wider text-text-2">{t('cast.yourBid')}</span>
        <div className="mt-1 flex items-stretch gap-2">
          <input
            inputMode="numeric"
            value={formattedGnk}
            onChange={(e) => setGnk(e.target.value.replace(/\D/g, ''))}
            disabled={disabled}
            className="flex-1 bg-bg-2 border border-border rounded-lg p-3 text-base font-semibold tabular-nums focus:outline-none focus:border-accent/50 disabled:opacity-50"
            placeholder="10,000"
          />
          <span className="inline-flex items-center px-4 rounded-lg bg-bg-2 border border-border text-text-2 text-sm font-semibold">
            GNK
          </span>
        </div>
        {!valid && (
          <span className="text-xs text-rose-400 mt-1 block">
            {t('cast.invalid')}
          </span>
        )}
      </label>

      <button
        onClick={() => setWcOpen(true)}
        disabled={!valid || disabled}
        className="btn-primary w-full justify-center mb-5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('cast.voteWc')}
      </button>

      <div className="border-t border-border pt-4">
        <p className="text-xs uppercase tracking-wider text-text-2 mb-2">
          {t('cast.cliTitle')}
        </p>
        <pre className="bg-bg-2 border border-border rounded-lg p-3 text-xs overflow-x-auto whitespace-pre">
          {cmdPretty}
        </pre>
        <button
          onClick={copy}
          disabled={!valid || disabled}
          className="btn-ghost mt-3 w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {copied ? t('cast.copied') : t('cast.copy')}
        </button>
      </div>

      {wcOpen && (
        <WalletConnectModal
          op={{
            kind: 'tender',
            contractAddress: config.contract_address,
            tenderId,
            amountNgonka: ngonka,
            amountGnkLabel: `${formattedGnk} GNK`,
          }}
          restUrl={config.rest_url}
          onClose={() => setWcOpen(false)}
          onSuccess={() => {
            // Invalidate so the voters list refetches once the indexer picks
            // up the on-chain vote (next snapshot tick — within 60s).
            qc.invalidateQueries({ queryKey: ['tender', tenderId] })
          }}
        />
      )}
    </div>
  )
}
