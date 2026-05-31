---
source_url: https://github.com/openwong2kim/wmux/blob/main/docs/internal/m0-design.md
original_title: m0-design
fetched_at: 2026-05-30T16:00:11.256377+00:00
---

# M0 — Transaction-aware MetadataStore Design

> **Status:** Phase 1 design doc, pre-implementation. Reviewed against `paneSlice-callsite-inventory.md`, `docs/PROTOCOL.md` §1, and the 2nd Codex eng-review findings.
> **Scope:** the integrated metadata authority migration. M0.A + M0.B + M0.C + M0.D + M0.E + M0.F — all six sub-items ship together, because splitting them lets M5 (persistence) undo M0 (transaction) assumptions.
> **Out of scope:** the broader pane-tree authority migration (branches, sizes, active-pane). M0 lifts metadata only and explicitly keeps tree authority in `paneSlice`.
> **Target release:** v2.9.0. Six weeks (Plan Week 3–8).

---

## 0. Why M0 is one unit, not six

The 2nd Codex review surfaced this. The naive split into M0 (authority migration), M1 (`expectedVersion`), M2 (`mergeMode`), and M5 (persistence) looks reasonable on a roadmap but breaks at the transaction boundary.

- **`mergeMode` + `version` are one decision.** The version is incremented based on the post-merge shape. Computing the merge in the renderer and the version in main (M0+M2 split) introduces a window where the two can diverge.
- **`expectedVersion` + persistence are one decision.** A successful concurrency check must persist before it's visible to other clients (otherwise a crash between check-pass and persist makes the "winning" write disappear). M0+M5 split makes this impossible to enforce cleanly.
- **Snapshot reconciliation depends on a single source of truth.** `pane.list` returning a consistent `{ asOfSeq, bootId, metadata-per-pane }` snapshot requires that `metadata` and `seq` come from the same store at the same instant. With paneSlice as the metadata authority and EventBus in main, you can't take an atomic snapshot.

Conclusion: M0 is the *whole* transaction-aware MetadataStore. The wire-format additions (`expectedVersion`, `mergeMode`, `version` echo, snapshot envelope) ride on top of the same single PR.

---

## 1. Inputs

| Source | What it constrains |
|---|---|
| `docs/internal/paneSlice-callsite-inventory.md` | The mirror has a narrow blast radius. No React component reads `PaneMetadata.{label,role,status,custom}` today. Stale-tick window has no user-visible effect at v3.0 ship. |
| `docs/PROTOCOL.md` §1 | Wire contract: layered status, mergeMode three values, version monotonic, `VERSION_CONFLICT` JSON-RPC `-32001`. Backwards compat: legacy `merge: boolean` preserved. |
| `docs/PROTOCOL.md` §2 | Event bus contract: cursor opaque, `bootId` invalidation, `droppedCount`+`resync` semantics, cross-producer ordering caveat. |
| `docs/PROTOCOL.md` §3 | `pane.list` snapshot envelope: `{ asOfSeq, bootId, panes[*].{metadata, version} }`. |
| Codex 2nd review (NOT CLEARED → user-delegated full acceptance) | All 6 race specs must be in the design doc + 8 verification gates + 4-week → 6-week Phase 1 budget. |

---

## 2. `MetadataStore` API

Lives in `src/main/metadata/MetadataStore.ts`. Module-level singleton, main process only.

