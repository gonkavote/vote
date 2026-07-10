import { useTranslation } from 'react-i18next'
import { formatGNK } from '../lib/format'

interface Props {
  likesCount: number
  dislikesCount: number
  likesWeightNgonka: string
  dislikesWeightNgonka: string
  requestedAmountUsdt: number
  requestedAmountGnk: number
  layout?: 'card' | 'inline'
}

function fmtInt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return n.toLocaleString()
}

export function ReactionStats({
  likesCount,
  dislikesCount,
  likesWeightNgonka,
  dislikesWeightNgonka,
  requestedAmountUsdt,
  requestedAmountGnk,
  layout = 'card',
}: Props) {
  const { t } = useTranslation()
  const isInline = layout === 'inline'

  const likesWeight = formatGNK(likesWeightNgonka, { integer: true, compactPrecision: isInline ? 0 : 1 })
  const dislikesWeight = formatGNK(dislikesWeightNgonka, { integer: true, compactPrecision: isInline ? 0 : 1 })

  const hasRequested = requestedAmountUsdt > 0 || requestedAmountGnk > 0
  const requestedParts: string[] = []
  if (requestedAmountUsdt > 0) requestedParts.push(`${fmtInt(requestedAmountUsdt)} USDT`)
  if (requestedAmountGnk > 0) requestedParts.push(`${fmtInt(requestedAmountGnk)} GNK`)

  if (isInline) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5">
            <span className="text-base leading-none">👍</span>
            <span className="font-bold text-emerald-400 tabular-nums">{likesCount}</span>
            <span className="text-text-2">· {likesWeight}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5">
            <span className="text-base leading-none">👎</span>
            <span className="font-bold text-rose-400 tabular-nums">{dislikesCount}</span>
            <span className="text-text-2">· {dislikesWeight}</span>
          </span>
        </div>
        {hasRequested && (
          <div className="text-[11px] text-text-2 flex items-center gap-1">
            <span className="uppercase tracking-wider">{t('proposal.reactions.requested')}:</span>
            <span className="font-semibold text-text">{requestedParts.join(' + ')}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/20 py-4 px-4">
          <div className="flex items-center gap-2 text-emerald-400 text-xs uppercase tracking-wider mb-2">
            <span className="text-base">👍</span>
            <span>{t('proposal.reactions.likes')}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-3xl font-extrabold text-emerald-400 tabular-nums">{likesCount}</div>
            <div className="text-sm text-text-2">· {likesWeight}</div>
          </div>
        </div>
        <div className="rounded-lg bg-rose-500/5 border border-rose-500/20 py-4 px-4">
          <div className="flex items-center gap-2 text-rose-400 text-xs uppercase tracking-wider mb-2">
            <span className="text-base">👎</span>
            <span>{t('proposal.reactions.dislikes')}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-3xl font-extrabold text-rose-400 tabular-nums">{dislikesCount}</div>
            <div className="text-sm text-text-2">· {dislikesWeight}</div>
          </div>
        </div>
      </div>
      {hasRequested && (
        <div className="rounded-lg bg-bg-2/60 border border-border py-3 px-4">
          <div className="text-[11px] uppercase tracking-wider text-text-2 mb-1">
            {t('proposal.reactions.requestedAmount')}
          </div>
          <div className="text-xl font-bold">{requestedParts.join(' + ')}</div>
        </div>
      )}
    </div>
  )
}
