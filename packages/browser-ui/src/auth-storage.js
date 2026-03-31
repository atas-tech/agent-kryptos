const REFRESH_TOKEN_KEY = "blindpass_refresh_token";

function resolveStorage() {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getStoredRefreshToken() {
  const storage = resolveStorage();
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
  const storage = resolveStorage();
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
