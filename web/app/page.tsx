"use client"

import { useState } from "react"
import { Sidebar } from "@/components/sidebar"
import { ChatPanel } from "@/components/chat-panel"
import type { Agent, Session } from "@/lib/api"

interface ActiveChat {
  session: Session
  agent: Agent
}

export default function Page() {
  const [active, setActive] = useState<ActiveChat | null>(null)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        selectedSessionId={active?.session.session_id ?? null}
        onSelectSession={(session, agent) => setActive({ session, agent })}
      />
      <main className="flex-1 overflow-hidden">
        {active ? (
          <ChatPanel
            key={active.session.session_id}
            session={active.session}
            agent={active.agent}
            onSessionUpdate={s => setActive(prev => prev ? { ...prev, session: s } : null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a session or create a new one
          </div>
        )}
      </main>
    </div>
  )
}
