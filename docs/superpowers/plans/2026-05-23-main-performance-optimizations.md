# Main Performance Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Hive v1.4.0's always-on polling cost, marketplace bundle/runtime cost, and large-list rendering overhead without changing user-visible workflows.

**Architecture:** Keep behavior identical and make optimizations at module boundaries: poll only what the UI needs, split heavy marketplace code until the user asks for it, cache read-only vendor data on the server, and avoid full-tree work for small counters. Each task has focused tests and build-size verification.

**Tech Stack:** React 19, Vite dynamic imports, Node 22 server routes, Vitest, Testing Library, TypeScript.

---

## File Structure

- Modify `web/src/AppInner.tsx`: pass active workspace information into worker polling and use a lightweight open-task counter.
- Modify `web/src/useWorkspaceWorkers.ts`: support active-workspace-first polling, slower background refresh, and stable map updates.
- Modify `web/src/worker/AddWorkerDialog.tsx`: lazy-load marketplace drawer only when opened.
- Modify `web/src/marketplace/MarketplaceDrawer.tsx`: defer search input, precompute searchable fields, reduce unnecessary card re-renders.
- Modify `web/src/marketplace/MarketplaceAgentCard.tsx`: memoize card rendering and use a stable select callback contract.
- Modify `src/server/marketplace-store.ts`: cache manifests and parsed agent details by vendor root/language/path.
- Modify `web/src/tasks/task-markdown.ts`: add a lightweight open root task counter.
- Modify `web/src/tasks/TaskGraphDrawer.tsx`: compute task summary in one traversal and avoid repeated flatten/filter passes.
- Modify `web/src/terminal/TerminalView.tsx`: narrow terminal portal target lookup away from global `[id]` scans.
- Test `tests/web/app-shell.test.tsx`, `tests/web/marketplace-drawer.test.tsx`, `tests/web/add-worker-marketplace-import.test.tsx`, `tests/unit/task-markdown.test.ts`, `tests/server/routes-marketplace.test.ts`, and targeted terminal web tests if affected.

## Task 1: Worker Polling Scope

**Files:**
- Modify `web/src/useWorkspaceWorkers.ts`
- Modify `web/src/AppInner.tsx`
- Test `tests/web/use-workspace-workers.test.tsx`
- Test `tests/web/app-shell.test.tsx`

- [x] Update `useWorkspaceWorkers` to accept `{ activeWorkspaceId }` and poll the active workspace at 500ms while refreshing inactive workspaces at a slower interval.
- [x] Track in-flight state, failure count, and last fetch timing per workspace so one failing workspace does not slow down another workspace.
- [x] Prune removed workspace ids from the returned map.
- [x] Keep the existing equality guard so unchanged payloads do not trigger React re-renders.
- [x] Add/adjust tests that verify the active workspace receives immediate worker data, background workspaces are not hammered on the same 500ms loop, switching active workspace fetches it promptly, and removed workspaces are pruned.
- [x] Run `pnpm test -- tests/web/use-workspace-workers.test.tsx tests/web/app-shell.test.tsx`.

## Task 2: Marketplace Bundle Split

**Files:**
- Modify `web/src/worker/AddWorkerDialog.tsx`
- Test `tests/web/add-worker-marketplace-import.test.tsx`

- [x] Replace the static `MarketplaceDrawer` import with `React.lazy`.
- [x] Render the lazy drawer only after the marketplace button has been opened at least once, wrapped in `Suspense` with no disruptive visual fallback.
- [x] Verify opening the add-worker dialog no longer loads marketplace/marked code in the initial add-worker chunk.
- [x] Run `pnpm test -- tests/web/add-worker-marketplace-import.test.tsx` and `pnpm build`.

## Task 3: Marketplace Server Cache

**Files:**
- Modify `src/server/marketplace-store.ts`
- Test `tests/server/routes-marketplace.test.ts`

- [x] Cache parsed manifests by `vendorRoot::language`.
- [x] Cache parsed agent details by `vendorRoot::language::path`.
- [x] Preserve `HIVE_MARKETPLACE_VENDOR_ROOT` test isolation by including the resolved vendor root in the cache key.
- [x] Keep path traversal and file type checks before reading uncached agent files.
- [x] Add tests that prove repeated reads use cache while a different vendor root stays isolated.
- [x] Run `pnpm test -- tests/server/routes-marketplace.test.ts`.

## Task 4: Task Markdown Counter And Summary

**Files:**
- Modify `web/src/tasks/task-markdown.ts`
- Modify `web/src/tasks/TaskGraphDrawer.tsx`
- Modify `web/src/AppInner.tsx`
- Test `tests/unit/task-markdown.test.ts`

- [x] Add `countOpenRootTasks(content)` for the topbar badge so closed task drawer state does not build a full parsed task tree.
- [x] Preserve current root-task semantics: roots are tasks with no parsed parent, not just tasks with zero indentation.
- [x] Replace `flattenTasks(...).filter(...)` summary with one traversal that returns totals, completed count, open roots, and done roots.
- [x] Keep existing markdown parser semantics unchanged.
- [x] Run `pnpm test -- tests/unit/task-markdown.test.ts`.

## Task 5: Marketplace Search And List Rendering

**Files:**
- Modify `web/src/marketplace/MarketplaceDrawer.tsx`
- Modify `web/src/marketplace/MarketplaceAgentCard.tsx`
- Test `tests/web/marketplace-drawer.test.tsx`

- [x] Memoize `MarketplaceAgentCard` because most cards only change when selection/imported state changes.
- [x] Replace inline per-card `onSelect={() => ...}` with a stable handler contract such as `onSelectPath(agent.path)`.
- [x] Use `useDeferredValue` for the search query so typing stays responsive while the list filters.
- [x] Precompute a lowercase search index once per manifest instead of lowercasing names/descriptions on every keystroke.
- [x] Keep category selection and import behavior identical.
- [x] Run `pnpm test -- tests/web/marketplace-drawer.test.tsx`.

## Task 6: Terminal Portal Lookup

**Files:**
- Modify `web/src/terminal/TerminalView.tsx`
- Test `tests/web/terminal-view.test.tsx` if present, otherwise affected app-shell terminal tests.

- [x] Replace `document.querySelectorAll('[id]')` with a narrow lookup that only scans known terminal slot ids.
- [x] Preserve the "last matching slot wins" behavior needed during duplicate transition windows.
- [x] Keep parking-lot behavior and visible resize dispatch unchanged.
- [x] Add a test with many unrelated id nodes to prove lookup ignores them while preserving duplicate-slot behavior.
- [x] Run the terminal-related web tests.

## Task 7: Verification And Review

**Files:**
- No new source files unless tests require helpers.

- [x] Run targeted test files after each task.
- [x] Run `pnpm build` and record chunk deltas, especially `AddWorkerDialog`.
- [x] Run `pnpm test` if targeted tests are green and runtime permits.
- [x] Ask a subagent to review the final diff for behavioral regressions and missed tests.
