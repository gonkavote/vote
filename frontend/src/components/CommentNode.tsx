import { FormEvent, ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, Comment, ReactionType } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { Avatar } from './Avatar'
import { TranslatedText, TranslationToggle, type TranslationMode } from './TranslatedText'
import { linkify } from '../lib/linkify'
import { formatRelative } from '../lib/format'

const MAX_INDENT_LEVEL = 3
const INDENT_PX = 24

export interface CommentTreeNode extends Comment {
  children: CommentTreeNode[]
}

export function CommentNode({
  comment,
  depth,
  ownerId,
  apiBase,
  // legacy alias
  proposalId,
}: {
  comment: CommentTreeNode
  depth: number
  /** Cache key — same value passed by parent <Comments>. */
  ownerId?: string
  /** API base for replies, e.g. '/proposal/abc' or '/governance/proposals/42'. */
  apiBase?: string
  /** @deprecated kept for the existing ProposalDetail call site. */
  proposalId?: string
}) {
  const id = ownerId ?? proposalId ?? ''
  const base = apiBase ?? `/proposal/${id}`
  const { t } = useTranslation()
  const { data: me } = useMe()
  const qc = useQueryClient()
  const [showReply, setShowReply] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [translationMode, setTranslationMode] = useState<TranslationMode>('translated')
  const indent = Math.min(depth, MAX_INDENT_LEVEL) * INDENT_PX

  const reactionMut = useMutation({
    mutationFn: (next: ReactionType) =>
      api.post(`/comments/${comment.id}/reactions`, { reaction: next }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['comments', id] })
      const prev = qc.getQueryData<Comment[]>(['comments', id])
      if (!prev) return { prev }
      qc.setQueryData<Comment[]>(['comments', id], (old) =>
        (old || []).map((c) => {
          if (c.id !== comment.id) return c
          let likes = c.likes
          let dislikes = c.dislikes
          if (c.my_reaction === 'like') likes--
          if (c.my_reaction === 'dislike') dislikes--
          if (next === 'like') likes++
          if (next === 'dislike') dislikes++
          return { ...c, likes, dislikes, my_reaction: next || null }
        }),
      )
      return { prev }
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev) qc.setQueryData(['comments', id], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['comments', id] }),
  })

  const replyMut = useMutation({
    mutationFn: (body: string) =>
      api.post<Comment>(`${base}/comments`, {
        body,
        parent_comment_id: comment.id,
      }),
    onSuccess: () => {
      setReplyBody('')
      setShowReply(false)
      qc.invalidateQueries({ queryKey: ['comments', id] })
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/comments/${comment.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', id] }),
  })

  const onDelete = () => {
    if (window.confirm(t('comments.deleteConfirm'))) deleteMut.mutate()
  }

  const onReaction = (next: 'like' | 'dislike') => {
    if (!me) return
    const target: ReactionType = comment.my_reaction === next ? '' : next
    reactionMut.mutate(target)
  }

  const onReplySubmit = (e: FormEvent) => {
    e.preventDefault()
    if (replyBody.trim().length === 0) return
    replyMut.mutate(replyBody.trim())
  }

  const profileHref = comment.author_uid ? `/u/${comment.author_uid}` : null

  return (
    <div
      id={`comment-${comment.id}`}
      style={{ marginLeft: indent }}
      className="space-y-2 min-w-[260px] scroll-mt-20"
    >
      <div className="flex gap-3">
        <ConditionalLink to={profileHref} className="flex-shrink-0">
          <Avatar
            src={comment.author_image}
            name={comment.author_name}
            email={comment.author_uid}
            size={8}
          />
        </ConditionalLink>
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-baseline gap-2 flex-wrap">
            <ConditionalLink
              to={profileHref}
              className="font-semibold text-sm hover:text-accent truncate"
            >
              {comment.author_name || comment.author_uid || t('comments.unknown')}
            </ConditionalLink>
            <span className="text-xs text-text-2">
              · {formatRelative(comment.created_at)}
            </span>
            <TranslationToggle
              isTranslated={comment.is_translated}
              status={comment.translation_status}
              mode={translationMode}
              onChange={setTranslationMode}
              sourceLang={comment.source_lang}
            />
          </div>
          <TranslatedText
            as="p"
            className="text-sm whitespace-pre-wrap leading-relaxed mt-1 break-words"
            translated={comment.body}
            original={comment.original_body}
            isTranslated={comment.is_translated}
            status={comment.translation_status}
            mode={translationMode}
            render={(text) => linkify(text)}
          />
          <div className="flex items-center gap-1 mt-2 text-xs">
            <ReactionButton
              icon="👍"
              count={comment.likes}
              active={comment.my_reaction === 'like'}
              activeClass="bg-emerald-500/15 text-emerald-400"
              disabled={!me}
              title={me ? t('comments.like') : t('comments.signInToReact')}
              onClick={() => onReaction('like')}
            />
            <ReactionButton
              icon="👎"
              count={comment.dislikes}
              active={comment.my_reaction === 'dislike'}
              activeClass="bg-rose-500/15 text-rose-400"
              disabled={!me}
              title={me ? t('comments.dislike') : t('comments.signInToReact')}
              onClick={() => onReaction('dislike')}
            />
            {me && (
              <button
                type="button"
                onClick={() => setShowReply((v) => !v)}
                className="px-2 py-1 rounded hover:bg-white/5 text-text-2 transition-colors"
              >
                {t('comments.reply')}
              </button>
            )}
            {me?.is_admin && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleteMut.isPending}
                title={t('comments.delete')}
                className="px-2 py-1 rounded hover:bg-rose-500/10 text-rose-400 transition-colors ml-auto disabled:opacity-50"
              >
                {deleteMut.isPending ? '…' : t('comments.delete')}
              </button>
            )}
          </div>

          {showReply && (
            <form onSubmit={onReplySubmit} className="mt-3 space-y-2">
              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder={t('comments.replyTo', { name: comment.author_name || comment.author_uid })}
                rows={2}
                autoFocus
                className="w-full bg-bg-2 border border-border rounded-lg p-2 text-sm focus:outline-none focus:border-accent/50"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setShowReply(false); setReplyBody('') }}
                  className="text-xs text-text-2 hover:text-text px-2"
                >
                  {t('comments.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={replyMut.isPending || replyBody.trim().length === 0}
                  className="btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {replyMut.isPending ? t('comments.posting') : t('comments.replyPost')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {comment.children.length > 0 && (
        <div className="space-y-3 border-l border-border pl-3 ml-3">
          {comment.children.map((c) => (
            <CommentNode
              key={c.id}
              comment={c}
              depth={depth + 1}
              ownerId={id}
              apiBase={base}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ConditionalLink({
  to, className, children,
}: {
  to: string | null
  className?: string
  children: ReactNode
}) {
  if (to) {
    return <Link to={to} className={className}>{children}</Link>
  }
  return <span className={className}>{children}</span>
}

function ReactionButton({
  icon, count, active, activeClass, disabled, title, onClick,
}: {
  icon: string
  count: number
  active: boolean
  activeClass: string
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2 py-1 rounded transition-colors flex items-center gap-1 ${
        active ? activeClass : 'text-text-2 hover:bg-white/5'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span>{icon}</span>
      <span className="font-semibold tabular-nums">{count}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

export function buildCommentTree(flat: Comment[]): CommentTreeNode[] {
  const byId = new Map<string, CommentTreeNode>()
  for (const c of flat) byId.set(c.id, { ...c, children: [] })

  const roots: CommentTreeNode[] = []
  for (const node of byId.values()) {
    if (node.parent_comment_id && byId.has(node.parent_comment_id)) {
      byId.get(node.parent_comment_id)!.children.push(node)
    } else {
      // Root, or parent missing (deleted/ignored) — surface as top-level.
      roots.push(node)
    }
  }
  // Children inherit chronological order from input flat list, since we
  // pushed in iteration order and iteration follows insertion order.
  return roots
}
