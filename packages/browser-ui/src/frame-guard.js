function renderBlockedMessage(doc) {
  if (!doc.body) {
    return;
  }

  const message = doc.createElement("p");
  message.textContent = "This page cannot be embedded in another site.";
  doc.body.replaceChildren(message);
}

export function enforceTopLevelWindow(win = globalThis.window, doc = globalThis.document) {
  if (!win || !doc || win.top === win.self) {
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
