import { sealBase64 } from "./crypto.js";
import "./style.css";

function getContext() {
  const params = new URLSearchParams(window.location.search);
  return {
    requestId: params.get("id"),
    metadataSig: params.get("metadata_sig"),
    submitSig: params.get("submit_sig"),
    apiUrl: params.get("api_url")
  };
}


async function init() {
  const status = document.getElementById("status");
  const code = document.getElementById("code");
  const submitButton = document.getElementById("submit");
  const secretInput = document.getElementById("secret");
  const secretLabel = document.querySelector('label[for="secret"]');

  const ctx = getContext();
  if (!ctx.requestId || !ctx.metadataSig || !ctx.submitSig) {
    status.textContent = "Invalid link.";
    submitButton.disabled = true;
    return;
  }

  const resolvedApiUrl = ctx.apiUrl || import.meta.env.VITE_SPS_API_URL || "http://localhost:3100";

  const metadataRes = await fetch(`${resolvedApiUrl}/api/v2/secret/metadata/${ctx.requestId}?sig=${encodeURIComponent(ctx.metadataSig)}`);
  if (!metadataRes.ok) {
    status.textContent = "Request expired or invalid.";
    submitButton.disabled = true;
    return;
  }

  const metadata = await metadataRes.json();
  code.textContent = metadata.confirmation_code;
  status.textContent = "Enter your secret and submit.";

  submitButton.addEventListener("click", async () => {
    if (!secretInput.value) {
      status.textContent = "Secret cannot be empty.";
      return;
    }

    submitButton.disabled = true;
    status.textContent = "Encrypting...";

    try {
      const payload = await sealBase64(metadata.public_key, secretInput.value);
      const submitRes = await fetch(`${resolvedApiUrl}/api/v2/secret/submit/${ctx.requestId}?sig=${encodeURIComponent(ctx.submitSig)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (submitRes.ok) {
        status.textContent = "Secret submitted successfully. You may safely close this window.";
        status.style.color = "#4ade80"; // Success color
        secretInput.style.display = "none";
        submitButton.style.display = "none";
        if (secretLabel) secretLabel.style.display = "none";
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
      if (status.textContent !== "Secret submitted successfully. You may safely close this window.") {
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
