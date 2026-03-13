export interface PageCursor {
  createdAt: Date;
  id: string;
}

interface CursorPayload {
  created_at: string;
  id: string;
}

export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(
    JSON.stringify({
      created_at: cursor.createdAt.toISOString(),
      id: cursor.id
    } satisfies CursorPayload),
    "utf8"
  ).toString("base64url");
}

export function decodePageCursor(value: string): PageCursor {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("cursor must not be blank");
  }

  const payload = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as Partial<CursorPayload>;
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const createdAtValue = typeof payload.created_at === "string" ? payload.created_at : "";
  const createdAt = new Date(createdAtValue);

  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new Error("cursor is invalid");
  }

  return {
    createdAt,
    id
  };
}
