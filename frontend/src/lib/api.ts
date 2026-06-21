// Tiny typed fetch wrapper. Backend lives at /api (proxied in dev, traefik in prod).

import i18n from '../i18n'

export interface ApiError extends Error {
  status: number
  body: unknown
}

/** Append ?lang={current ui locale} to GETs so the backend can swap in
 * translations from tenders.title_t / comments.body_t when present. */
function withLang(path: string): string {
  const lng = (i18n.resolvedLanguage || i18n.language || '').slice(0, 2)
  if (!lng) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}lang=${encodeURIComponent(lng)}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (!res.ok) {
    let body: unknown = null
    try { body = await res.json() } catch {}
    const err = new Error(`API ${res.status}: ${res.statusText}`) as ApiError
    err.status = res.status
    err.body = body
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get:    <T,>(p: string) => request<T>(withLang(p)),
  post:   <T,>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  patch:  <T,>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  delete: <T,>(p: string) => request<T>(p, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** ngonka counts come from the backend as decimal strings (UInt128). */
export interface Tally {
  voter_count: number
  sum_bid_ngonka: string
  community_weight_ngonka: string
  hosts_weight_ngonka: string
  weighted_avg_bid_ngonka: string
  refreshed_at: string | null
}

export type TranslationStatus = 'ready' | 'pending' | 'failed'

export interface TenderSummary {
  id: string
  title: string
  summary: string
  creator_uid: string
  creator_name: string | null
  creator_image: string | null
  status: 'open' | 'closed'
  created_at: string
  closes_at: string | null
  tally: Tally
  comment_count: number
  source_lang: string
  is_translated: boolean
  original_title?: string | null
  original_summary?: string | null
  translation_status: TranslationStatus
}

export interface VoterEntry {
  voter: string
  amount_ngonka: string
  community_weight_ngonka: string
  hosts_weight_ngonka: string
  tx_hash: string | null
  voted_at: string | null
}

export interface TenderDetail extends TenderSummary {
  description: string
  creator_wallet: string | null
  voters: VoterEntry[]
  original_description?: string | null
}

export interface Comment {
  id: string
  parent_comment_id: string | null
  author_uid: string
  author_name: string | null
  author_image: string | null
  body: string
  created_at: string
  likes: number
  dislikes: number
  my_reaction: 'like' | 'dislike' | null
  source_lang: string
  is_translated: boolean
  original_body?: string | null
  translation_status: TranslationStatus
}

export type ReactionType = 'like' | 'dislike' | ''

export interface Me {
  uid: string
  email: string
  name: string | null
  image: string | null
  wallet_address: string | null
  is_admin: boolean
}

export interface UserPublicProfile {
  uid: string
  name: string | null
  image: string | null
  wallet_address: string | null
  tenders: TenderSummary[]
}

export interface Config {
  contract_address: string
  chain_id: string
  rpc_url: string
  rest_url: string
  /** Empty when Telegram login is not configured. */
  telegram_bot_username: string
  /** Numeric prefix of the bot token (Telegram exposes it publicly). */
  telegram_bot_id: number
  /** Public site URL (no trailing slash). Used for canonical / share links. */
  public_base_url: string
  /** Tracker explorer base URL (e.g. https://tracker.example.com).
   *  Empty disables explorer-out links. */
  tracker_ui_url: string
  /** WalletConnect projectId. Empty disables the WC flow. */
  wc_project_id: string
}

// ---------------------------------------------------------------------------
// Governance — read-only mirror of tracker's data (translated)
// ---------------------------------------------------------------------------

export type GovStatus = 'voting' | 'deposit' | 'passed' | 'rejected' | 'failed'

export interface GovProposalSummary {
  proposal_id: number
  title: string
  summary: string
  status: GovStatus
  expedited: boolean
  submit_time: string
  voting_start_time: string | null
  voting_end_time: string | null
  deposit_end_time: string | null
  yes_count: string
  no_count: string
  abstain_count: string
  veto_count: string
  total_deposit_ngonka: string
  voted_count: number
  depositor_count: number
  total_voters_at_end: number
  total_bonded_at_end: string
  epoch_at_submit: number | null
  msg_types: string[]
  source_lang: string
  is_translated: boolean
  original_title?: string | null
  original_summary?: string | null
  translation_status: TranslationStatus
}

export interface GovProposalDetail extends GovProposalSummary {
  metadata_url: string
  proposer: string
  failed_reason: string
  original_failed_reason?: string | null
  // Full decoded message list — same shape the tracker API returns. The
  // JSON tab renders this verbatim.
  messages?: unknown[]
  metadata?: string
}

export interface GovProposalsPage {
  proposals: GovProposalSummary[]
  total: number
  page: number
  page_size: number
}

export interface GovVote {
  voter: string
  option: string
  weight: number
  voting_power: string
  voted_at: string | null
  voted_height: number
  tx_hash: string
}

export interface GovDeposit {
  depositor: string
  amount_ngonka: string
  deposited_at: string | null
  tx_hash: string
}

export interface GovMetadata {
  proposal_id: number
  markdown: string
  source_url: string
  fetched_at: string | null
  is_translated: boolean
  original_markdown?: string | null
  translation_status: TranslationStatus
}
