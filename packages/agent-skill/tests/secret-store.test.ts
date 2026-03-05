import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/secret-store.js";

describe("SecretStore", () => {
  it("stores and disposes secrets", () => {
    const store = new SecretStore();
    store.storeSecret("api", Buffer.from("value"));

    const value = store.get("api");
    expect(value?.toString("utf8")).toBe("value");

    store.dispose("api");
    expect(store.get("api")).toBeNull();
    expect(store.toJSON()).toBe("[REDACTED]");
  });
});
