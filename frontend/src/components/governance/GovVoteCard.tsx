// In-sidebar voting card for a governance proposal: pick one of four options,
// hand off to WalletConnect, fall back to a CLI command. Mirrors the look of
// HowToVote (tender voting) but uses cosmos.gov.v1beta1.MsgVote instead of a
// CosmWasm contract call.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Config } from '../../lib/api'
import { WalletConnectModal } from '../WalletConnectModal'
import type { GovVoteOption } from '../../lib/wc'

const OPTIONS: GovVoteOption[] = ['yes', 'no', 'abstain', 'no_with_veto']

const PILL_INACTIVE = 'bg-white/5 text-text-2 hover:bg-white/10'
const PILL_ACTIVE: Record<GovVoteOption, string> = {
  yes: 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40',
  no: 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/40',
  abstain: 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40',
  no_with_veto: 'bg-pink-500/20 text-pink-300 ring-1 ring-pink-400/40',
}

interface Props {
  proposalId: number
  config: Config | undefined
  /** When true, the proposal is no longer in the voting period; the card
   * still renders but submit/CLI are disabled and a hint is shown. */
  disabled?: boolean
}

export function GovVoteCard({ proposalId, config, disabled }: Props) {
  const { t } = useTranslation()
  const [option, setOption] = useState<GovVoteOption | null>(null)
  const [wcOpen, setWcOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const qc = useQueryClient()

  const cmd =
    config != null
      ? buildCli(proposalId, option ?? '<yes|no|abstain|no_with_veto>',
                 config.chain_id, config.rpc_url)
      : ''

  const copy = async () => {
    if (!cmd) return
    await navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="card">
      <h3 className="text-base font-semibold mb-1">{t('gov.vote.title')}</h3>
      <p className="text-text-2 text-sm mb-4">{t('gov.vote.description')}</p>

      <div className="grid grid-cols-2 gap-2 mb-4">
        {OPTIONS.map((o) => {
          const active = option === o
          return (
            <button
              key={o}
              type="button"
              onClick={() => setOption(o)}
              disabled={disabled}
              className={`pill text-xs font-semibold px-3 py-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                active ? PILL_ACTIVE[o] : PILL_INACTIVE
              }`}
            >
              {t(`gov.vote.${camel(o)}`)}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => setWcOpen(true)}
        disabled={!option || disabled || !config}
        className="btn-primary w-full justify-center mb-5 disabled:opacity-50 disabled:cursor-not-allowed"
        title={!option ? t('gov.vote.submitDisabled') : undefined}
      >
        {t('gov.vote.submit')}
      </button>

      <div className="border-t border-border pt-4">
        <p className="text-xs uppercase tracking-wider text-text-2 mb-2">
          {t('gov.vote.cliTitle')}
        </p>
        <pre className="bg-bg-2 border border-border rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre">
          {cmd || '…'}
        </pre>
        <button
          onClick={copy}
          disabled={!cmd || disabled}
          className="btn-ghost mt-3 w-full justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {copied ? t('gov.vote.copied') : t('gov.vote.copy')}
        </button>
      </div>

      {disabled && (
        <p className="text-xs text-text-2 mt-3 text-center">
          {t('gov.vote.notVoting')}
        </p>
      )}

      {wcOpen && option && config && (
        <WalletConnectModal
          op={{
            kind: 'gov',
            proposalId,
            option,
            optionLabel: t(`gov.vote.${camel(option)}`),
          }}
          restUrl={config.rest_url}
          onClose={() => setWcOpen(false)}
          onSuccess={() => {
            // Refresh proposal tally + votes table once the indexer & poller
            // catch up (≤60 s for both round-trips).
            qc.invalidateQueries({ queryKey: ['gov', 'proposal', proposalId] })
            qc.invalidateQueries({ queryKey: ['gov', 'votes', proposalId] })
          }}
        />
      )}
    </div>
  )
}

/** Multiline CLI command, formatted to match forgonka/vote.py exactly:
 *    ./inferenced tx gov vote {pid} {option} \
 *      --from <your-key> --keyring-backend file \
 *      --node {rpc}/  --chain-id {chain} -y
 */
function buildCli(pid: number, option: string, chainId: string, rpcUrl: string): string {
  return [
    `./inferenced tx gov vote ${pid} ${option} \\`,
    `  --from <your-key> --keyring-backend file \\`,
    `  --node ${rpcUrl}/ --chain-id ${chainId} -y`,
  ].join('\n')
}

function camel(o: GovVoteOption): string {
  // 'no_with_veto' → 'noWithVeto' so it matches the i18n key shape.
  return o === 'no_with_veto' ? 'noWithVeto' : o
}
