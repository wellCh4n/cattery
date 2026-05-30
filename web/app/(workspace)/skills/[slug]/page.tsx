"use client"

import { use, useEffect, useState } from "react"
import { SkillView } from "@/components/skill-view"
import { listSkillCatalog } from "@/lib/api"
import { useDocumentTitle } from "@/lib/use-document-title"

interface PageParams {
  slug: string
}

export default function SkillPage({ params }: { params: Promise<PageParams> }) {
  const { slug } = use(params)
  // The pretty name lives in the catalog (SKILL.md frontmatter); resolve it for
  // the header/title, falling back to the slug until it loads or if it's gone.
  const [name, setName] = useState(slug)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setName(slug)
      try {
        const catalog = await listSkillCatalog()
        if (cancelled) return
        const item = catalog.find(s => s.slug === slug)
        if (item?.name) setName(item.name)
      } catch { /* keep slug fallback */ }
    })()
    return () => { cancelled = true }
  }, [slug])

  useDocumentTitle(name)

  return <SkillView key={slug} slug={slug} name={name} />
}
