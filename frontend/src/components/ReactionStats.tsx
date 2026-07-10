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
  /** When set, renders 👍/👎 as clickable buttons that toggle the current
   *  user's reaction. Only used in the detail-page card layout. */
  onReact?: (kind: 'like' | 'dislike') => void
  myReaction?: 'like' | 'dislike' | null
  reactDisabled?: boolean
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
  onReact,
  myReaction,
  reactDisabled,
}: Props) {
  const { t } = useTranslation()
  const isInline = layout === 'inline'

  const likesWeight = formatGNK(likesWeightNgonka, { integer: true, compactPrecision: 0 })
  const dislikesWeight = formatGNK(dislikesWeightNgonka, { integer: true, compactPrecision: 0 })

  const hasRequested = requestedAmountUsdt > 0 || requestedAmountGnk > 0
  const requestedParts: string[] = []
  if (requestedAmountUsdt > 0) requestedParts.push(`${fmtInt(requestedAmountUsdt)} USDT`)
  if (requestedAmountGnk > 0) requestedParts.push(`${fmtInt(requestedAmountGnk)} GNK`)

  if (isInline) {
    return (
      <div className="space-y-3">
        {hasRequested && (
          <div className="rounded-lg bg-bg-2/60 border border-border px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-text-2 mb-0.5">
              {t('proposal.reactions.requested')}
            </div>
            <div className="text-base font-bold text-text">{requestedParts.join(' + ')}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center justify-center gap-2 rounded-lg border border-emerald-500/40 py-2">
            <span className="text-lg leading-none">👍</span>
            <span className="font-bold text-emerald-400 tabular-nums text-base">{likesCount}</span>
            <span className="text-text-2 text-xs">· {likesWeight}</span>
          </div>
          <div className="flex items-center justify-center gap-2 rounded-lg border border-rose-500/40 py-2">
            <span className="text-lg leading-none">👎</span>
            <span className="font-bold text-rose-400 tabular-nums text-base">{dislikesCount}</span>
            <span className="text-text-2 text-xs">· {dislikesWeight}</span>
          </div>
        </div>
      </div>
    )
  }

  const isLikeActive = myReaction === 'like'
  const isDislikeActive = myReaction === 'dislike'
  const Tag = onReact ? 'button' : 'div'
  const likeExtra = onReact
    ? `hover:bg-emerald-500/15 transition ${isLikeActive ? 'ring-2 ring-emerald-400' : ''}`
    : ''
  const dislikeExtra = onReact
    ? `hover:bg-rose-500/15 transition ${isDislikeActive ? 'ring-2 ring-rose-400' : ''}`
    : ''

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Tag
          type={onReact ? 'button' : undefined}
          disabled={onReact ? reactDisabled : undefined}
          onClick={onReact ? () => onReact('like') : undefined}
          className={`rounded-lg bg-emerald-500/5 border border-emerald-500/20 py-4 px-4 text-left ${likeExtra} ${onReact && reactDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center gap-2 text-emerald-400 text-xs uppercase tracking-wider mb-2">
            <span className="text-base">👍</span>
            <span>{t('proposal.reactions.likes')}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-3xl font-extrabold text-emerald-400 tabular-nums">{likesCount}</div>
            <div className="text-sm text-text-2">· {likesWeight}</div>
          </div>
        </Tag>
        <Tag
          type={onReact ? 'button' : undefined}
          disabled={onReact ? reactDisabled : undefined}
          onClick={onReact ? () => onReact('dislike') : undefined}
          className={`rounded-lg bg-rose-500/5 border border-rose-500/20 py-4 px-4 text-left ${dislikeExtra} ${onReact && reactDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="flex items-center gap-2 text-rose-400 text-xs uppercase tracking-wider mb-2">
            <span className="text-base">👎</span>
            <span>{t('proposal.reactions.dislikes')}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <div className="text-3xl font-extrabold text-rose-400 tabular-nums">{dislikesCount}</div>
            <div className="text-sm text-text-2">· {dislikesWeight}</div>
          </div>
        </Tag>
      </div>
    </div>
  )
}
