import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewHref,
  createPreviewMetadata,
  getBootstrapMode,
  isValidRequestContext,
  parseContext
} from "../src/request-context.js";

test("parseContext reads signed request parameters", () => {
  const ctx = parseContext("?id=req_123&metadata_sig=meta_sig&submit_sig=submit_sig");

  assert.deepEqual(ctx, {
    metadataSig: "meta_sig",
    preview: false,
    requestId: "req_123",
    submitSig: "submit_sig"
  });
});

test("preview mode is enabled from preview query params", () => {
  assert.equal(parseContext("?preview=1").preview, true);
  assert.equal(parseContext("?preview=true").preview, true);
  assert.equal(parseContext("?preview=yes").preview, true);
  assert.equal(parseContext("?preview=on").preview, true);
  assert.equal(parseContext("?test=1").preview, true);
  assert.equal(getBootstrapMode(parseContext("?preview=1")), "preview");
  assert.equal(isValidRequestContext(parseContext("?preview=1")), false);
});

test("signed request context wins over preview fallback", () => {
  const ctx = parseContext("?id=req_123&metadata_sig=meta_sig&submit_sig=submit_sig&preview=1");

  assert.equal(isValidRequestContext(ctx), true);
  assert.equal(getBootstrapMode(ctx), "request");
});

test("buildPreviewHref strips signed session params and unsafe api overrides", () => {
  const href = buildPreviewHref(
    "?id=req_123&metadata_sig=meta_sig&submit_sig=submit_sig&api_url=http%3A%2F%2Flocalhost%3A3100",
    "/secret"
  );

  assert.equal(href, "/secret?preview=1");
});

test("createPreviewMetadata returns a stable local QA payload", () => {
  assert.deepEqual(createPreviewMetadata(), {
    confirmation_code: "LOCAL-QA",
    description: "Local browser-ui preview",
    preview: true
  });
});
