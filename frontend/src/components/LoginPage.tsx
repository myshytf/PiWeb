"use client";

import { useState, useEffect, useCallback } from "react";
import { clearCredentials, validateCredentials, checkAuthStatus } from "@/lib/auth";
import { KeyRound, Eye, EyeOff, Loader2 } from "lucide-react";

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [authDisabled, setAuthDisabled] = useState(false);

  // Check if auth is enabled at all
  useEffect(() => {
    checkAuthStatus().then((status) => {
      if (!status.enabled) {
        setAuthDisabled(true);
        // Auth is disabled on server — proceed without login
        onLoginSuccess();
      }
      setChecking(false);
    });
  }, [onLoginSuccess]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");

      if (!username.trim() || !password.trim()) {
        setError("Please enter both username and password");
        return;
      }

      setLoading(true);
      try {
        const valid = await validateCredentials({ username: username.trim(), password });
        if (valid) {
          clearCredentials();
          onLoginSuccess();
        } else {
          setError("Invalid username or password");
        }
      } catch {
        setError("Failed to connect to server. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [username, password, onLoginSuccess],
  );

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh] bg-[var(--color-bg-primary)]">
        <Loader2 size={24} className="animate-spin text-[var(--color-text-secondary)]" />
      </div>
    );
  }

  if (authDisabled) {
    return null; // Will be redirected by onLoginSuccess
  }

  return (
    <div className="flex items-center justify-center min-h-[100dvh] bg-[var(--color-bg-primary)] p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10 mb-4">
            <KeyRound size={28} className="text-[var(--color-accent)]" />
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">
            pi Remote
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Enter your credentials to continue
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              autoFocus
              autoComplete="username"
              disabled={loading}
              className="w-full px-3.5 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition-shadow disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete="current-password"
                disabled={loading}
                className="w-full px-3.5 py-2.5 pr-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent transition-shadow disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-tertiary)] transition-colors"
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2 text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-[var(--color-accent)] text-white font-medium hover:opacity-90 active:opacity-80 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Verifying...
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
