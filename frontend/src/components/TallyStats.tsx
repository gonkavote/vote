import { useTranslation } from 'react-i18next'
import { Tally } from '../lib/api'
import { formatCount, formatGNK } from '../lib/format'

export function TallyStats({ tally, layout = 'card' }: {
  tally: Tally
  layout?: 'card' | 'inline'
}) {
  const { t } = useTranslation()
  const isInline = layout === 'inline'
  const stats = [
    {
      label: t('tender.tally.voters'),
      value: tally.voter_count.toLocaleString(),
    },
    {
      label: isInline ? t('tender.tally.community') : t('tender.tally.communityWeight'),
      value: formatGNK(tally.community_weight_ngonka, { integer: true, noUnit: true }),
    },
    {
      label: isInline ? t('tender.tally.hosts') : t('tender.tally.hostsWeight'),
      value: formatCount(tally.hosts_weight_ngonka),
    },
    {
      label: isInline ? t('tender.tally.grant') : t('tender.tally.avgGrant'),
      // Card view (tender detail) keeps two decimals (1.26M GNK); the
      // home-page inline view drops them so cards stay scannable (1M GNK).
      value: formatGNK(tally.weighted_avg_bid_ngonka, {
        integer: true,
        compactPrecision: isInline ? 0 : 2,
      }),
    },
  ]

  if (isInline) {
    return (
      <div className="grid grid-cols-4 gap-2 text-center">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg bg-bg-2/60 border border-border py-2 px-1.5">
            <div className="text-[10px] uppercase tracking-wider text-text-2 mb-0.5 truncate">{s.label}</div>
            <div className="text-sm font-bold truncate" title={s.value}>{s.value}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div
          key={s.label}
          className="rounded-lg bg-bg-2/60 border border-border py-3 px-4 text-center"
        >
          <div className="text-[11px] uppercase tracking-wider text-text-2 mb-1 truncate">
            {s.label}
          </div>
          <div className="text-2xl font-extrabold tracking-tight truncate" title={s.value}>
            {s.value}
          </div>
        </div>
      ))}
    </div>
  )
}
