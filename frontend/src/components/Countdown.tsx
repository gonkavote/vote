import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCountdown, formatCountdownPrecise, formatDateTime } from '../lib/format'

/**
 * Live countdown to a deadline. Re-renders periodically so the value
 * stays current without a page refresh.
 *
 * `intervalMs` controls tick rate — 1s for the big hero counter on the
 * proposal page, 30s for the small pills sprinkled across cards.
 */
function useCountdown(
  iso: string | null | undefined,
  intervalMs = 30_000,
  precise = false,
): string | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!iso) return
    const t = setInterval(() => setTick((n) => n + 1), intervalMs)
    return () => clearInterval(t)
  }, [iso, intervalMs])
  return precise ? formatCountdownPrecise(iso) : formatCountdown(iso)
}

export function CountdownPill({
  closesAt,
  status,
  compact = false,
}: {
  closesAt: string | null | undefined
  status: 'open' | 'closed'
  /** When true, render only the bare value (e.g. "89d") with no surrounding
   * "X left / осталось X" text. Used on dense surfaces like the index cards. */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const text = useCountdown(closesAt)
  if (status === 'closed') return null
  if (!closesAt) {
    return <span className="pill bg-white/5 text-text-2">{t('countdown.noDeadline')}</span>
  }
  if (text === 'Closed') {
    return <span className="pill bg-rose-500/15 text-rose-400">{t('countdown.expired')}</span>
  }
  return (
    <span
      className="pill bg-accent/10 text-accent-2"
      title={formatDateTime(closesAt)}
    >
      ⏳ {compact ? text : t('countdown.left', { value: text })}
    </span>
  )
}

export function CountdownBig({
  closesAt,
  status,
}: {
  closesAt: string | null | undefined
  status: 'open' | 'closed'
}) {
  const { t } = useTranslation()
  const text = useCountdown(closesAt, 1000, true)
  if (!closesAt) return null
  if (status === 'closed') {
    return <div className="text-text-2 text-xs">{t('countdown.closed')}</div>
  }
  const expired = text === 'Closed'
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-text-2">
        {expired ? t('countdown.status') : t('countdown.closesIn')}
      </div>
      <div
        className={`text-2xl font-extrabold tracking-tight tabular-nums ${
          expired ? 'text-rose-400' : 'text-accent-2'
        }`}
        title={formatDateTime(closesAt)}
      >
        {expired ? t('countdown.expired') : text}
      </div>
    </div>
  )
}
