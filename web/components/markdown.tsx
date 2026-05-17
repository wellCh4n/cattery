"use client"

import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

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
    <th className={cn("border-b px-2 py-1.5 text-left font-medium bg-muted/40", className)} {...props} />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border-b last:border-0 px-2 py-1.5", className)} {...props} />
  ),
  code: ({ className, children, ...props }) => {
    // react-markdown gives className like `language-ts` only for fenced blocks.
    // Inline code has no `language-*` class.
    const isBlock = /language-/.test(className ?? "")
    if (isBlock) {
      return (
        <code className={cn("block font-mono text-[12px] leading-relaxed", className)} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className={cn(
          "rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "my-3 max-h-96 overflow-auto rounded-md border bg-background/60 p-3 text-xs",
        "[&_code]:bg-transparent [&_code]:p-0 [&_code]:text-foreground",
        className,
      )}
      {...props}
    />
  ),
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
