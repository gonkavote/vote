// Shared <ReactMarkdown> wrapper that opens every link in a new tab.
//
// Without this, ReactMarkdown's default <a> renders without target/rel,
// so clicking [link](url) in a tender description / proposal metadata /
// new-tender preview would navigate the SPA away from the page the user
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
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
