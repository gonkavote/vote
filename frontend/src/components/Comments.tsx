import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, Comment } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { useLogin } from '../lib/loginContext'
import { CommentNode, buildCommentTree } from './CommentNode'

export function Comments({
  ownerId,
  apiBase,
  // Backwards-compat: existing ProposalDetail call site passes proposalId.
  proposalId,
}: {
  /** Stable string used as the React Query cache key for these comments. */
  ownerId?: string
  /** Base API path; defaults to /proposal/{ownerId}. Governance passes
   *  '/governance/proposals/{pid}' so reads/writes target proposal comments. */
  apiBase?: string
  /** @deprecated use ownerId + apiBase. Kept so existing ProposalDetail keeps working. */
  proposalId?: string
}) {
  const id = ownerId ?? proposalId ?? ''
  const base = apiBase ?? `/proposal/${id}`
  const { t, i18n } = useTranslation()
  const lng = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2)
  const { data: me } = useMe()
  const loc = useLocation()
  const { openLogin } = useLogin()
  const qc = useQueryClient()
  const [body, setBody] = useState('')

  const { data: comments } = useQuery({
    queryKey: ['comments', id, lng],
    queryFn: () => api.get<Comment[]>(`${base}/comments`),
    refetchInterval: 30_000,
  })

  const tree = useMemo(() => buildCommentTree(comments || []), [comments])

  // Deep-link target: parse #comment-<uuid> from URL and walk parent chain so
  // collapsed nodes on the path can auto-expand.
  const forceExpandIds = useMemo(() => {
    const set = new Set<string>()
    const hash = loc.hash
    if (!hash.startsWith('#comment-') || !comments) return set
    const targetId = hash.slice('#comment-'.length)
    const byId = new Map(comments.map((c) => [c.id, c]))
    let cur = byId.get(targetId)
    while (cur) {
      set.add(cur.id)
      cur = cur.parent_comment_id ? byId.get(cur.parent_comment_id) : undefined
    }
    return set
  }, [comments, loc.hash])

  // Telegram notifications link to /proposal/{id}#comment-{cid} (and likewise
  // for governance). Once the list is loaded, scroll the target into view and
  // flash a ring around it so the user can find the new reply. Re-run when
  // the hash changes (e.g. user clicks two different notifications) and when
  // comments finish loading after a navigation.
  useEffect(() => {
    if (!comments || comments.length === 0) return
    const hash = loc.hash
    if (!hash.startsWith('#comment-')) return
    const el = document.getElementById(hash.slice(1))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-accent', 'rounded-lg')
    const t = window.setTimeout(() => {
      el.classList.remove('ring-2', 'ring-accent', 'rounded-lg')
    }, 2500)
    return () => window.clearTimeout(t)
  }, [comments, loc.hash])

  const post = useMutation({
    mutationFn: (text: string) =>
      api.post<Comment>(`${base}/comments`, { body: text }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['comments', id] })
    },
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (body.trim().length === 0) return
    post.mutate(body.trim())
  }

  return (
    <section className="space-y-4 min-w-0">
      <h2 className="text-xl font-bold">
        {t('comments.title')} {comments ? <span className="text-text-2 text-sm font-normal">({comments.length})</span> : null}
      </h2>

      {me ? (
        <form onSubmit={onSubmit} className="card space-y-3">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('comments.placeholder')}
            rows={3}
            className="w-full bg-bg-2 border border-border rounded-lg p-3 text-sm focus:outline-none focus:border-accent/50"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={post.isPending || body.trim().length === 0}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {post.isPending ? t('comments.posting') : t('comments.post')}
            </button>
          </div>
        </form>
      ) : (
        <div className="card text-center py-6">
          <button
            type="button"
            onClick={() => openLogin(loc.pathname)}
            className="btn-primary"
          >
            {t('comments.signInPrompt')}
          </button>
        </div>
      )}

      <div className="space-y-5">
        {tree.length === 0 && (
          <p className="text-text-2 text-sm">{t('comments.empty')}</p>
        )}
        {tree.map((c) => (
          <div key={c.id} className="card overflow-x-auto min-w-0">
            <CommentNode
              comment={c}
              depth={0}
              ownerId={id}
              apiBase={base}
              forceExpandIds={forceExpandIds}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
