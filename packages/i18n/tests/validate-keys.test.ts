import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTranslationDrift, type JsonObj } from "../scripts/validation-lib.js";

test("flags copied English namespaces as suspiciously untranslated", () => {
  const reference: JsonObj = {
    hero: {
      title: "Public offers and guest requests",
      body: "Inspect payment state, approval backlog, and live fulfillment."
    },
    actions: {
      refresh: "Refresh",
      revoke: "Revoke intent",
      retry: "Retry delivery"
    }
  };

  const result = analyzeTranslationDrift(reference, reference);

  assert.equal(result.comparableStrings, 5);
  assert.equal(result.identicalKeys.length, 5);
  assert.equal(result.suspicious, true);
});

test("ignores identical technical tokens while comparing locale drift", () => {
  const reference: JsonObj = {
    crypto: {
      hpke: "HPKE",
      preview: "JSON",
      endpoint: "https://example.test/docs",
      alias: "agent-blindpass"
    },
    hero: {
      title: "Workspace policy editor"
    }
  };

  const target: JsonObj = {
    crypto: {
      hpke: "HPKE",
      preview: "JSON",
      endpoint: "https://example.test/docs",
      alias: "agent-blindpass"
    },
    hero: {
      title: "Trinh chinh sua chinh sach khong gian lam viec"
    }
  };

  const result = analyzeTranslationDrift(reference, target);

  assert.equal(result.comparableStrings, 1);
  assert.deepEqual(result.identicalKeys, []);
  assert.equal(result.suspicious, false);
});

test("reports small identical drift without failing the namespace", () => {
  const reference: JsonObj = {
    actions: {
      refresh: "Refresh",
      save: "Save policy",
      retry: "Retry delivery",
      reject: "Reject intent",
      approve: "Approve intent"
    }
  };

  const target: JsonObj = {
    actions: {
      refresh: "Lam moi",
      save: "Save policy",
      retry: "Thu giao lai",
      reject: "Reject intent",
      approve: "Chap thuan y dinh"
    }
  };

  const result = analyzeTranslationDrift(reference, target);

  assert.equal(result.comparableStrings, 5);
  assert.deepEqual(result.identicalKeys, ["actions.reject", "actions.save"]);
  assert.equal(result.suspicious, false);
});
