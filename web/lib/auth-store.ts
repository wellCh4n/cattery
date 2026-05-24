"use client"

import { create } from "zustand"
import {
  changePassword as apiChangePassword,
  fetchMe,
  login as apiLogin,
  type CurrentUser,
} from "@/lib/api"
import { getStoredToken, setStoredToken } from "@/lib/auth-token"

interface AuthState {
  user: CurrentUser | null
  // status moves from `loading` (initial /me probe) to `authed` / `anon`.
  // Components gate their UI on this — render nothing while loading so we
  // don't briefly flash protected content before the redirect kicks in.
  status: "loading" | "authed" | "anon"
  hydrate: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
}

export const useAuthStore = create<AuthState>(set => ({
  user: null,
  status: "loading",

  // hydrate is called once on app boot. If there's a token in localStorage
  // we validate it via /auth/me; an invalid token causes authedFetch to
  // clear storage and bounce to /login, so this becomes a no-op for the
  // logged-out path.
  hydrate: async () => {
    const token = getStoredToken()
    if (!token) {
      set({ user: null, status: "anon" })
      return
    }
    try {
      const user = await fetchMe()
      set({ user, status: "authed" })
    } catch {
      set({ user: null, status: "anon" })
    }
  },

  login: async (email, password) => {
    const { token, user } = await apiLogin(email, password)
    setStoredToken(token)
    set({ user, status: "authed" })
  },

  logout: () => {
    setStoredToken(null)
    set({ user: null, status: "anon" })
    if (typeof window !== "undefined") {
      window.location.href = "/login"
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    await apiChangePassword(oldPassword, newPassword)
  },
}))
