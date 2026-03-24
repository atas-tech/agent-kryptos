import { describe, expect, it } from "vitest";
import { enforceTopLevelWindow } from "../security/frame-guard.js";

const bodyState: { children: unknown[] } = { children: [] };

function createDocument(): Document {
  return {
    body: {
      replaceChildren: (...nodes: unknown[]) => {
        bodyState.children = nodes;
      }
    } as unknown as HTMLBodyElement,
    createElement: (tagName: string) => ({ tagName, textContent: "" }) as unknown as HTMLElement,
    addEventListener: () => {},
    readyState: "complete"
  } as unknown as Document;
}

describe("frame guard", () => {
  it("allows top-level browsing contexts", () => {
    const win = {} as {
      top: unknown;
      self: unknown;
      location: { href: string };
    };
    win.location = { href: "https://blindpass.example/dashboard" };
    win.self = win;
    win.top = win;

    expect(enforceTopLevelWindow(win as unknown as Window, createDocument())).toBe(false);
  });

  it("tries to bust out of a frame", () => {
    const topWindow = { location: { href: "https://attacker.example/frame" } };
    const win = {
      self: {} as Window,
      top: topWindow as Window,
      location: { href: "https://blindpass.example/dashboard" }
    } as Window;

    expect(enforceTopLevelWindow(win as unknown as Window, createDocument())).toBe(true);
    expect(topWindow.location.href).toBe("https://blindpass.example/dashboard");
  });

  it("renders a blocking message when top navigation is blocked", () => {
    bodyState.children = [];
    const topLocation = {};
    Object.defineProperty(topLocation, "href", {
      configurable: true,
      set() {
        throw new Error("blocked");
      }
    });

    const win = {
      self: {} as Window,
      top: { location: topLocation } as Window,
      location: { href: "https://blindpass.example/dashboard" }
    } as Window;

    expect(enforceTopLevelWindow(win as unknown as Window, createDocument())).toBe(true);
    expect((bodyState.children[0] as HTMLElement).textContent).toBe("This application cannot be embedded in another site.");
  });
});
