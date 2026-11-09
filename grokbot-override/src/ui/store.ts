import * as React from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((value: T) => T)): void
  subscribe(listener: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (v: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* isolated */
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export function useStore<T>(store: Store<T>): T {
  return React.useSyncExternalStore(store.subscribe, store.get, store.get)
}
