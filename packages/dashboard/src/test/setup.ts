import "@testing-library/jest-dom/vitest";

function createStorage() {
  const storage = new Map<string, string>();

  return {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key)! : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    }
  };
}

Object.defineProperty(window, "localStorage", {
  value: createStorage(),
  configurable: true
});

Object.defineProperty(window, "sessionStorage", {
  value: createStorage(),
  configurable: true
});
