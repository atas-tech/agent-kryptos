import assert from "node:assert/strict";
import test from "node:test";
import { enforceTopLevelWindow } from "../src/frame-guard.js";

function createDocument() {
  const body = {
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
    }
  };

  return {
    body,
    readyState: "complete",
    createElement(tagName) {
      return { tagName, textContent: "" };
    },
    addEventListener() {}
  };
}

test("allows top-level browsing contexts", () => {
  const win = {
    location: { href: "https://blindpass.example/secret" }
  };
  win.self = win;
  win.top = win;

  assert.equal(enforceTopLevelWindow(win, createDocument()), false);
});

test("tries to bust out of a frame", () => {
  const topWindow = { location: { href: "https://attacker.example/frame" } };
  const win = {
    self: {},
    top: topWindow,
    location: { href: "https://blindpass.example/secret" }
  };

  assert.equal(enforceTopLevelWindow(win, createDocument()), true);
  assert.equal(topWindow.location.href, "https://blindpass.example/secret");
});

test("renders a blocking message if top navigation is not allowed", () => {
  const doc = createDocument();
  const topLocation = {};
  Object.defineProperty(topLocation, "href", {
    configurable: true,
    set() {
      throw new Error("blocked");
    }
  });

  const win = {
    self: {},
    top: { location: topLocation },
    location: { href: "https://blindpass.example/secret" }
  };

  assert.equal(enforceTopLevelWindow(win, doc), true);
  assert.equal(doc.body.children.length, 1);
  assert.equal(doc.body.children[0].textContent, "This page cannot be embedded in another site.");
});
