// Shared <ReactMarkdown> wrapper that opens every link in a new tab.
//
// Without this, ReactMarkdown's default <a> renders without target/rel,
// so clicking [link](url) in a proposal description / proposal metadata /
// new-proposal preview would navigate the SPA away from the page the user
// was reading. Anywhere we render user-supplied markdown should use this
// component instead of importing ReactMarkdown directly.
import { ComponentProps } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  children: string
}

export function Markdown({ children }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props: ComponentProps<'a'>) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
        // Wide content — GFM tables, code blocks, images — must scroll inside
        // its own overflow-x wrapper so it can't push its parent card wider
        // than the layout allows.
        table: (props: ComponentProps<'table'>) => (
          <div className="not-prose overflow-x-auto my-4 -mx-2 px-2 rounded-lg border border-border">
            <table {...props} className="w-full text-sm border-collapse [&_th]:text-left [&_th]:font-semibold [&_th]:px-3 [&_th]:py-2 [&_th]:border-b [&_th]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:border-b [&_td]:border-border/60" />
          </div>
        ),
        pre: (props: ComponentProps<'pre'>) => (
          <pre {...props} className="overflow-x-auto" />
        ),
        img: (props: ComponentProps<'img'>) => (
          <img {...props} className="max-w-full h-auto" loading="lazy" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
