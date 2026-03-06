import { sealBase64 } from "./crypto.js";
import "./style.css";

const AUTO_HIDE_MS = 20000;

function getContext() {
  const params = new URLSearchParams(window.location.search);
  return {
    requestId: params.get("id"),
    metadataSig: params.get("metadata_sig"),
    submitSig: params.get("submit_sig"),
    apiUrl: params.get("api_url")
  };
}

function setEntryEnabled(enabled, ui) {
  ui.secretSingle.disabled = !enabled;
  ui.secretMulti.disabled = !enabled;
  ui.multilineToggle.disabled = !enabled;
  ui.toggleVisibility.disabled = !enabled || ui.multilineToggle.checked;
  ui.submitButton.disabled = !enabled;
}

async function init() {
  const status = document.getElementById("status");
  const code = document.getElementById("code");
  const submitButton = document.getElementById("submit");
  const secretSingle = document.getElementById("secret-single");
  const secretMulti = document.getElementById("secret-multi");
  const secretLabel = document.getElementById("secret-label");
  const secretControls = document.getElementById("secret-controls");
  const toggleVisibility = document.getElementById("toggle-visibility");
  const multilineToggle = document.getElementById("multiline-toggle");

  const ui = {
    submitButton,
    secretSingle,
    secretMulti,
    multilineToggle,
    toggleVisibility
  };

  let autoHideTimer = null;
  let isSingleVisible = false;
  let isSuccess = false;

  function clearAutoHideTimer() {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }

  function setSingleVisibility(visible, autoHide = true) {
    isSingleVisible = visible;
    secretSingle.type = visible ? "text" : "password";
    toggleVisibility.textContent = visible ? "Hide" : "Show";

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
      toggleVisibility.disabled = true;
      setSingleVisibility(false, false);
      secretMulti.focus();
      return;
    }

    secretSingle.value = current;
    secretSingle.hidden = false;
    secretMulti.hidden = true;
    toggleVisibility.disabled = false;
    setSingleVisibility(false, false);
    secretSingle.focus();
  }

  toggleVisibility.addEventListener("click", () => {
    if (multilineToggle.checked) return;
    setSingleVisibility(!isSingleVisible, true);
  });

  multilineToggle.addEventListener("change", () => {
    setInputMode(multilineToggle.checked);
  });

  const ctx = getContext();
  if (!ctx.requestId || !ctx.metadataSig || !ctx.submitSig) {
    status.textContent = "Invalid link.";
    setEntryEnabled(false, ui);
    return;
  }

  const resolvedApiUrl = ctx.apiUrl || import.meta.env.VITE_SPS_API_URL || "http://localhost:3100";

  const metadataRes = await fetch(`${resolvedApiUrl}/api/v2/secret/metadata/${ctx.requestId}?sig=${encodeURIComponent(ctx.metadataSig)}`);
  if (!metadataRes.ok) {
    status.textContent = "Request expired or invalid.";
    setEntryEnabled(false, ui);
    return;
  }

  const metadata = await metadataRes.json();
  code.textContent = metadata.confirmation_code;
  status.textContent = "Enter your secret and submit. Single-line entries are masked by default.";
  setEntryEnabled(true, ui);
  setSingleVisibility(false, false);
  setInputMode(false);

  submitButton.addEventListener("click", async () => {
    const secretValue = currentSecretValue();
    if (!secretValue) {
      status.textContent = "Secret cannot be empty.";
      return;
    }

    submitButton.disabled = true;
    status.textContent = "Encrypting...";

    try {
      const payload = await sealBase64(metadata.public_key, secretValue);
      const submitRes = await fetch(`${resolvedApiUrl}/api/v2/secret/submit/${ctx.requestId}?sig=${encodeURIComponent(ctx.submitSig)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (submitRes.ok) {
        isSuccess = true;
        status.textContent = "Secret submitted successfully. You may safely close this window.";
        status.style.color = "#4ade80"; // Success color
        secretSingle.style.display = "none";
        secretMulti.style.display = "none";
        secretControls.style.display = "none";
        submitButton.style.display = "none";
        if (secretLabel) secretLabel.style.display = "none";
        clearAutoHideTimer();
        return;
      }

      if (submitRes.status === 403) {
        status.textContent = "Link signature is invalid.";
      } else if (submitRes.status === 409) {
        status.textContent = "This request already has a submitted secret.";
      } else if (submitRes.status === 410) {
        status.textContent = "This request has expired.";
      } else if (submitRes.status === 413) {
        status.textContent = "Secret is too large.";
      } else {
        status.textContent = "Submission failed.";
      }
    } catch {
      status.textContent = "Encryption failed.";
    } finally {
      // Only re-enable if we didn't succeed (so they can try again)
      if (!isSuccess) {
        submitButton.disabled = false;
      }
    }
  });
}

init().catch(() => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Unexpected error.";
  }
});
