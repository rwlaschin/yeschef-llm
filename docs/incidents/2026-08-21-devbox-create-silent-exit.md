# Devbox create exits 0 without creating a VM

Date captured: 2026-08-21

Scope: local startup/management path only. No VM was started, stopped, or deleted while collecting this evidence, and no GCP resource or `config/devboxes.json` entry was changed.

## Reported reproduction

```text
npm run box:create -- 001 llama3.1:8b
```

The same result was reported for boxes 002 through 004: exit code 0, no useful output, no VM, and no retained startup-state receipt.

## Evidence

1. `package.json` maps `box:create` directly to `node scripts/devbox.js create`.
2. The CLI `create` and `start` handlers await `startDevbox(...)` but discard its returned object. The CLI footer also does not translate `{ ok: false }` into stderr or a non-zero `process.exitCode`.
3. `startDevbox` deliberately converts authentication and ordinary exceptions into structured failure returns. Therefore either failure path can reach normal process completion with no printed error and exit code 0.
4. The command form shown above passes `llama3.1:8b` as a bare fourth argument. `cliStartOpts()` only recognizes `--model=...`; the bare model is silently ignored. This does not explain the missing VM because the registry default is also `llama3.1:8b`, but it is a real command-contract defect.
5. Disabled registry entries are not the blocker. `needName()` calls `box()`, and `box()`/`vmOf()` accept any declared box. The `enabled` field filters PM2's `BOX_NAMES`; it is not checked by the manual `create` path.
6. A read-only ADC token check succeeded at capture time. Authentication is therefore not currently blocked, though an earlier ADC failure would have been rendered silent by item 2.
7. The retained startup state at capture time was `/Users/mac/.yeschef-devbox-startup.json` containing `{}`. The implementation stores all boxes in that one read-modify-write JSON file, catches every read/write error, and has no operation identity. Concurrent starts can overwrite one another's progress or cleanup, and a write failure is invisible.
8. The dashboard reader watches the same single startup JSON file. Its detached starter suppresses stdio, so durable state is the only immediate receipt available to the UI when log shipping is absent or delayed.
9. The existing compute-adapter tests pass for stockout rotation, permission denial, authentication denial, state schema, HTTP model pull, and host synchronization (9/9). New startup-state contract tests currently fail 10/10 because the required per-box, operation-owned state API is not implemented. No production calls are used in those tests.

## Diagnosis

The definite silent-success cause is the CLI boundary: it drops `startDevbox`'s structured failure result and leaves Node's exit status at 0. A failed authentication preflight, permission denial, adapter error, or state error is consequently indistinguishable from success to the operator.

The missing-receipt condition is a separate management defect: startup state is a shared, best-effort JSON file with swallowed I/O errors and unowned read-modify-write updates. It cannot provide a reliable receipt for multiple boxes or overlapping operations. The empty captured file is consistent with cleanup/overwrite, but the historical sequence is insufficient to assign one exact writer after the fact.

Neither disabled registry entries nor L4 capacity explain an immediate silent exit: disabled entries are accepted by the manual CLI, while a capacity search would write hunting progress and take time. The positional model argument is ignored but falls back to the same model in this reproduction.

## Proposed fix scope (not implemented)

- `scripts/devbox.js`
  - Make CLI `create`/`start` print the returned terminal message and set a non-zero exit code when `ok !== true`.
  - Reject unexpected positional arguments or explicitly support the documented positional model form.
  - Give each start an operation ID and use one atomically replaced state file per box; only the owning operation may update, cancel, or clear it.
  - Stop swallowing state-write failures at the CLI boundary; a missing receipt must itself fail visibly.
- `dashboard/server/api/devbox/stream.get.ts`
  - Read and watch the per-box receipt directory, tolerating one partial/corrupt file without hiding the other boxes.
- `scripts/devbox-startup-state.test.js`
  - Cover independent box state, stale-writer rejection, cancellation dominance, bounded files, atomic publication, and corrupt-file isolation.
- Add a CLI contract test covering failure output/exit status and argument parsing.

## Approval boundary

Implementing and testing the local code fix does not require starting a machine. Live VM creation, deletion, GCP mutation, deployment, or registry changes remain outside this diagnosis and require explicit approval.

## Local baseline implemented

After approval, the local startup-management baseline was implemented without contacting the Compute API:

- CLI `create`/`start` now surfaces a structured failure and exits nonzero.
- Both `create 001 llama3.1:8b` and `create 001 --model=llama3.1:8b` select the requested model.
- Each box has its own atomically replaced receipt with an operation owner, so four different boxes no longer overwrite one shared document and stale operations cannot update or clear newer ones.
- The SSE route aggregates and watches the per-box receipt files.

Verification: 22 focused mocked/local tests passed, with zero failures and zero skips. No machine was started and no GCP resource was mutated.

### Stockout wording regression

A subsequent real start exposed another local classification gap: Compute returned `state: STOCKOUT, sub-state: STOCKOUT, resource type: compute`, while `isStockoutError()` recognized only `ZONE_RESOURCE_POOL_EXHAUSTED`. The search therefore treated a recoverable capacity miss as terminal instead of moving to the next declared zone. A failing regression test captured the exact API wording; the classifier now accepts both documented forms. The mocked rotation proof shows `us-west1-a: stockout` followed by creation in `us-west4-a`. The focused classifier and lifecycle suites pass 16/16 with no skips.
