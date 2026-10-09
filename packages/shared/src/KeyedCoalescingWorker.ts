/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `drainKey()` resolves only when that key has
 * no queued, pending, or active work left.
 * A value whose processing fails is retained per key and merged into the next work for that key, or retried with `retryFailed`; it is not dropped.
 *
 * @module KeyedCoalescingWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
  /** Re-run a value retained after a failure, once. No-op when nothing is retained or newer work is pending
   *  (the next take merges the retained value into that work). */
  readonly retryFailed: (key: K) => Effect.Effect<void>;
}

interface KeyedCoalescingWorkerState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
  readonly failedByKey: Map<K, V>;
}

export const makeKeyedCoalescingWorker = <K, V, E, R>(options: {
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedCoalescingWorkerState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
      failedByKey: new Map(),
    });

    const retainFailed = (key: K, value: V): Effect.Effect<void> =>
      TxRef.update(stateRef, (state) => {
        const failedByKey = new Map(state.failedByKey);
        const existing = failedByKey.get(key);
        failedByKey.set(key, existing === undefined ? value : options.merge(existing, value));
        return { ...state, failedByKey };
      }).pipe(Effect.tx);

    const processKey = (key: K, value: V): Effect.Effect<void, E, R> =>
      options.process(key, value).pipe(
        Effect.tapCause(() => retainFailed(key, value)),
        Effect.flatMap(() =>
          TxRef.modify(stateRef, (state) => {
            const nextValue = state.latestByKey.get(key);
            if (nextValue === undefined) {
              const activeKeys = new Set(state.activeKeys);
              activeKeys.delete(key);
              return [null, { ...state, activeKeys }] as const;
            }

            const latestByKey = new Map(state.latestByKey);
            latestByKey.delete(key);
            return [nextValue, { ...state, latestByKey }] as const;
          }).pipe(Effect.tx),
        ),
        Effect.flatMap((nextValue) =>
          nextValue === null ? Effect.void : processKey(key, nextValue),
        ),
      );

    const cleanupFailedKey = (key: K): Effect.Effect<void> =>
      TxRef.modify(stateRef, (state) => {
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);

        if (state.latestByKey.has(key) && !state.queuedKeys.has(key)) {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.add(key);
          return [true, { ...state, activeKeys, queuedKeys }] as const;
        }

        return [false, { ...state, activeKeys }] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(queue, key) : Effect.void,
        ),
      );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.delete(key);

          const value = state.latestByKey.get(key);
          if (value === undefined) {
            return [null, { ...state, queuedKeys }] as const;
          }

          const latestByKey = new Map(state.latestByKey);
          latestByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.add(key);
          const failed = state.failedByKey.get(key);
          const merged = failed === undefined ? value : options.merge(failed, value);
          const failedByKey = new Map(state.failedByKey);
          failedByKey.delete(key);

          return [
            { key, value: merged } as const,
            { ...state, latestByKey, queuedKeys, activeKeys, failedByKey },
          ] as const;
        }).pipe(Effect.tx),
      ),
      Effect.flatMap((item) =>
        item === null
          ? Effect.void
          : processKey(item.key, item.value).pipe(
              Effect.catchCause(() => cleanupFailedKey(item.key)),
            ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: KeyedCoalescingWorker<K, V>["enqueue"] = (key, value) =>
      TxRef.modify(stateRef, (state) => {
        const latestByKey = new Map(state.latestByKey);
        const existing = latestByKey.get(key);
        latestByKey.set(key, existing === undefined ? value : options.merge(existing, value));

        if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
          return [false, { ...state, latestByKey }] as const;
        }

        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [true, { ...state, latestByKey, queuedKeys }] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const drainKey: KeyedCoalescingWorker<K, V>["drainKey"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.tap((state) =>
          state.latestByKey.has(key) || state.queuedKeys.has(key) || state.activeKeys.has(key)
            ? Effect.txRetry
            : Effect.void,
        ),
        Effect.asVoid,
        Effect.tx,
      );

    const retryFailed: KeyedCoalescingWorker<K, V>["retryFailed"] = (key) =>
      TxRef.modify(stateRef, (state) => {
        const failed = state.failedByKey.get(key);
        if (
          failed === undefined ||
          state.latestByKey.has(key) ||
          state.queuedKeys.has(key) ||
          state.activeKeys.has(key)
        ) {
          return [false, state] as const;
        }
        const failedByKey = new Map(state.failedByKey);
        failedByKey.delete(key);
        const latestByKey = new Map(state.latestByKey);
        latestByKey.set(key, failed);
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [true, { ...state, failedByKey, latestByKey, queuedKeys }] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    return { enqueue, drainKey, retryFailed } satisfies KeyedCoalescingWorker<K, V>;
  });
