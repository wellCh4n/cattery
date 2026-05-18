"use client"

import { siClaude } from "simple-icons"
import { Bot, Sparkles, SquareTerminal } from "lucide-react"

type SimpleIcon = { path: string; title: string }

function BrandSvg({ icon, className }: { icon: SimpleIcon; className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-label={icon.title}
      className={className}
    >
      <path d={icon.path} />
    </svg>
  )
}

function HermesMark({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-label="Hermes"
      className={className}
    >
      <rect x="4" y="3" width="4" height="18" rx="0.5" />
      <rect x="16" y="3" width="4" height="18" rx="0.5" />
      <rect x="8" y="10" width="8" height="4" />
    </svg>
  )
}

export function HarnessIcon({ id, className }: { id: string; className?: string }) {
  switch (id) {
    case "claude-code":
      return <BrandSvg icon={siClaude} className={className} />
    case "hermes":
      return <HermesMark className={className} />
    case "opencode":
      return <SquareTerminal className={className} />
    case "codex":
      return <Sparkles className={className} />
    default:
      return <Bot className={className} />
  }
}
