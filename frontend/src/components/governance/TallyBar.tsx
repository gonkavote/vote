// Tally visualisation. Two variants:
// - 'compact' (default) — a single 4-section horizontal bar; used in the
//   Governance list rows.
// - 'large' — one row per option (Yes / No / No With Veto / Abstain) with
//   its own bar, raw amount, and percent. Used in the proposal detail Tally
//   card.
//
// All amounts are decimal strings because chain weights don't fit in
// JavaScript numbers; we use BigInt for the totals.
import { useTranslation } from 'react-i18next'
import { compactBig } from '../../lib/format'

interface Props {
  yes: string
  no: string
  veto: string
  abstain: string
  variant?: 'compact' | 'large'
  className?: string
}

const COLORS = {
  yes: 'bg-emerald-400',
  no: 'bg-rose-400',
  veto: 'bg-pink-400',
  abstain: 'bg-amber-400',
}

export function TallyBar({ yes, no, veto, abstain, variant = 'compact', className }: Props) {
  const total = bi(yes) + bi(no) + bi(veto) + bi(abstain)
  const pct = (n: bigint) => (total > 0n ? Number((n * 10000n) / total) / 100 : 0)

  if (variant === 'large') {
    return (
      <div className={`space-y-3 ${className || ''}`}>
        <Row labelKey="governance.tally.yes" color="yes" amount={yes} pct={pct(bi(yes))} />
        <Row labelKey="governance.tally.no" color="no" amount={no} pct={pct(bi(no))} />
        <Row labelKey="governance.tally.veto" color="veto" amount={veto} pct={pct(bi(veto))} />
        <Row labelKey="governance.tally.abstain" color="abstain" amount={abstain} pct={pct(bi(abstain))} />
      </div>
    )
  }

  // Compact stacked bar. Each segment shows its own percentage when the
  // segment is wide enough to fit the label without clipping.
  if (total === 0n) {
    return <div className={`h-3 rounded-full bg-white/5 ${className || ''}`} />
  }
  const segments = [
    { key: 'yes', value: pct(bi(yes)), cls: COLORS.yes },
    { key: 'no', value: pct(bi(no)), cls: COLORS.no },
    { key: 'veto', value: pct(bi(veto)), cls: COLORS.veto },
    { key: 'abstain', value: pct(bi(abstain)), cls: COLORS.abstain },
  ].filter((s) => s.value > 0)
  // Hide the inline label below this width — anything narrower clips.
  const MIN_LABEL_PCT = 12
  return (
    <div className={`flex h-3 rounded-full overflow-hidden bg-white/5 ${className || ''}`}>
      {segments.map((s) => (
        <div
          key={s.key}
          className={`${s.cls} flex items-center justify-center text-[10px] font-semibold text-white leading-none [text-shadow:0_0_2px_rgba(0,0,0,0.85),0_1px_1px_rgba(0,0,0,0.5)]`}
          style={{ width: `${s.value}%` }}
        >
          {s.value >= MIN_LABEL_PCT && `${s.value.toFixed(1)}%`}
        </div>
      ))}
    </div>
  )
}

function Row({
  labelKey, color, amount, pct,
}: {
  labelKey: string
  color: keyof typeof COLORS
  amount: string
  pct: number
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="flex justify-between items-baseline text-sm mb-1">
        <span className="font-medium capitalize">{t(labelKey)}</span>
        <span className="text-text-2 tabular-nums">
          {shortNum(amount)}{' '}
          <span className="text-text-2/60 ml-1">({pct.toFixed(2)}%)</span>
        </span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${COLORS[color]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function bi(s: string | number | undefined): bigint {
  if (s === undefined || s === null || s === '') return 0n
  try {
    return BigInt(typeof s === 'number' ? Math.floor(s) : s)
  } catch {
    return 0n
  }
}

function shortNum(s: string | number): string {
  let n: bigint
  try { n = BigInt(typeof s === 'number' ? Math.floor(s) : s) } catch { return String(s) }
  return compactBig(n)
}
