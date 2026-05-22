"use client"

import { memo, type ReactElement } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"
import { CodeBlock } from "@/components/code-block"

function extractText(node: unknown): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (typeof node === "object" && "props" in node) {
    const n = node as { props?: { children?: unknown } }
    return extractText(n.props?.children)
  }
  return ""
}

const components: Components = {
  p: ({ className, ...props }) => (
    <p className={cn("leading-relaxed [&:not(:last-child)]:mb-3", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("text-primary underline underline-offset-2 hover:no-underline", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("list-disc pl-5 space-y-1 [&:not(:last-child)]:mb-3", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("list-decimal pl-5 space-y-1 [&:not(:last-child)]:mb-3", className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  h1: ({ className, ...props }) => (
    <h1 className={cn("font-heading text-lg font-semibold mt-4 mb-2 first:mt-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("font-heading text-base font-semibold mt-4 mb-2 first:mt-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("font-heading text-sm font-semibold mt-3 mb-1.5 first:mt-0", className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("border-l-2 border-border pl-3 italic text-muted-foreground my-3", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("border-border my-4", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-md border">
      <table className={cn("w-full text-xs", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th className={cn("border-b border-r last:border-r-0 px-2 py-1.5 text-left font-medium bg-muted/40", className)} {...props} />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border-b border-r last:border-r-0 px-2 py-1.5 [tr:last-child_&]:border-b-0", className)} {...props} />
  ),
  code: ({ className, children, ...props }) => {
    // react-markdown gives className like `language-ts` only for fenced blocks.
    // Inline code has no `language-*` class. Block code is rendered by `pre`.
    const isBlock = /language-/.test(className ?? "")
    if (isBlock) {
      // pre's renderer will pull out children; we still need to render valid HTML
      // when used outside a pre (rare), so keep simple.
      return (
        <code className={cn("block font-mono text-[12px] leading-relaxed", className)} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className={cn(
          "rounded bg-secondary text-secondary-foreground px-1 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }) => {
    // Replace default <pre><code class="language-xxx">...</code></pre>
    // with our CodeBlock that has syntax highlight + copy.
    const child = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string; children?: unknown }> | undefined
    if (child && child.props) {
      const className = child.props.className ?? ""
      const m = /language-([\w-]+)/.exec(className)
      const lang = m?.[1]
      const codeText = extractText(child.props.children)
      return <CodeBlock code={codeText.replace(/\n$/, "")} lang={lang} />
    }
    return <pre className="my-3 max-h-96 overflow-auto rounded-md border bg-background/60 p-3 text-xs">{children}</pre>
  },
  strong: ({ className, ...props }) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
}

interface Props {
  children: string
  className?: string
}

function MarkdownInner({ children, className }: Props) {
  return (
    <div className={cn("text-sm break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownInner, (prev, next) =>
  prev.children === next.children && prev.className === next.className,
)
