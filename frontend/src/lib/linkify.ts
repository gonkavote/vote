// Turn raw URLs in user-submitted plain text into clickable <a target="_blank">.
// Used wherever we render free-form proposal/comment text without Markdown
// (governance summary + failed_reason). Keeps line breaks via the caller's
// `whitespace-pre-wrap` styling — we only inject anchors, the surrounding
// text passes through verbatim.
import { createElement, Fragment, ReactNode } from 'react'

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

export function linkify(text: string, anchorClass = 'text-accent hover:underline break-all'): ReactNode {
  if (!text) return text
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push(text.slice(last, idx))
    // Some URLs end with punctuation that's not really part of the link.
    // Trim a single trailing . , ; : ! ? to keep grammar sane.
    let url = m[0]
    let trailing = ''
    while (url.length > 0 && /[.,;:!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing
      url = url.slice(0, -1)
    }
    parts.push(
      createElement(
        'a',
        {
          key: idx,
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: anchorClass,
        },
        url,
      ),
    )
    if (trailing) parts.push(trailing)
    last = idx + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return createElement(Fragment, null, ...parts)
}
