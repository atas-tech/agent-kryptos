import {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { apiBaseUrl, configureApiClient, type AuthApiResponse } from "../api/client.js";
import type { AuthUser, WorkspaceSummary } from "./types.js";

interface RegisterInput {
  email: string;
  password: string;
  workspaceSlug: string;
  displayName: string;
  turnstileToken?: string | null;
}

export interface AuthContextValue {
  user: AuthUser | null;
  workspace: WorkspaceSummary | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string, turnstileToken?: string | null) => Promise<AuthApiResponse>;
  register: (input: RegisterInput) => Promise<AuthApiResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<string | null>;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  setWorkspaceSummary: (workspace: WorkspaceSummary) => void;
  clearAuth: () => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function readError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return new Error(payload?.message ?? payload?.error ?? fallback);
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const accessTokenRef = useRef<string | null>(null);

  function applyAuth(payload: AuthApiResponse): void {
    accessTokenRef.current = payload.access_token;
    syncApiClient();
    setAccessToken(payload.access_token);
    setUser(payload.user);
    if (payload.workspace) {
      setWorkspace(payload.workspace);
    }
  }

  function clearAuth(): void {
    accessTokenRef.current = null;
    syncApiClient();
    setAccessToken(null);
    setUser(null);
    setWorkspace(null);
  }

  function syncApiClient(): void {
    configureApiClient({
      getAccessToken: () => accessTokenRef.current,
      refreshAuth: () => refresh(),
      handleAuthFailure: clearAuth
    });
  }

  let refreshPromise: Promise<string | null> | null = null;

  async function refresh(): Promise<string | null> {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const response = await fetch(`${apiBaseUrl()}/api/v2/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({})
        });

        if (!response.ok) {
          clearAuth();
          return null;
        }

        const payload = (await response.json()) as AuthApiResponse;
        applyAuth(payload);
        return payload.access_token;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  useEffect(() => {
    syncApiClient();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  async function login(email: string, password: string, turnstileToken?: string | null): Promise<AuthApiResponse> {
    const response = await fetch(`${apiBaseUrl()}/api/v2/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        email,
        password,
        cf_turnstile_response: turnstileToken ?? undefined
      })
    });

    if (!response.ok) {
      throw await readError(response, "Login failed");
    }

    const payload = (await response.json()) as AuthApiResponse;
    applyAuth(payload);
    return payload;
  }

  async function register(input: RegisterInput): Promise<AuthApiResponse> {
    const response = await fetch(`${apiBaseUrl()}/api/v2/auth/register`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        workspace_slug: input.workspaceSlug,
        display_name: input.displayName,
        cf_turnstile_response: input.turnstileToken ?? undefined
      })
    });

    if (!response.ok) {
      throw await readError(response, "Registration failed");
    }

    const payload = (await response.json()) as AuthApiResponse;
    applyAuth(payload);
    return payload;
  }

  async function logout(): Promise<void> {
    const token = accessToken;
    clearAuth();
    if (!token) {
      return;
    }

    await fetch(`${apiBaseUrl()}/api/v2/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: `Bearer ${token}`
      }
    }).catch(() => undefined);
  }

  async function changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const response = await fetch(`${apiBaseUrl()}/api/v2/auth/change-password`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: accessToken ? `Bearer ${accessToken}` : ""
      },
      body: JSON.stringify({
        current_password: currentPassword,
        next_password: nextPassword
      })
    });

    if (!response.ok) {
      throw await readError(response, "Password change failed");
    }

    const payload = (await response.json()) as {
      access_token: string;
      user: AuthUser;
    };

    accessTokenRef.current = payload.access_token;
    syncApiClient();
    setAccessToken(payload.access_token);
    setUser(payload.user);
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      workspace,
      accessToken,
      isAuthenticated: Boolean(accessToken && user && workspace),
      isLoading,
      login,
      register,
      logout,
      refresh,
      changePassword,
      setWorkspaceSummary: setWorkspace,
      clearAuth
    }),
    [accessToken, isLoading, user, workspace]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
