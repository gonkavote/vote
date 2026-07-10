import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  open: boolean
  onClose: () => void
  /** Refs of elements whose clicks should NOT close the popover
   *  (typically the toggle button that opened it). */
  ignoreRefs?: React.RefObject<HTMLElement>[]
}

export function ReactorsPopover({ proposalId, type, open, onClose, ignoreRefs }: Props) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['reactors', proposalId, type],
    queryFn: () => api.get<Reactor[]>(`/proposal/${proposalId}/reactors?type=${type}`),
    enabled: open,
    staleTime: 0,
  })

  // Refetch fresh on every open — the user may have just toggled their own
  // reaction and expects to see themselves added/removed immediately.
  useEffect(() => {
    if (open) {
      qc.invalidateQueries({ queryKey: ['reactors', proposalId, type] })
    }
  }, [open, proposalId, type, qc])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (ref.current && ref.current.contains(target)) return
      if (ignoreRefs) {
        for (const r of ignoreRefs) {
          if (r.current && r.current.contains(target)) return
        }
      }
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('touchstart', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('touchstart', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, ignoreRefs])

  if (!open) return null

  return (
    <div
      ref={ref}
      role="dialog"
      className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-40 w-72 max-w-[90vw] rounded-lg border border-border bg-bg-card shadow-2xl p-2"
    >
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
