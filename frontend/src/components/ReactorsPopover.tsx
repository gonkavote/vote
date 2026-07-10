import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { Avatar } from './Avatar'
import { formatGNK } from '../lib/format'

interface Reactor {
  uid: string
  name: string | null
  image: string | null
  weight_ngonka: string
}

interface Props {
  proposalId: string
  type: 'like' | 'dislike'
}

export function ReactorsPopover({ proposalId, type }: Props) {
  const { t } = useTranslation()

  const { data } = useQuery({
    queryKey: ['reactors', proposalId, type],
    queryFn: () => api.get<Reactor[]>(`/proposal/${proposalId}/reactors?type=${type}`),
    staleTime: 30_000,
  })

  return (
    <div className="opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity absolute left-1/2 -translate-x-1/2 top-full mt-2 z-40 w-72 max-w-[90vw] rounded-lg border border-border bg-bg-card shadow-2xl p-2">
      {!data && (
        <p className="text-text-2 text-xs p-3 text-center">{t('proposal.reactors.loading')}</p>
      )}
      {data && data.length === 0 && (
        <p className="text-text-2 text-xs p-3 text-center">{t('proposal.reactors.empty')}</p>
      )}
      {data && data.length > 0 && (
        <ul className="max-h-64 overflow-y-auto">
          {data.map((r) => {
            const weight = BigInt(r.weight_ngonka || '0')
            return (
              <li key={r.uid}>
                <a
                  href={`/u/${r.uid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-2 rounded-md hover:bg-bg-2/70"
                >
                  <Avatar src={r.image} name={r.name} email={r.uid} size={6} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text truncate">{r.name || r.uid}</div>
                    {weight > 0n && (
                      <div className="text-[11px] text-text-2 tabular-nums">
                        {formatGNK(r.weight_ngonka, { integer: true, compactPrecision: 0 })}
                      </div>
                    )}
                  </div>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