```typescript
import type { PaneMetadata } from '../../shared/types';

export type MergeMode = 'merge' | 'replace' | 'replaceShared';

export interface SetOptions {
  mergeMode?: MergeMode;        // default: 'merge'
  expectedVersion?: number;     // omitted ⇒ no concurrency check
}

export type SetResult =
  | { ok: true; version: number; metadata: PaneMetadata }
  | { ok: false; error: 'VERSION_CONFLICT'; currentVersion: number };

export interface MetadataEntry {
  metadata: PaneMetadata;
  version: number;              // 0 = never set; first set ⇒ 1
}

export interface Snapshot {
  asOfSeq: number;              // EventBus.latestSeq() at snapshot moment
  bootId: string;               // EventBus.bootId
  entries: Array<{ paneId: string; metadata: PaneMetadata; version: number }>;
}

export interface PersistedShape {
  schema_version: 1;            // bump for future migrations
  entries: Array<{
    paneId: string;
    workspaceId: string;
    metadata: PaneMetadata;
    version: number;
  }>;
}

export class MetadataStore {
  // === CRUD ===
  get(paneId: string): MetadataEntry;
    // Always returns. Empty pane ⇒ { metadata: {}, version: 0 }.

  set(
    paneId: string,
    patch: Partial<PaneMetadata>,
    opts?: SetOptions,
  ): SetResult;
    // Synchronous critical section:
    //   1. Validate patch (size, char limits) → reject if invalid (throws, no version bump).
    //   2. Concurrency check: if expectedVersion provided && current.version !== expectedVersion
    //      → return { ok: false, error: 'VERSION_CONFLICT', currentVersion }. No mutation.
    //   3. Compute merged shape per mergeMode.
    //   4. Increment version on the merged shape.
    //   5. Stage the new entry (not yet persisted, not yet published).
    //   6. Persist via SessionManager (atomic write).
    //   7. Commit the staged entry in-memory.
    //   8. Publish `pane.metadata.changed` event via EventBus.
    //   9. Return { ok: true, version, metadata }.
    //
    // If step 6 fails, the entry is NOT committed, NOT published. Caller sees a throw.

  clear(paneId: string): SetResult;
    // Same flow as set(paneId, {}, { mergeMode: 'replace' }) but the metadata
    // field on the resulting event is `{}` (empty), and version still increments.

  // === Snapshot ===
  snapshot(): Snapshot;
    // Synchronous. Reads the current in-memory store. asOfSeq = EventBus.latestSeq()
    // at the same instant — captured atomically before any subsequent set() can
    // increment seq. (Single-threaded JS = serialization guarantee.)

  // === Persistence ===
  hydrate(serialized: PersistedShape): void;
    // Called on app boot after SessionManager loads session.json.
    // Drops any in-memory entries; rebuilds from serialized.
    // schema_version mismatch ⇒ migrate() before rebuild.

  serialize(): PersistedShape;
    // Called on session dump. Returns the full store.

  migrate(input: PersistedShape, toVersion: 1): PersistedShape;
    // Phase 1 ships at schema_version 1. Migration table grows in v3.1+.

  // === Lifecycle ===
  onPaneDeleted(paneId: string): void;
    // Removes the entry, emits a `pane.metadata.changed` event with
    // `{ metadata: {}, version: <bumped> }` so subscribers can drop their
    // mirror entry. (Bumping version on delete prevents pane-id-recycle
    // confusion — see Race #4.)
}

export const metadataStore: MetadataStore;  // module-level singleton
```

**Invariants:**

- `version` is monotonic per pane. Never decreases. Never skips.
- `version = 0` ⇒ no metadata ever set on this pane.
- After `set()` returns `{ ok: true, version: V }`, subsequent `get(paneId).version === V` is guaranteed (synchronous).
- After `set()` returns `{ ok: true }`, the event was already published. Subscribers may receive it before, during, or after `set()` returns to the caller, but never *more than one* tick later.
- `snapshot().asOfSeq` is the EventBus seq at the moment the snapshot's in-memory read happened. Any event with `seq > asOfSeq` was emitted after the snapshot was taken; clients reconciling via the snapshot drain events with `seq > asOfSeq` to catch up.

---

## 3. Mutation flow: persist-then-publish

```
Caller                  MetadataStore           SessionManager      EventBus
  |                         |                         |                |
  |--- set(paneId, patch) ->|                         |                |
  |                         |--- validate, concurrency-check          |
  |                         |--- compute merged shape                  |
  |                         |--- compute new version                   |
  |                         |--- persist(serialized) ----------------->|
  |                         |<------------ atomic write ok ------------|
  |                         |--- commit in-memory                     |
  |                         |--- emit(pane.metadata.changed) -------------------->|
  |<-- { ok, version, ... } |                                                       |
```

**Why persist before publish?**

