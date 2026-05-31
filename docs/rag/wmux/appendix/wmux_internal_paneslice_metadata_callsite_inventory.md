---
source_url: https://github.com/openwong2kim/wmux/blob/main/docs/internal/paneSlice-callsite-inventory.md
original_title: paneSlice-callsite-inventory
fetched_at: 2026-05-30T16:00:11.271336+00:00
---

# paneSlice Metadata Callsite Inventory (Phase 0.9)

> **Status:** internal pre-work for Phase 1 M0 (transaction-aware MetadataStore).
> **Scope:** every read/write path that touches `PaneLeaf.metadata` (i.e. `PaneMetadata`).
> **Excludes:** `WorkspaceMetadata`, `Company` metadata, `A2A task.metadata`, `Message` metadata — those are separate stores and the M0 migration does not touch them.
> **Baseline:** v2.8.4 (`main` @ c2fd6c6) on branch `feature/substrate-phase-0`.

Codex 2nd review identified labels / roles / status badges / restore state / pane.list rendering / company/workspace UI as risk surfaces for the M0 paneSlice → mirror migration. This document walks each one and grades the actual coupling level so M0 can size the mirror contract accurately.

---

## TL;DR

**PaneMetadata is structurally a write-mostly, read-by-externals surface.**

- The only **writer in main process** path today is `pane.setMetadata` / `pane.clearMetadata` → renderer hop → `paneSlice` (the bug M0 must fix).
- The only **internal reader** of `paneSlice` metadata fields is `pane.search` (label-substring match, `useRpcBridge.ts:466`) and `pane.list` response shaping (`useRpcBridge.ts:354`, both wire it back outward).
- No React component renders `leaf.metadata.{label,role,status,custom}` for the user — `label`/`role`/`status` are display-vocabulary contract for external tools and the future wmux UI, but no current view subscribes to them.
- Persistence is on the dump path of `SessionManager` (separate slice — out of scope for this inventory beyond noting that M0.F replaces the entry point).

→ **The M0 paneSlice-to-mirror conversion has a very narrow blast radius.** The "labels / roles / status badges / restore state" callsite class flagged by codex is real **as a future contract**, but **not yet wired into the renderer view layer**. M0 can flip the authority to the main process without breaking any user-visible read; the only contracts at risk are wire-shape contracts (pane.list response, pane.search result, events.poll metadata changed event), all of which are owned by the substrate surface and tested at that level.

---

## Write callsites (must be re-pointed at MetadataStore in M0.B/C)

| Callsite | Direction | Notes |
|---|---|---|
| `src/main/pipe/handlers/pane.rpc.ts:141` `pane.setMetadata` | external → main → renderer → store | The authoritative external write entrypoint. `sendToRenderer` is the bug. M0.B replaces with `MetadataStore.set()` direct call. |
| `src/main/pipe/handlers/pane.rpc.ts:172` `pane.clearMetadata` | external → main → renderer → store | Same shape as setMetadata. M0.B replaces. |
| `src/renderer/hooks/useRpcBridge.ts:393` `store.setPaneMetadata(...)` IPC handler | renderer IPC inbound | After M0.C, IPC channel is removed; main writes to MetadataStore directly. paneSlice receives the change as a mirror update via `pane.metadata.changed` event. |
| `src/renderer/hooks/useRpcBridge.ts:429` `store.clearPaneMetadata(...)` IPC handler | renderer IPC inbound | Same. |
| `src/renderer/stores/slices/paneSlice.ts:239` `setPaneMetadata` | renderer-internal | **The current authority.** M0.C removes the write code path entirely (compile-time guard via not exporting the setter from `PaneSlice`). Only the mirror update remains. |
| `src/renderer/stores/slices/paneSlice.ts:287` `clearPaneMetadata` | renderer-internal | Same — remove. |
| ~~`src/renderer/events/publisher.ts:47` `publishPaneMetadataChanged`~~ | renderer → main → EventBus | **Removed** in the M0 follow-up cleanup. After M0.B (persist-then-publish), the main process emits the event directly from `MetadataStore.set()`; M0.D removed the renderer write path so no caller remained. The export was deleted to prevent future contributors from re-introducing a publisher that would race the store's own emit. |

