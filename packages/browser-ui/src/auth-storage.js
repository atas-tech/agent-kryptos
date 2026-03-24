const REFRESH_TOKEN_KEY = "sps_refresh_token";

function resolveSessionStorage() {
  try {
    return globalThis.window?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function getStoredRefreshToken() {
  const storage = resolveSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredRefreshToken(refreshToken) {
  const storage = resolveSessionStorage();
  if (!storage) {
    return;
  }

  try {
    if (typeof refreshToken === "string" && refreshToken) {
      storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      return;
    }

    storage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures and continue with the in-memory access token.
  }
}