If we publish first, a subscriber can act on the event before the write is durable. A crash in between (after publish, before persist completes) means the subscriber acted on data that doesn't survive restart — silent state divergence.

Persist-then-publish guarantees that anyone who sees the event sees it because the write is durable. A crash after persist but before publish loses the event (no client sees it), but the data is on disk and the next `pane.list` snapshot reflects it; clients reconcile via the standard `bootId`/`resync` path.

**Why is this synchronous?**

Single-threaded JS gives us natural serialization across `set()` calls. Two concurrent `set()`s for the same pane queue at the JS event loop boundary — there's no preemption. The synchronous flow above is the entire critical section; no `await`s inside steps 1–8.

`SessionManager.persist()` does involve a disk write, but it's done with the synchronous `secureWriteTokenFile`-style atomic rename pattern (the same pattern used for the pipe token). Disk I/O happens, but inside the same JS task. No other `set()` can interleave.

If `persist()` becomes async in the future (e.g. moves to a worker thread for performance), the flow gains a microtask boundary at step 6 → 7. The design must then add a per-pane lock to prevent two `set()`s from racing across that boundary. This is the only place where the "single-threaded JS = automatic serialization" assumption is load-bearing.

---

## 4. Race specifications

All six races identified by the 2nd Codex review. Each has a design answer here and a corresponding test in §6.

### Race #1: publish-vs-persist ordering

**Scenario:** crash between commit-in-memory and persist completion.

**Resolution:** persist before commit (step 6 in §3 happens before step 7). If persist throws, the in-memory commit doesn't happen, the event doesn't fire, and the caller sees a throw. From the caller's perspective the write didn't happen. From any subscriber's perspective the event never fired. From disk's perspective the previous value is intact.

If crash happens *between* persist completing and the in-memory commit (extremely narrow window, single-process synchronous code), restart hydrates from the persisted value — which is the *new* value. Subscribers don't see an event for it but the next `bootId`-mismatch recovery sweeps it in.

Trade-off: the narrow crash window can lose an event without losing data. Acceptable; clients have the `bootId` recovery primitive for exactly this.

### Race #2: setMetadata return value vs event delivery

**Scenario:** the caller of `set()` is also subscribed to `pane.metadata.changed` events. Could the event arrive before `set()` returns, or after, or both?

**Resolution:** `set()` return value carries the same `version` as the event. Order doesn't matter — both are idempotent given the version. Subscribers that maintain a `lastSeenVersion` per pane discard events with `version <= lastSeen`.

Both the return value and the event are emitted from the same synchronous critical section, so they have the same total ordering across all observers. The only ambiguity is which arrives at a *given* observer first; the contract is "both refer to the same write, both are idempotent."

### Race #3: renderer initial hydration race with events

**Scenario:** the renderer mounts and subscribes to `pane.metadata.changed`. Between subscription and the first `pane.list` snapshot fetch, events fire. The renderer might miss them, or double-apply them (apply once via event, again via snapshot).

**Resolution:** the renderer's mount sequence is:

