import { sealBase64 } from "/ui/vendor/hpke.js";

function getContext() {
  const id = window.location.pathname.split("/").pop();
  const params = new URLSearchParams(window.location.search);
  return {
    requestId: id,
    metadataSig: params.get("metadata_sig"),
    submitSig: params.get("submit_sig")
  };
}

async function init() {
  const status = document.getElementById("status");
  const code = document.getElementById("code");
  const submitButton = document.getElementById("submit");
  const secretInput = document.getElementById("secret");

  const ctx = getContext();
  if (!ctx.requestId || !ctx.metadataSig || !ctx.submitSig) {
    status.textContent = "Invalid link.";
    submitButton.disabled = true;
    return;
  }

  const metadataRes = await fetch(`/api/v2/secret/metadata/${ctx.requestId}?sig=${encodeURIComponent(ctx.metadataSig)}`);
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
      const submitRes = await fetch(`/api/v2/secret/submit/${ctx.requestId}?sig=${encodeURIComponent(ctx.submitSig)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (submitRes.ok) {
        status.textContent = "Secret submitted.";
        secretInput.value = "";
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
      submitButton.disabled = false;
    }
  });
}

init().catch(() => {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Unexpected error.";
  }
});
