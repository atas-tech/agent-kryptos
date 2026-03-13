import type { AuthUser, WorkspaceSummary } from "../auth/types.js";

export interface AuthApiResponse {
  access_token: string;
  refresh_token?: string;
  access_token_expires_at?: number;
  refresh_token_expires_at?: number;
  user: AuthUser;
  workspace?: WorkspaceSummary;
}

export interface ApiErrorPayload {
  error?: string;
  code?: string;
}

interface ApiClientConfig {
  getAccessToken: () => string | null;
  refreshAuth: () => Promise<string | null>;
  handleAuthFailure: () => void;
}

const DEFAULT_API_URL = "http://localhost:3100";

let clientConfig: ApiClientConfig = {
  getAccessToken: () => null,
  refreshAuth: async () => null,
  handleAuthFailure: () => {}
};

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiBaseUrl(): string {
  return import.meta.env.VITE_SPS_API_URL ?? DEFAULT_API_URL;
}

export function configureApiClient(config: ApiClientConfig): void {
  clientConfig = config;
}

function parseResponseError(status: number, payload: ApiErrorPayload | null): never {
  throw new ApiError(status, payload?.error ?? `Request failed with status ${status}`, payload?.code);
}

async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
  accessTokenOverride?: string
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  const accessToken = accessTokenOverride ?? clientConfig.getAccessToken();
  if (accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers
  });

  if (response.status === 401 && retry) {
    const nextAccessToken = await clientConfig.refreshAuth();
    if (nextAccessToken) {
      return apiRequest<T>(path, init, false, nextAccessToken);
    }
    clientConfig.handleAuthFailure();
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorPayload | null;
    parseResponseError(response.status, payload);
  }

  return parseJson<T>(response);
}
