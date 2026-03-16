import { sealBase64 } from "./crypto.js";
import { buildPreviewHref, createPreviewMetadata, getBootstrapMode, parseContext } from "./request-context.js";
import "./style.css";

const AUTO_HIDE_MS = 20000;
const STATUS_COLORS = {
  danger: "var(--danger)",
  info: "var(--primary)",
  muted: "var(--muted)",
  success: "var(--success)",
  warning: "var(--warning)"
};

function setEntryEnabled(enabled, ui) {
  ui.secretSingle.disabled = !enabled;
  ui.secretMulti.disabled = !enabled;
  ui.multilineToggle.disabled = !enabled;
  ui.toggleVisibility.disabled = !enabled || ui.multilineToggle.checked;
  ui.clearSecret.disabled = !enabled;
  ui.submitButton.disabled = !enabled;
}

function setStatus(statusEl, message, tone = "muted") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  statusEl.style.color = STATUS_COLORS[tone] ?? STATUS_COLORS.muted;
}

function setModeLabels(labels, text, mode) {
  for (const label of labels) {
    if (!label) continue;
    label.textContent = text;
    label.dataset.mode = mode;
  }
}

async function init() {
  const status = document.getElementById("status");
  const code = document.getElementById("code");
  const codeBox = document.getElementById("code-box");
  const sessionCaption = document.getElementById("session-caption");
  const submitButton = document.getElementById("submit");
  const secretSingle = document.getElementById("secret-single");
  const secretMulti = document.getElementById("secret-multi");
  const toggleVisibility = document.getElementById("toggle-visibility");
  const multilineToggle = document.getElementById("multiline-toggle");
  const clearSecret = document.getElementById("clear-secret");
  const previewNotice = document.getElementById("preview-notice");
  const securityFootnote = document.getElementById("security-footnote");
  const topbarMode = document.getElementById("mode-badge");
  const sessionState = document.getElementById("session-state");

  const formContainer = document.getElementById("form-container");
  const successContainer = document.getElementById("success-container");
  const successStatus = document.getElementById("success-status");
  const successDetail = document.getElementById("success-detail");

  const ui = {
    clearSecret,
    submitButton,
    secretSingle,
    secretMulti,
    multilineToggle,
    toggleVisibility
  };

  let autoHideTimer = null;
  let isSingleVisible = false;
  let isSuccess = false;
  let activeMode = "invalid";
  let activeMetadata = null;

  function clearAutoHideTimer() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }

  function setSingleVisibility(visible, autoHide = true) {
    isSingleVisible = visible;
    secretSingle.type = visible ? "text" : "password";
    toggleVisibility.textContent = visible ? "Hide Secret" : "Show Secret";

    clearAutoHideTimer();
    if (visible && autoHide) {
      autoHideTimer = setTimeout(() => {
        setSingleVisibility(false, false);
      }, AUTO_HIDE_MS);
    }
  }

  function currentSecretValue() {
    return multilineToggle.checked ? secretMulti.value : secretSingle.value;
  }

  function setInputMode(multiline) {
    const current = currentSecretValue();
    if (multiline) {
      secretMulti.value = current;
      secretSingle.hidden = true;
      secretMulti.hidden = false;
      toggleVisibility.hidden = true;
      setSingleVisibility(false, false);
      secretMulti.focus();
      return;
    }

    secretSingle.value = current;
    secretSingle.hidden = false;
    secretMulti.hidden = true;
    toggleVisibility.hidden = false;
    setSingleVisibility(false, false);
    secretSingle.focus();
  }

  function clearSecretInputs() {
    secretSingle.value = "";
    secretMulti.value = "";
    if (multilineToggle.checked) {
      secretMulti.focus();
      return;
    }

    secretSingle.focus();
  }

  function applySessionView(metadata, mode) {
    activeMetadata = metadata;
    activeMode = mode;

    if (metadata.confirmation_code) {
      code.textContent = metadata.confirmation_code;
      codeBox.hidden = false;
    } else {
      code.textContent = "";
      codeBox.hidden = true;
    }

    if (mode === "preview") {
      previewNotice.hidden = false;
      sessionCaption.textContent = "Local QA session code";
      submitButton.textContent = "Simulate Secure Submit";
      securityFootnote.textContent = "Preview mode stays local. No secret is encrypted, uploaded, or stored remotely.";
      setModeLabels([topbarMode, sessionState], "Preview mode", "preview");
      setStatus(status, "Preview mode is active. Inputs are unlocked for local QA without a live signed session.", "info");
      return;
    }

    previewNotice.hidden = true;
    sessionCaption.textContent = "Identity session code";
    submitButton.textContent = "Encrypt and Submit";
    securityFootnote.textContent = "Client-side encryption happens before any payload leaves this page.";
    setModeLabels([topbarMode, sessionState], "Signed session", "request");
    setStatus(status, "Verify the session code, then enter the secret you want to encrypt for the agent.", "muted");
  }

  function showPreviewAssist(message, tone = "warning") {
    previewNotice.hidden = true;
    setModeLabels([topbarMode, sessionState], "Session required", "locked");
    setStatus(status, message, tone);
  }

  toggleVisibility.addEventListener("click", () => {
    if (multilineToggle.checked) return;
    setSingleVisibility(!isSingleVisible, true);
  });

  multilineToggle.addEventListener("change", () => {
    setInputMode(multilineToggle.checked);
  });

  clearSecret.addEventListener("click", () => {
    clearSecretInputs();
  });

  submitButton.addEventListener("click", async () => {
    const secretValue = currentSecretValue();
    if (!secretValue) {
      setStatus(status, "Secret cannot be empty.", "warning");
      return;
    }

    setEntryEnabled(false, ui);

    if (activeMode === "preview") {
      isSuccess = true;
      formContainer.hidden = true;
      successContainer.hidden = false;
      successStatus.textContent = "Preview complete. The form flow worked, but no secret was transmitted.";
      successDetail.textContent = "Use a signed session link when you want to exercise real encryption and submission.";
      clearAutoHideTimer();
      return;
    }

    if (!activeMetadata?.public_key) {
      setStatus(status, "Request metadata is unavailable.", "danger");
      setEntryEnabled(true, ui);
      return;
    }

    setStatus(status, "Encrypting and submitting...", "muted");

    try {
      const payload = await sealBase64(activeMetadata.public_key, secretValue);
      const submitRes = await fetch(
        `${activeMetadata.apiUrl}/api/v2/secret/submit/${activeMetadata.requestId}?sig=${encodeURIComponent(activeMetadata.submitSig)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }
      );

      if (submitRes.ok) {
        isSuccess = true;
        formContainer.hidden = true;
        successContainer.hidden = false;
        successStatus.textContent = "Secret submitted successfully. You may safely close this window.";
        successDetail.textContent = "The secret left this browser only as an encrypted payload scoped to the current request.";
        clearAutoHideTimer();
        return;
      }

      if (submitRes.status === 403) {
        setStatus(status, "Link signature is invalid.", "danger");
      } else if (submitRes.status === 409) {
        setStatus(status, "This request already has a submitted secret.", "danger");
      } else if (submitRes.status === 410) {
        setStatus(status, "This request has expired.", "danger");
      } else if (submitRes.status === 413) {
        setStatus(status, "Secret is too large.", "danger");
      } else {
        setStatus(status, "Submission failed.", "danger");
      }
    } catch {
      setStatus(status, "Encryption or network failed.", "danger");
    } finally {
      if (!isSuccess) {
        setEntryEnabled(true, ui);
      }
    }
  });

  const ctx = parseContext(window.location.search);
  const bootstrapMode = getBootstrapMode(ctx);

  if (bootstrapMode === "invalid") {
    showPreviewAssist("Invalid or expired secure session.", "danger");
    setEntryEnabled(false, ui);
    return;
  }

  const resolvedApiUrl = ctx.apiUrl || import.meta.env.VITE_SPS_API_URL || "http://localhost:3100";

  if (bootstrapMode === "preview") {
    applySessionView(createPreviewMetadata(), "preview");
    setEntryEnabled(true, ui);
    setSingleVisibility(false, false);
    setInputMode(false);
    return;
  }

  try {
    const metadataRes = await fetch(
      `${resolvedApiUrl}/api/v2/secret/metadata/${ctx.requestId}?sig=${encodeURIComponent(ctx.metadataSig)}`
    );

    if (!metadataRes.ok) {
      showPreviewAssist("Request expired or invalid.", "danger");
      setEntryEnabled(false, ui);
      return;
    }

    const metadata = await metadataRes.json();
    applySessionView(
      {
        ...metadata,
        apiUrl: resolvedApiUrl,
        requestId: ctx.requestId,
        submitSig: ctx.submitSig
      },
      "request"
    );
    setEntryEnabled(true, ui);
    setSingleVisibility(false, false);
    setInputMode(false);
  } catch {
    showPreviewAssist("Failed to connect to the server. Preview mode is available for local layout and interaction testing.", "danger");
    setEntryEnabled(false, ui);
  }
}

init().catch(() => {
  const status = document.getElementById("status");
  if (status) {
    setStatus(status, "Unexpected error.", "danger");
  }
});
