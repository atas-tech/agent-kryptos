function renderBlockedMessage(doc: Document): void {
  if (!doc.body) {
    return;
  }

  const message = doc.createElement("p");
  message.textContent = "This application cannot be embedded in another site.";
  doc.body.replaceChildren(message);
}

export function enforceTopLevelWindow(
  win: Pick<Window, "top" | "self" | "location"> = window,
  doc: Document = document
): boolean {
  if (!win || !doc || !win.top || win.top === win.self) {
    return false;
  }

  try {
    win.top.location.href = win.location.href;
  } catch {
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", () => renderBlockedMessage(doc), { once: true });
    } else {
      renderBlockedMessage(doc);
    }
  }

  return true;
}
