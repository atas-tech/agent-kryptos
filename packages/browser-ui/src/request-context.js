const PREVIEW_FLAGS = new Set(["1", "on", "true", "yes"]);
const PREVIEW_CODE = "LOCAL-QA";

function isPreviewFlag(value) {
  if (typeof value !== "string") return false;
  return PREVIEW_FLAGS.has(value.trim().toLowerCase());
}

export function parseContext(search = "") {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(normalizedSearch);

  return {
    apiUrl: params.get("api_url"),
    metadataSig: params.get("metadata_sig"),
    preview: isPreviewFlag(params.get("preview")) || isPreviewFlag(params.get("test")),
    requestId: params.get("id"),
    submitSig: params.get("submit_sig")
  };
}

export function isValidRequestContext(ctx) {
  return Boolean(ctx?.requestId && ctx?.metadataSig && ctx?.submitSig);
}

export function getBootstrapMode(ctx) {
  if (isValidRequestContext(ctx)) {
    return "request";
  }

  return ctx?.preview ? "preview" : "invalid";
}

export function createPreviewMetadata() {
  return {
    confirmation_code: PREVIEW_CODE,
    description: "Local browser-ui preview",
    preview: true
  };
}

export function buildPreviewHref(search = "", pathname = "/") {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(normalizedSearch);

  params.delete("id");
  params.delete("metadata_sig");
  params.delete("submit_sig");
  params.set("preview", "1");

  const query = params.toString();
  return query ? `${pathname}?${query}` : `${pathname}?preview=1`;
}
