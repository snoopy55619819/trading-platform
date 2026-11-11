// The signed-in session: just the backend's bearer token. Kept for the browser tab
// (sessionStorage), so a reload stays signed in but a new tab asks again. The backend holds
// sessions in memory, so a backend restart ends them; the first 401 after that signs out here.

type Listener = () => void;

const KEY = "broker.session";

function read(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined; // storage blocked or unavailable: sessions just do not survive reloads
  }
}

function write(token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // as above
  }
}

class SessionStore {
  private current: string | undefined = typeof sessionStorage === "undefined" ? undefined : read();
  private readonly listeners = new Set<Listener>();

  token(): string | undefined {
    return this.current;
  }

  start(token: string): void {
    this.current = token;
    write(token);
    this.notify();
  }

  end(): void {
    if (this.current === undefined) return;
    this.current = undefined;
    write(undefined);
    this.notify();
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const session = new SessionStore();
