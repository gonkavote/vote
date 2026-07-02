// Modal that drives a single WalletConnect signing flow:
//   pairing → wallet approves → fetch account → cosmos_signDirect → broadcast.
// Renders the QR + copy/deeplink controls until the wallet pairs, then a
// progress state, then a success or error state.
//
// Two flavours via the discriminated `op` prop:
//   • op.kind = 'proposal' — CosmWasm MsgExecuteContract on the vote contract.
//   • op.kind = 'gov'    — Cosmos governance MsgVote on a proposal.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import {
  castVote,
  castGovVote,
  connect,
  disconnect,
  getAccount,
  gonkaWalletDeepLink,
  GONKA_WALLET_HOME,
  type CosmosAccount,
  type GovVoteOption,
} from '../lib/wc'
import { useAppConfig, useTrackerLinks } from '../lib/useAppConfig'
import type { SessionTypes } from '@walletconnect/types'

export type WalletConnectOp =
  | {
      kind: 'proposal'
      contractAddress: string
      proposalId: string
      amountNgonka: string
      amountGnkLabel: string
    }
  | {
      kind: 'gov'
      proposalId: number
      option: GovVoteOption
      optionLabel: string
    }

interface Props {
  op: WalletConnectOp
  restUrl: string
  onClose: () => void
  onSuccess: (txhash: string) => void
}

type Stage =
  | { kind: 'connecting' }
  | { kind: 'awaiting'; uri: string; qr: string }
  | { kind: 'signing'; account: CosmosAccount }
  | { kind: 'broadcasting' }
  | { kind: 'success'; txhash: string }
  | { kind: 'error'; message: string }

export function WalletConnectModal({ op, restUrl, onClose, onSuccess }: Props) {
  const { t } = useTranslation()
  const { data: cfg } = useAppConfig()
  const trackerLinks = useTrackerLinks(cfg)
  const [stage, setStage] = useState<Stage>({ kind: 'connecting' })
  const [copied, setCopied] = useState(false)
  const sessionRef = useRef<SessionTypes.Struct | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    let session: SessionTypes.Struct | null = null

    ;(async () => {
      try {
        const { uri, approval } = await connect()
        if (cancelledRef.current) return
        const qr = await QRCode.toDataURL(uri, {
          margin: 1,
          width: 320,
          color: { dark: '#f0f0f5', light: '#0e0e16' },
        })
        setStage({ kind: 'awaiting', uri, qr })

        session = await approval()
        if (cancelledRef.current) return
        sessionRef.current = session

        const account = await getAccount(session)
        if (cancelledRef.current) return
        setStage({ kind: 'signing', account })

        const result = op.kind === 'proposal'
          ? await castVote(session, account, {
              contractAddress: op.contractAddress,
              proposalId: op.proposalId,
              amountNgonka: op.amountNgonka,
              restUrl,
            })
          : await castGovVote(session, account, {
              proposalId: op.proposalId,
              option: op.option,
              restUrl,
            })
        if (cancelledRef.current) return

        if (result.code !== 0) {
          setStage({
            kind: 'error',
            message: result.raw_log || `Transaction failed (code ${result.code})`,
          })
          return
        }
        setStage({ kind: 'success', txhash: result.txhash })
        onSuccess(result.txhash)
      } catch (e) {
        if (cancelledRef.current) return
        setStage({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    })()

    return () => {
      cancelledRef.current = true
      const s = sessionRef.current
      if (s) {
        // Best-effort: tear down the WC session so the wallet doesn't hang
        // on a stale pairing if the user closes the modal mid-flow.
        disconnect(s.topic).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyUri = async () => {
    if (stage.kind !== 'awaiting') return
    await navigator.clipboard.writeText(stage.uri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-2xl w-full max-w-md p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label={t('wc.close')}
          className="absolute top-3 right-3 text-text-2 hover:text-text text-xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5"
        >
          ×
        </button>

        <h2 className="text-lg font-semibold mb-1">{t('wc.title')}</h2>
        <p className="text-text-2 text-sm mb-5">
          {op.kind === 'proposal' ? (
            <>
              {t('wc.bid')}{' '}
              <span className="text-text font-semibold">{op.amountGnkLabel}</span>
            </>
          ) : (
            <>
              {t('wc.govVote', { option: op.optionLabel, id: op.proposalId })}
            </>
          )}
        </p>

        {stage.kind === 'connecting' && (
          <div className="text-center py-12">
            <Spinner />
            <p className="text-text-2 text-sm mt-4">{t('wc.preparing')}</p>
          </div>
        )}

        {stage.kind === 'awaiting' && (
          <div className="space-y-4">
            <div className="flex justify-center">
              <img
                src={stage.qr}
                alt="WalletConnect pairing QR"
                className="w-72 h-72 rounded-xl border border-border"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyUri}
                className="btn-ghost flex-1 justify-center text-sm"
              >
                {copied ? t('wc.copied') : t('wc.copyLink')}
              </button>
              <a
                href={gonkaWalletDeepLink(stage.uri)}
                className="btn-primary flex-1 justify-center text-sm"
              >
                {t('wc.openInWallet')}
              </a>
            </div>
            <p className="text-text-2 text-xs text-center">
              <a
                href={GONKA_WALLET_HOME}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {t('wc.noWallet')}
              </a>
            </p>
          </div>
        )}

        {stage.kind === 'signing' && (
          <div className="text-center py-8">
            <Spinner />
            <p className="text-text-2 text-sm mt-4">
              {t('wc.confirm')}
            </p>
            <p className="text-text-2 text-[11px] font-mono mt-2 break-all">
              {stage.account.address}
            </p>
          </div>
        )}

        {stage.kind === 'broadcasting' && (
          <div className="text-center py-12">
            <Spinner />
            <p className="text-text-2 text-sm mt-4">{t('wc.broadcasting')}</p>
          </div>
        )}

        {stage.kind === 'success' && (
          <div className="text-center py-6">
            <div className="text-4xl mb-2">✓</div>
            <p className="text-emerald-400 font-semibold mb-3">{t('wc.submitted')}</p>
            {trackerLinks.enabled ? (
              <a
                href={trackerLinks.tx(stage.txhash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline font-mono text-xs break-all block mb-4"
              >
                {stage.txhash}
              </a>
            ) : (
              <span className="font-mono text-xs break-all block mb-4 text-text-2">
                {stage.txhash}
              </span>
            )}
            <button onClick={onClose} className="btn-primary">
              {t('wc.done')}
            </button>
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="py-4">
            <div className="text-rose-400 font-semibold mb-2">{t('wc.couldNotVote')}</div>
            <p className="text-text-2 text-sm break-words">{stage.message}</p>
            <div className="mt-4 flex justify-end">
              <button onClick={onClose} className="btn-ghost">{t('wc.close')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="inline-block w-8 h-8 border-2 border-border border-t-accent rounded-full animate-spin" />
  )
}
