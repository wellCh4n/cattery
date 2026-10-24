"use client"

import { toast, type ExternalToast } from "sonner"

export interface NotifyOptions extends ExternalToast {
  // Stays until the user closes it (close button or action) instead of
  // closing on its own after a few seconds.
  persistent?: boolean
}

// Shows a toast. It closes on its own unless persistent.
export function notify(message: string, { persistent, ...options }: NotifyOptions = {}) {
  return toast(message, persistent ? { duration: Infinity, closeButton: true, ...options } : options)
}