**Risk:** none of these are user-visible UI. The wire-shape contracts (`pane.setMetadata` JSON-RPC params + reply, `pane.metadata.changed` event envelope) are owned by external tooling tests, not view-layer tests.

---

## Read callsites (mirror correctness gates)

These are the paths where a stale paneSlice mirror would cause a substrate contract violation. The M0 design must guarantee these are reconciled within one event tick after a write or after a `droppedCount > 0` resync.

| Callsite | What it reads | Risk if stale |
|---|---|---|
| `src/renderer/hooks/useRpcBridge.ts:354` `pane.list` response builder — `metadata: l.metadata` | reads `PaneLeaf.metadata` for every leaf in the workspace | **High** — `pane.list` is the snapshot envelope external tools use to reconcile after `resync: true`. Stale data here = silent state divergence for the external tool. **M0.D snapshot reconciliation rule fixes this by sourcing `pane.list` from `MetadataStore.snapshot()` instead of paneSlice.** |
| `src/renderer/hooks/useRpcBridge.ts:397` `pane.setMetadata` reply — `metadata: getPaneMetadata(...)` | reads back the freshly-written metadata for the JSON-RPC reply | **Medium** — caller expects to see their own write reflected. After M0.B, this reads from `MetadataStore.get()` directly (no mirror involved). Eliminated. |
| `src/renderer/hooks/useRpcBridge.ts:413` `pane.getMetadata` reply — `metadata: target.metadata` | reads `PaneLeaf.metadata` via direct tree walk | **Medium** — same shape as L397. After M0.B, routed through `MetadataStore.get()`. Eliminated. |
| `src/renderer/hooks/useRpcBridge.ts:466` `pane.search` — `leaf.metadata?.label` for fallback match | reads `PaneMetadata.label` for label-substring match | **Low** — if mirror lags by one event, a pane just renamed via setMetadata might not appear in cross-pane search until the next event tick. User-recoverable (re-search). Acceptable mirror semantics. |
| `src/renderer/stores/slices/paneSlice.ts:251–256` `setPaneMetadata` internal merge — reads `target.metadata.custom` for deep-merge | reads current metadata to compute merged shape | **N/A after M0** — the merge happens in `MetadataStore.set()` on main process; renderer no longer computes it. |
| `src/renderer/stores/slices/paneSlice.ts:277` `getPaneMetadata` | reads `PaneLeaf.metadata` | **Removed** — paneSlice no longer exposes the getter after M0.C. Internal readers either read the mirror directly or call out to main via RPC. Currently zero non-test callers, so the export simply goes away. |
| `src/renderer/stores/slices/paneSlice.ts:283` early-return when target is a branch | type guard, not a read | not affected |