1. Subscribe to `events.poll` with `cursor: 0` (queue events as they arrive; don't apply yet).
2. Call `pane.list` → receive `{ asOfSeq, bootId, panes }`. Apply the snapshot to paneSlice (mirror).
3. Apply queued events with `seq > asOfSeq` only. Discard events with `seq <= asOfSeq` (already in snapshot).
4. Resume normal poll loop from `cursor: asOfSeq`.

This is the standard snapshot+catchup pattern. The `asOfSeq` watermark is the join point.

### Race #4: pane delete/recreate with same/recycled ID

**Scenario:** pane `p-7` is closed (metadata cleared), then a new pane is created and happens to get id `p-7`. A subscriber that was tracking `p-7`'s metadata might confuse the two.

**Resolution:** `MetadataStore.onPaneDeleted(paneId)` increments the version on the deleted entry's slot to `version+1` before clearing it, and emits a `pane.metadata.changed` event with empty metadata + the bumped version. The bumped version makes "delete" visible to subscribers as a normal version transition.

When a new pane is created with a recycled id, its first metadata write starts at the deleted entry's last-known version + 1 (the store keeps the version counter across the delete; only the metadata clears). Subscribers tracking by version see strict monotonicity and don't get fooled.

In practice, wmux's `paneId` generator (`generateId('pane')`) uses randomized UUIDs, so recycling is exceedingly unlikely. But the version contract handles it correctly regardless.

### Race #5: concurrent writes from MCP / pipe RPC / renderer-UI bridge

**Scenario:** three sources of write — external MCP via `pane.setMetadata`, internal pipe RPC, renderer-initiated UI action (future). All target the same pane.

**Resolution:** all three paths enter `MetadataStore.set()` at the main-process entry point. Single-threaded JS serializes them at the JS task boundary. There's no preemption, so no two `set()` calls overlap.

`expectedVersion` is the coordination primitive for callers that care about ordering. Without it, last-writer-wins applies, which is the v2.x behavior preserved.

### Race #6: feedback loop (mirror update triggers a write)

**Scenario:** paneSlice receives a `pane.metadata.changed` event, updates its mirror, and a subscriber to paneSlice (e.g. a React component) triggers a write back to main. This write produces another event, which updates the mirror again, which triggers another write…

**Resolution:** compile-time protection. paneSlice's exported interface does NOT include `setPaneMetadata` or `clearPaneMetadata` after M0.C. The only API on paneSlice's shape is a mirror-update internal method, not exported on the slice's TypeScript type.

React components or other renderer code wanting to write metadata must go through the RPC bridge (`useRpcBridge`), which calls `pane.setMetadata` over the pipe → main process → `MetadataStore`. The renderer never writes paneSlice's metadata directly.

This is enforced at compile time via the TypeScript interface, not at runtime. A bug that adds a back door (e.g. exporting the setter) is caught by the type checker before tests run.

---

## 5. Wire-format additions (v3.0)

All additive, all backwards-compatible. Documented in `docs/PROTOCOL.md` §1; this section enumerates them for implementation.

### `pane.setMetadata` params (v3.0)

```jsonc
{
  "paneId": "p-1",                    // existing
  "workspaceId": "ws-1",              // existing
  "label": "Backend",                 // existing (any of label/role/status/custom optional)
  "role": "service",
  "status": "running",
  "custom": { "orchestrator.taskId": "T-42" },

  "mergeMode": "merge",               // NEW: 'merge' | 'replace' | 'replaceShared'
                                      //      omitted ⇒ defaults to 'merge'
  "merge": true,                      // legacy: equivalent to mergeMode (rejected if both present)
  "expectedVersion": 7                // NEW: opt-in optimistic concurrency
}
```

### `pane.setMetadata` reply (v3.0)

```jsonc
// Success
{ "ok": true, "paneId": "p-1", "version": 8, "metadata": { /* full merged shape */ } }

// Version conflict (JSON-RPC error)
// id: <req-id>
// error: { code: -32001, message: "VERSION_CONFLICT", data: { currentVersion: 11 } }
```

### `pane.metadata.changed` event (v3.0)

```jsonc
{
  "seq": 412,
  "ts": 1715500000000,
  "type": "pane.metadata.changed",
  "workspaceId": "ws-1",
  "paneId": "p-1",
  "metadata": { /* PaneMetadata */ },
  "version": 8                       // NEW
}
```

### `pane.list` per-pane entry (v3.0)

```jsonc
{
  "id": "p-1",
  "type": "leaf",
  "surfaces": [ /* ... */ ],
  "activeSurfaceId": "s-1",
  "metadata": { /* PaneMetadata */ },
  "version": 8                       // NEW: per-pane metadata version
}
```

### `system.capabilities` feature flag (v3.0)

```jsonc
{
  "methods": [/* ... */],
  "features": {
    "paneMetadata": {                // CHANGED: was `true`, now object
      "optimisticConcurrency": true,
      "mergeModes": ["merge", "replace", "replaceShared"]
    },
    "events": { /* unchanged */ }
  }
}
```

Old clients that read `features.paneMetadata` as a boolean see truthy (`{ ... }` is truthy). New clients feature-detect by key presence.

---

## 6. Test budget — 38 new tests

Aligned with the plan's per-module breakdown.

### M0.A — MetadataStore CRUD + version (5)

- `get` on empty pane returns `{ metadata: {}, version: 0 }`.
- `set` first time bumps version 0 → 1.
- `clear` bumps version + emits event with empty metadata.
- `snapshot` returns all entries with their current `{ metadata, version }`.
- `onPaneDeleted` bumps version, emits empty-metadata event, then removes entry on next `get`.

### M0.A — mergeMode + version transaction (4)

- `mergeMode: 'merge'` patches top-level + deep-merges `custom` one level.
- `mergeMode: 'replace'` overwrites the entire metadata, including `custom`.
- `mergeMode: 'replaceShared'` replaces top-level shared fields but preserves `custom`.
- After any mergeMode, version is bumped on the **post-merge** shape (not patch input).

### M0.A — optimistic concurrency (5)

- `set` without `expectedVersion`: always commits, returns new version.
- `set` with matching `expectedVersion`: commits, returns new version.
- `set` with mismatched `expectedVersion`: returns `VERSION_CONFLICT` + `currentVersion`. No mutation. No event.
- `set` with `expectedVersion: 0` on empty pane: commits as first write.
- `set` reply always echoes `version`; subsequent `get` returns the same.

### M0.B — persist-then-publish ordering (1)

- `SessionManager.persist` throws → in-memory state unchanged, no event published, caller sees throw.

### M0.B — return vs event idempotence (1)

- Subscriber receives event with same version as the `set` reply; applying both yields identical state.

### M0.C — paneSlice direct write protection (1)

- TypeScript type-check fails when consuming code tries to call `paneSlice.setPaneMetadata` (compile-time guard, verified via `tsc --noEmit` test harness).

### M0.D — snapshot reconciliation (2)

- Ring overflow burst → `droppedCount > 0` → client calls `pane.list` → state matches store.
- `bootId` mismatch → client forced full rehydrate → cached pane ids cleared first.

### M0.E — 6 race specs (6)

One test per race in §4. Each test reproduces the scenario and verifies the design's resolution.

### M0.F — persistence (4)

- Session.json with no `version` field on entries loads cleanly (normalized to 0).
- Session.json with no `schema_version` envelope is treated as schema v1.
- `migrate(input, 1)` is a smoke pass-through; throws on unknown schema.
- Crash window: persist-completed entries hydrate after restart; pre-persist entries don't.

### Critical regression — backwards compat (1)

- v2.8.x client sending `merge: false` (boolean) gets `mergeMode: 'replace'` semantics — full overwrite.

### Codex 2nd review — 8 additional verification gates (8)

- Ring overflow burst → automatic resync via `pane.list`.
- Renderer late mount → applies snapshot then events with `seq > asOfSeq`; no double-apply.
- Session restore + immediate write → version starts at restored value, not 0.
- v2.8 session.json + v2.8 `merge: false` client → still works after upgrade.
- Direct preload write attempt → compile error (caught by §6 §M0.C test).
- Burst write event ordering → events arrive in version-monotonic order per pane.
- Persistence crash window → after restart, store reflects last successful persist.
- `pane.list` snapshot ≡ `MetadataStore` state (no stale renderer mirror leakage).

### Pipe token security (2 — eng-review A2)

- `secureWriteTokenFile` ACL: file is owner-readable, group/others denied.
- Other-user read attempt: rejected at OS level.

---

## 7. PR sequence

The M0 PR is large but coherent. Recommended split for review hygiene:

| PR | Scope | LOC estimate | Risk |
|---|---|---|---|
| **M0-a** | `MetadataStore.ts` neuk + unit tests + `PersistedShape` type. No call sites changed yet. | ~600 LOC + 22 tests | Low. Isolated module. |
| **M0-b** | Rewrite `pane.rpc.ts` handlers to call `MetadataStore` directly. `sendToRenderer` removed for the 3 metadata methods. paneSlice still writes (parallel path); the rewrite emits events from main. | ~150 LOC | Medium. Race window during parallel path — gated by feature flag. |
| **M0-c** | Snapshot reconciliation in `pane.list`. `MetadataStore.snapshot()` integration. | ~80 LOC + 2 tests | Low. |
| **M0-d** | paneSlice mirror-only conversion. Remove `setPaneMetadata` / `clearPaneMetadata` from `PaneSlice` interface. Event-driven mirror update. | ~120 LOC + 1 test | High. Type-check break propagates. |
| **M0-e** | `SessionManager` migration to `MetadataStore.serialize()` / `hydrate()`. v2.x compat tests. | ~100 LOC + 4 tests | Medium. Session-restore regression risk. |
| **M0-f** | Wire-format additions: `mergeMode` param, `expectedVersion` param, `version` in reply + events + `pane.list`. `system.capabilities` feature object. | ~80 LOC + 9 tests | Low. Pure additive. |

Each PR independently lands without breaking master. M0-d is the highest-risk because it changes the renderer write path; landing it after M0-b means main is already authoritative when the renderer loses its write privileges.

Estimate: 6 PRs over 4–5 weeks, leaving 1–2 weeks of buffer for unforeseen rework.

Or one giant PR. Either is defensible — review fatigue vs. risk concentration trade-off. Lean toward the split for the first major substrate migration.

---

## 8. Open questions

These don't block design; they affect implementation tactics.

1. **`SessionManager` autosave timing.** Today autosave runs on a timer + on quit. M0's persist-then-publish ordering assumes synchronous persist inside the `set()` critical section. Does `SessionManager.persist()` already support synchronous write, or does it need a refactor to expose a sync path?

2. **`pane.list` tree composition.** The renderer currently composes `pane.list` because the pane tree (branches, sizes, active-pane) lives in `paneSlice`. After M0, metadata comes from `MetadataStore`; tree still comes from paneSlice. The `pane.list` handler in main has to join the two. Cleanest path: main calls renderer to get the tree shape, then injects `MetadataStore.snapshot()` data into each leaf node before returning. Alternative: also lift tree authority to main — out of scope for M0.

3. **Two-store consistency between `MetadataStore` and `SessionManager`.** If a pane is deleted in `paneSlice` (renderer-initiated), main needs to be told to call `MetadataStore.onPaneDeleted()`. Today there's no such IPC channel. M0-e adds a `pane.deleted` IPC event for this. Question: should it be a JSON-RPC method (call from renderer to main) or an Electron IPC event (one-way)?

4. **Migration ordering.** Existing session.json dumps have metadata embedded in the pane tree (under `PaneLeaf.metadata`). After M0, metadata lives separately in `MetadataStore.serialize()`. The first boot after upgrade needs to read v2.x dumps, extract metadata into `MetadataStore`, and write back the v3.0 dump shape (tree without inline metadata + separate metadata table). Smooth path: `MetadataStore.hydrate()` accepts both shapes (v2.x inline + v3.0 separate) and SessionManager writes only the v3.0 shape going forward.

5. **`MetadataStore.snapshot()` performance under high write load.** Test: 1000 writes/sec for 60 seconds, then a `snapshot()` mid-burst — does it block the main process noticeably? If yes, the snapshot needs to be copy-on-write or use a different read pattern. Profile in M0-c.

---

## 9. Definition of done for M0

- All 38 tests pass.
- TypeScript type-check passes with paneSlice's metadata setters removed from the exported interface.
- Manual dynamic test: 1000 writes/sec for 60 seconds → renderer mirror eventually consistent → `pane.list` snapshot matches store.
- v2.x session.json loads and runs without prompting migration UI.
- v2.x MCP client using `merge: false` continues to work.
- New v3.0 client using `expectedVersion` + `mergeMode` works end-to-end.
- `docs/PROTOCOL.md` §1 updated with any wire-shape refinements discovered during implementation.
- v2.9.0 ship + 1-week regression window with 0 user-reported regressions.

After M0 lands, Phase 1 is complete. Phase 2 (MCP plugin convention) starts in parallel with v2.9.x patch stream (TODOs.md backlog).
