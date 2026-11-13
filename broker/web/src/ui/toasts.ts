// Toasts: short messages in the corner that go away by themselves. A tiny store, so
// anything (a watcher, a dialog) can add one and the one Toaster draws them.

import { useSyncExternalStore } from "react";

export type Tone = "good" | "bad" | "info";

export interface Toast {
  id: number;
  tone: Tone;
  title: string;
  text?: string | undefined;
  /** A button in the toast. Pressing it runs `run` and dismisses the toast. */
  action?: { label: string; run: () => void } | undefined;
  /** How long it stays, when not the tone's usual time. */
  lifetimeMs?: number | undefined;
}

const MAX = 4;
const LIFETIME_MS: Record<Tone, number> = { good: 6000, info: 6000, bad: 10_000 };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function notify(toast: Omit<Toast, "id">): void {
  const id = nextId++;
  // Newest last; the oldest go when there are too many.
  toasts = [...toasts, { ...toast, id }].slice(-MAX);
  emit();
  setTimeout(() => dismiss(id), toast.lifetimeMs ?? LIFETIME_MS[toast.tone]);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
