import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Handbook markdown, rendered by a library rather than by hand (roadmap
 * decision 5).
 *
 * The mockup's `MarkdownView` split on blank lines and matched inline spans with
 * one regular expression, which covered the six things the seeded pages used and
 * quietly dropped anything else a team wrote. `remark-gfm` adds the tables,
 * strikethrough, task lists and autolinks that a handbook author will reach for
 * without asking whether the renderer supports them.
 *
 * **Nothing here renders raw HTML.** `react-markdown` passes the tree through
 * without `dangerouslySetInnerHTML`, and HTML in the source is escaped unless
 * `rehype-raw` is added. It is not added, and should not be: page bodies are
 * written by workspace members but read by everyone in the workspace, and an
 * agent with write access to the handbook is another author again.
 *
 * The class names are the mockup's, element for element, so a page reads the
 * same as it did before the swap.
 */

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-[22px] font-semibold tracking-tight text-ink">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="pt-2 text-[15px] font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[13px] font-semibold text-ink">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  code: ({ children }) => (
    <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-[12px]">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-ink-muted">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-accent hover:underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="border-border" />,
  // The wrapper scrolls rather than the page, so a wide table cannot push the
  // sidebar off screen.
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-left text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-border px-3 py-2 font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-2">{children}</td>,
}

export function MarkdownView({ source }: { readonly source: string }): React.JSX.Element {
  return (
    <div className="markdown space-y-3 text-[13px] leading-relaxed text-ink">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  )
}
