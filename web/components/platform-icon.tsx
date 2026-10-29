"use client"

import { NewLark } from "@icon-park/react"
import { siWechat } from "simple-icons"
import { BrandSvg } from "@/components/model-icon"
import { type ChannelType } from "@/lib/api"
import { cn } from "@/lib/utils"

// The chat platforms' brand marks, in the current color like the model icons:
// WeChat's from simple-icons; Feishu and Lark share their bird logo, from
// ByteDance's IconPark.
export function PlatformIcon({ type, className }: { type: ChannelType; className?: string }) {
  if (type === "weixin") return <BrandSvg icon={siWechat} className={className} />
  return <NewLark size="100%" fill="currentColor" className={cn("inline-flex", className)} aria-label={type === "lark" ? "Lark" : "Feishu"} />
}
