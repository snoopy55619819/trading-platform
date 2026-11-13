// Whether "How it works?" is open, as a tiny store, so more than the top bar can open it:
// the sign-in page's link and the welcome toast after sign-up. Opening it once marks it seen,
// which takes the dot off the button.

import { useSyncExternalStore } from "react";

import { settingsStore } from "../../settings.ts";
import type { Toast } from "../../ui/toasts.ts";

let isOpen = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const guide = {
  open(): void {
    isOpen = true;
    if (!settingsStore.get().guideSeen) settingsStore.update({ guideSeen: true });
    emit();
  },
  close(): void {
    isOpen = false;
    emit();
  },
};

export function useGuideOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => isOpen,
  );
}

/** The toast a new account gets once it is open: its cash, and a way into the guide. */
export const WELCOME: Omit<Toast, "id"> = {
  tone: "info",
  title: "Welcome! You have $10,000 of pretend cash to trade with.",
  text: "Want to see what happens behind the screen when you trade?",
  action: { label: "How it works?", run: guide.open },
  lifetimeMs: 20_000,
};