**Open question for M0:** the `MetadataStore.snapshot()` call inside `pane.list` (currently the renderer composes the response from its own tree) — does M0 keep the renderer round-trip for `pane.list` (since the tree shape itself is renderer-owned via paneSlice's branches/sizes/active-pane data) but inject metadata from MetadataStore? Or does M0 also lift pane tree authority? **Provisional answer:** keep tree authority in renderer; inject metadata only. That keeps M0 scoped to metadata + persistence and defers tree authority migration to a separate phase.

---

## Display-vocabulary readers (label / role / status as UI contract)

Codex 2nd review flagged labels / roles / status badges as a risk surface. Grep results for `leaf.metadata.label`, `metadata?.role`, `metadata?.status` across `src/renderer`:

| Surface | Currently renders PaneMetadata? | Notes |
|---|---|---|
| Pane title bars / split headers | No | Pane title comes from `surface` (terminal session metadata), not PaneMetadata. |
| StatusBar (`src/renderer/components/StatusBar/StatusBar.tsx:76`) | No | Reads `WorkspaceMetadata.gitBranch`, not PaneMetadata. |
| MiniSidebar / WorkspaceItem | No | Reads `WorkspaceMetadata.agentName`, `agentStatus`. Not PaneMetadata. |
| AppLayout (`AppLayout.tsx:357`) | No | Reads `WorkspaceMetadata.agentStatus`. Not PaneMetadata. |
| FileTreePanel (`FileTreePanel.tsx:269`) | No | Reads `WorkspaceMetadata.cwd`. Not PaneMetadata. |
| Command palette | No | Pane name comes from `surface` data, not `PaneMetadata.label`. |

**Verdict:** today no React view subscribes to `PaneMetadata.{label,role,status,custom}`. The substrate exposes the surface for external tools; the wmux GUI itself does not yet render it. This means M0's mirror can lag by one event tick without any user-visible regression.

This is a *future* coupling — once a future wmux UI starts rendering `metadata.label` on pane headers (planned for v3.1+), the mirror's eventual-consistency contract becomes user-visible. M0's snapshot reconciliation (`pane.list` after `droppedCount > 0` or `bootId mismatch`) is sized for that future case.

---

## Restore state (M0.F persistence absorption)

| Callsite | Notes |
|---|---|
| `src/main/session/SessionManager.ts` (dump/hydrate) | Currently serializes `PaneLeaf.metadata` as part of the workspace tree via the renderer's session state. M0.F replaces with `MetadataStore.serialize()` / `.hydrate()`. The store becomes the persistence source of truth; SessionManager calls into it. |
| `session.json` schema | Existing dumps have no `version` field on metadata entries. M0.A normalizes missing version → 0; first subsequent set → 1. No migration script needed for v2.x → v3.0. Forward-compat: M0.F adds a `schema_version` envelope to the dump so future migrations have an anchor. |

**Race:** `SessionManager` dump runs on quit and on autosave (separate slice). M0.B's "persist-then-publish" ordering must coordinate with autosave timing — open design item for M0 implementation, not for this inventory.

---

## Tests already at the boundary

- `src/renderer/stores/slices/__tests__/paneSlice.metadata.test.ts` — 19 tests on the current renderer authority. After M0.C, these split: behavioral tests (merge / replace / cap enforcement / workspace scoping) migrate to `MetadataStore` unit tests; mirror tests (event subscription → paneSlice reflects change) stay.
- `src/renderer/stores/slices/__tests__/paneSlice.events.test.ts` — `pane.metadata.changed` event publish on write. After M0.B, this becomes a main-process test (EventBus publish on `MetadataStore.set()`).
- `src/main/pipe/handlers/__tests__/pane.rpc.test.ts` — JSON-RPC handler-level. Untouched by M0 conceptually; setMetadata internals change but the wire contract stays the same (modulo the new `expectedVersion` / `mergeMode` additions, which are separate test cases).
- `src/main/events/__tests__/EventBus.test.ts` — bus invariants. Untouched.

**Net test impact:** ~19 tests migrate slices, plus new tests for `MetadataStore` itself (estimate ~38 per plan budget). No test deletion.

---

## Inputs delivered to M0

This inventory feeds three concrete decisions for the M0 design PR:

1. **Mirror contract surface area is small.** `pane.list` (in `useRpcBridge.ts:354`) is the one read site that must be reconciled atomically with a `MetadataStore.snapshot()` call. Every other read site is either (a) a writer's own reply (eliminated when authority moves) or (b) a fuzzy-search fallback (`pane.search`) where eventual consistency is fine.
2. **Compile-time write protection in paneSlice is feasible** because no non-test caller currently invokes `setPaneMetadata` / `clearPaneMetadata` outside `useRpcBridge`. Removing the setters from the slice's exported interface is a no-op for view code.
3. **No view-layer migration needed.** No React component reads `PaneMetadata.{label,role,status,custom}` today; the mirror's stale-tick window has no user-visible effect at v3.0 ship. Future UI work (v3.1+) will need the snapshot reconciliation contract M0.D establishes, but does not block v3.0.

---

## Open follow-ups (not blocking M0)

- `SessionManager` autosave timing vs. `MetadataStore` persist-then-publish ordering — design item for M0 implementation.
- Whether to lift pane-tree authority (branches/sizes/active-pane) to main process as well — explicitly deferred; M0 keeps tree authority in renderer and lifts only metadata.
- Whether to expose `pane.getMetadata` over JSON-RPC after M0 makes `pane.list` cover the same data — keep it for now (per-pane fetch is cheaper than full list for some external tooling patterns).
