"use client"

import { use, useEffect } from "react"
import { SkillView } from "@/components/skill-view"
import { useSkillsStore } from "@/lib/skills-store"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  slug: string
}

export default function SkillPage({ params }: { params: Promise<PageParams> }) {
  const { slug } = use(params)
  // The pretty name lives in the catalog (SKILL.md frontmatter); resolve it for
  // the browser title, falling back to the slug until it loads or if it's gone.
  const catalog = useSkillsStore(state => state.entries.catalog?.data)
  const name = catalog?.find(skill => skill.slug === slug)?.name ?? slug
  useEffect(() => { void useSkillsStore.getState().load("catalog") }, [])

  useDocumentTitle(name)

  return <SkillView key={slug} slug={slug} />
}
