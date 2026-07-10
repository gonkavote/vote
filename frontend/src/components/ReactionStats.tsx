import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatGNK } from '../lib/format'
import { ReactorsPopover } from './ReactorsPopover'

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
  /** If provided, hovering a like/dislike tile shows a popover listing users
   *  who reacted with that type on the given proposal. */
  proposalIdForReactors?: string
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
  proposalIdForReactors,
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <ReactionTile
          kind="like"
          count={likesCount}
          weight={likesWeight}
          myReaction={myReaction}
          onReact={onReact}
          reactDisabled={reactDisabled}
          label={t('proposal.reactions.likes')}
          proposalIdForReactors={proposalIdForReactors}
        />
        <ReactionTile
          kind="dislike"
          count={dislikesCount}
          weight={dislikesWeight}
          myReaction={myReaction}
          onReact={onReact}
          reactDisabled={reactDisabled}
          label={t('proposal.reactions.dislikes')}
          proposalIdForReactors={proposalIdForReactors}
        />
      </div>
    </div>
  )
}

function ReactionTile({
  kind, count, weight, myReaction, onReact, reactDisabled,
  label, proposalIdForReactors,
}: {
  kind: 'like' | 'dislike'
  count: number
  weight: string
  myReaction?: 'like' | 'dislike' | null
  onReact?: (k: 'like' | 'dislike') => void
  reactDisabled?: boolean
  label: string
  proposalIdForReactors?: string
}) {
  const isLike = kind === 'like'
  const emoji = isLike ? '👍' : '👎'
  const active = myReaction === kind
  const bg = isLike ? 'bg-emerald-500/5' : 'bg-rose-500/5'
  const border = isLike ? 'border-emerald-500/20' : 'border-rose-500/20'
  const text = isLike ? 'text-emerald-400' : 'text-rose-400'
  const hoverBg = onReact ? (isLike ? 'hover:bg-emerald-500/15' : 'hover:bg-rose-500/15') : ''
  const ring = active ? (isLike ? 'ring-2 ring-emerald-400' : 'ring-2 ring-rose-400') : ''

  const Tag = onReact ? 'button' : 'div'
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const canShowReactors = !!proposalIdForReactors && count > 0
  return (
    <div className="relative">
      <Tag
        type={onReact ? 'button' : undefined}
        disabled={onReact ? reactDisabled : undefined}
        onClick={onReact ? () => onReact(kind) : undefined}
        className={`w-full rounded-lg ${bg} border ${border} py-4 px-4 text-left transition ${hoverBg} ${ring} ${onReact && reactDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <div className={`flex items-center gap-2 ${text} text-xs uppercase tracking-wider mb-2`}>
          <span className="text-base">{emoji}</span>
          <span>{label}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <div className={`text-3xl font-extrabold ${text} tabular-nums`}>{count}</div>
          <div className="text-sm text-text-2">· {weight}</div>
        </div>
      </Tag>
      {canShowReactors && (
        <>
          <button
            ref={toggleRef}
            type="button"
            aria-label="Show reactors"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation()
              setOpen((v) => !v)
            }}
            className={`absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md border border-border ${text} bg-bg-card/80 hover:bg-bg-2 transition`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          <ReactorsPopover
            proposalId={proposalIdForReactors!}
            type={kind}
            open={open}
            onClose={() => setOpen(false)}
            ignoreRefs={[toggleRef]}
          />
        </>
      )}
    </div>
  )
}
