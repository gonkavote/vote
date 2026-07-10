import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../lib/markdown'

const MAX_LINES = 50

export function ExpandableMarkdown({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const lines = text.split('\n')
  const truncated = lines.length > MAX_LINES
  const shown = expanded || !truncated ? text : lines.slice(0, MAX_LINES).join('\n')
  const hiddenLines = lines.length - MAX_LINES

  return (
    <>
      <div className={truncated && !expanded ? 'relative' : undefined}>
        <Markdown>{shown}</Markdown>
        {truncated && !expanded && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-bg-card"
          />
        )}
      </div>
      {truncated && (
        <div className="not-prose mt-4 flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="btn-primary"
          >
            {expanded ? t('proposal.readLess') : t('proposal.readMore')}
          </button>
          {!expanded && (
            <span className="text-[11px] text-text-2">
              {t('proposal.hiddenLines', { n: hiddenLines })}
            </span>
          )}
        </div>
      )}
    </>
  )
}
