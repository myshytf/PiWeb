/**
 * Auth helpers for pi-web-remote frontend.
 *
 * Authentication is persisted by a server-issued HttpOnly cookie.
 * localStorage is kept only as a legacy migration path for older builds that
 * stored credentials client-side.
 */

const STORAGE_KEY = "pi_web_auth_credentials";

export interface StoredCredentials {
  username: string;
  password: string;
}

/**
 * Load stored credentials from localStorage.
 */
export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (parsed.username && parsed.password) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Legacy no-op. Do not persist passwords in web storage.
 */
export function saveCredentials(_creds: StoredCredentials): void {
  clearCredentials();
}

/**
 * Clear stored credentials (logout).
 */
export function clearCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Get the Basic Auth header value from stored credentials.
 * Returns null if no credentials are stored.
 */
export function getBasicAuthHeader(): string | null {
  const creds = loadCredentials();
  if (!creds) return null;
  const encoded = btoa(`${creds.username}:${creds.password}`);
  return `Basic ${encoded}`;
}

/**
 * Validate credentials against the server.
 */
export async function validateCredentials(creds: StoredCredentials): Promise<boolean> {
  try {
    const encoded = btoa(`${creds.username}:${creds.password}`);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Check if the server requires authentication.
 */
export async function checkAuthStatus(): Promise<{ enabled: boolean }> {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    if (!res.ok) return { enabled: true };
    const data = await res.json();
    return { enabled: data.enabled ?? true };
  } catch {
    return { enabled: true };
  }
}

/**
 * Check whether the HttpOnly auth cookie is currently valid.
 */
export async function checkAuthenticatedSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!res.ok) return false;
    const data = await res.json();
    return data.authenticated === true;
  } catch {
    return false;
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // ignore
  }
  clearCredentials();
}
