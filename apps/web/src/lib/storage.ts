import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

const legacyStorageKey = (name: string) =>
  name.startsWith("neokod:") ? `t3code:${name.slice("neokod:".length)}` : undefined;

const isPromise = (value: unknown): value is Promise<string | null> =>
  typeof value === "object" && value !== null && "then" in value;

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  const resolvedStorage = isStateStorage(storage) ? storage : createMemoryStorage();
  return {
    getItem: (name) => {
      const current = resolvedStorage.getItem(name);
      const legacyName = legacyStorageKey(name);
      if (!legacyName) {
        return current;
      }
      const migrate = (value: string | null) => {
        if (value !== null) {
          return value;
        }
        const legacy = resolvedStorage.getItem(legacyName);
        const copyForward = (legacyValue: string | null) => {
          if (legacyValue !== null) {
            resolvedStorage.setItem(name, legacyValue);
          }
          return legacyValue;
        };
        return isPromise(legacy) ? legacy.then(copyForward) : copyForward(legacy);
      };
      return isPromise(current) ? current.then(migrate) : migrate(current);
    },
    setItem: (name, value) => resolvedStorage.setItem(name, value),
    removeItem: (name) => resolvedStorage.removeItem(name),
  };
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
