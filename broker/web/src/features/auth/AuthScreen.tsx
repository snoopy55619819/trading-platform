// Sign in and sign up. The container runs the requests; the view only draws the form.

import { type FormEvent, useState } from "react";

import { ApiError } from "../../api/backend.ts";
import { useLogIn, useSignUp } from "../../query/hooks.ts";
import { ThemeSwitcher } from "../../theme/ThemeSwitcher.tsx";
import "./auth.css";

type Mode = "signIn" | "signUp";

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signIn");
  const logIn = useLogIn();
  const signUp = useSignUp();
  const active = mode === "signIn" ? logIn : signUp;
  return (
    <AuthView
      mode={mode}
      pending={active.isPending}
      error={describe(active.error)}
      onModeChange={(next) => {
        logIn.reset();
        signUp.reset();
        setMode(next);
      }}
      onSubmit={({ email, password, name }) =>
        mode === "signIn" ? logIn.mutate({ email, password }) : signUp.mutate({ email, password, name })
      }
    />
  );
}

function describe(error: Error | null): string | undefined {
  if (!error) return undefined;
  if (error instanceof ApiError) return error.message;
  return "Cannot reach the broker. Is the backend running?";
}

export interface AuthViewProps {
  mode: Mode;
  pending: boolean;
  error: string | undefined;
  onModeChange: (mode: Mode) => void;
  onSubmit: (values: { email: string; password: string; name: string }) => void;
}

export function AuthView({ mode, pending, error, onModeChange, onSubmit }: AuthViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const signUp = mode === "signUp";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ email: email.trim(), password, name: name.trim() || email.trim() });
  };
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit} noValidate={false}>
        <h1 className="auth-title">Broker</h1>
        <p className="muted auth-subtitle">{signUp ? "Open an account" : "Sign in to trade"}</p>

        {signUp && (
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            required
            minLength={signUp ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={signUp ? "new-password" : "current-password"}
          />
          {signUp && <small className="muted">At least 8 characters.</small>}
        </label>

        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button primary auth-submit" disabled={pending}>
          {pending ? "One moment…" : signUp ? "Open account" : "Sign in"}
        </button>
        <button type="button" className="link" onClick={() => onModeChange(signUp ? "signIn" : "signUp")}>
          {signUp ? "I already have an account" : "New here? Open an account"}
        </button>
      </form>
      <div className="auth-theme">
        <ThemeSwitcher />
      </div>
    </main>
  );
}
