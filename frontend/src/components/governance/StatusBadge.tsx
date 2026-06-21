// Governance proposal status pill. Re-uses our `.pill` utility, picks colour
// by short status string (matches the values normalize_status returns).

import { useTranslation } from 'react-i18next'
import type { GovStatus } from '../../lib/api'

const STATUS_CLS: Record<GovStatus, string> = {
  voting: 'bg-accent/15 text-accent-2',
  deposit: 'bg-amber-500/15 text-amber-400',
  passed: 'bg-emerald-500/15 text-emerald-400',
  rejected: 'bg-rose-500/15 text-rose-400',
  failed: 'bg-rose-500/15 text-rose-400',
}

export function StatusBadge({ status, className }: { status: GovStatus; className?: string }) {
  const { t } = useTranslation()
  const cls = STATUS_CLS[status] || 'bg-white/5 text-text-2'
  return (
    <span className={`pill flex-shrink-0 ${cls} ${className || ''}`}>
      {t(`governance.status.${status}`, { defaultValue: status })}
    </span>
  )
}
