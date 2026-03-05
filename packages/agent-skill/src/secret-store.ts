export class SecretStore {
  private readonly store = new Map<string, Buffer>();

  storeSecret(name: string, value: Buffer): void {
    this.store.set(name, Buffer.from(value));
  }

  get(name: string): Buffer | null {
    const value = this.store.get(name);
    return value ? Buffer.from(value) : null;
  }

  dispose(name: string): void {
    const value = this.store.get(name);
    if (value) {
      value.fill(0);
      this.store.delete(name);
    }
  }

  disposeAll(): void {
    for (const [name, value] of this.store.entries()) {
      value.fill(0);
      this.store.delete(name);
    }
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}
