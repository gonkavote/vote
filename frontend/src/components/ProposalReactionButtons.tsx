import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, ProposalDetail, ReactionType } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { useLogin } from '../lib/loginContext'
import { useLocation } from 'react-router-dom'

export function ProposalReactionButtons({ proposalId, lng }: { proposalId: string; lng: string }) {
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const loc = useLocation()
  const { openLogin } = useLogin()

  const mut = useMutation({
    mutationFn: (next: ReactionType) =>
      api.post(`/proposal/${proposalId}/reactions`, { reaction: next }),
    onMutate: async (next) => {
      const key = ['proposal', proposalId, lng]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<ProposalDetail>(key)
      if (!prev) return { prev }
      let likes = prev.likes_count
      let dislikes = prev.dislikes_count
      if (prev.my_reaction === 'like') likes--
      if (prev.my_reaction === 'dislike') dislikes--
      if (next === 'like') likes++
      if (next === 'dislike') dislikes++
      qc.setQueryData<ProposalDetail>(key, {
        ...prev,
        likes_count: likes,
        dislikes_count: dislikes,
        my_reaction: next || null,
      })
      return { prev }
    },
    onError: (_e, _n, ctx) => {
      if (ctx?.prev) qc.setQueryData(['proposal', proposalId, lng], ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['proposal', proposalId, lng] })
      qc.invalidateQueries({ queryKey: ['proposals', lng] })
    },
  })

  const onClick = (next: 'like' | 'dislike') => {
    if (!me) {
      openLogin(loc.pathname + loc.search)
      return
    }
    const currentReaction = qc.getQueryData<ProposalDetail>(['proposal', proposalId, lng])?.my_reaction
    const target: ReactionType = currentReaction === next ? '' : next
    mut.mutate(target)
  }

  const current = qc.getQueryData<ProposalDetail>(['proposal', proposalId, lng])
  const myReaction = current?.my_reaction

  return (
    <div className="card space-y-3">
      <div className="text-sm font-semibold">{t('proposal.reactions.title')}</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onClick('like')}
          disabled={mut.isPending}
          className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-3 border transition-colors ${
            myReaction === 'like'
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
              : 'bg-bg-2 border-border hover:border-emerald-500/40'
          } disabled:opacity-50`}
        >
          <span className="text-xl">👍</span>
          <span className="font-semibold">{t('proposal.reactions.like')}</span>
        </button>
        <button
          type="button"
          onClick={() => onClick('dislike')}
          disabled={mut.isPending}
          className={`flex-1 flex items-center justify-center gap-2 rounded-lg py-3 border transition-colors ${
            myReaction === 'dislike'
              ? 'bg-rose-500/15 border-rose-500/40 text-rose-400'
              : 'bg-bg-2 border-border hover:border-rose-500/40'
          } disabled:opacity-50`}
        >
          <span className="text-xl">👎</span>
          <span className="font-semibold">{t('proposal.reactions.dislike')}</span>
        </button>
      </div>
      {!me && (
        <div className="text-[11px] text-text-2 text-center">
          {t('proposal.reactions.signInHint')}
        </div>
      )}
    </div>
  )
}
