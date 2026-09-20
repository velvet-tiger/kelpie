/**
 * Component tests need a working `localStorage`, and Node 25's experimental
 * webstorage installs a broken empty stub on `globalThis.localStorage` unless
 * `--localstorage-file` is set. The stub shadows happy-dom's own `Storage` on
 * `window`, so anything that reads or writes `localStorage` throws
 * `getItem is not a function`. A small in-memory Storage on `globalThis` is
 * enough for the tests that touch storage (theme, in practice).
 */
class MemoryStorage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  clear(): void {
    this.data.clear()
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
})
