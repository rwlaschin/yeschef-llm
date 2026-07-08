---
modified: 2026-07-07
dependencies: [worker-dispatch, llm-pipeline]
supersedes: null
---

# Generator (cache) worker — tasks

- [ ] Full-stack: Extract the Mongo connection/collection wiring from `worker/index.js` into new `worker/mongo.js` (exposing the four collection handles via a getter/live-binding), `reportToOrchestrator` into new `worker/report.js`, and add `worker/cacheKey.js` with `cacheKey`/`stableString`; repoint `worker/index.js` to import all three, no behavior change to the first two.
- [ ] Test Engineer: Run `npm run test` plus a dev smoke of one canned job through the existing fake worker to confirm the extractions are behavior-preserving.
- [ ] Full-stack: Add `GENERATOR_TOPIC`/`GENERATOR_SUBSCRIPTION`/`GENERATOR_DEAD_LETTER` to `config/models.js`, mirroring the `FAKE_*` block.
- [ ] Full-stack: Add the `[Generator cache]` provisioning block to `pubsub/setup.js`, mirroring `[Fake canned]`.
- [ ] Full-stack: Persist the `cache` flag on the menu path — add `cache:{type:"boolean"}` to `menuSchema` in `functions/entry/ai/schemas.js`, and set `cache: isCache` in both `functions/entry/ai/menu.js` job-doc writes (mirroring `fake`/`isFake`).
- [ ] Full-stack: Edit `functions/entry/ai/dispatch/dispatch.js` to read `job.cache`, route `cache` jobs to `GENERATOR_TOPIC`, and emit `item` + `cache:true` per unit in the published message.
- [ ] Full-stack: Add the `payload.cache` write-through (persisting `clean`, keyed via `worker/cacheKey.js`) inside `worker/index.js`'s `if (wrote)` block; update the "Mongo is RAG-only" comments and the root `CLAUDE.md` DB-table note.
- [ ] Test Engineer: Write `worker/generator.test.js` covering hit, miss (forwards to `payload.model` with `cache:true`), malformed payload, and key derivation (including non-string `item`), against injected fakes, before the worker is implemented.
- [ ] Full-stack: Implement `worker/generator.js` — subscribe, cache lookup via `worker/cacheKey.js`, hit-complete via the admission CAS + extracted report, miss-forward to `payload.model`; ensure the `canned_responses` collection and unique `{cacheKey:1}` index at startup.
- [ ] Test Engineer: Run `worker/generator.test.js` to green and report per-file coverage.
- [ ] Full-stack: Add the always-up "Generator worker" block to `scripts/dev.js` and `docker/Dockerfile.generator` with no model bake.
- [ ] Full-stack: Add the "route through cache (generator)" toggle to `dashboard/components/MenuForm.vue` (sets `cache:true` on the `/ai/menu` body); add the `GENERATOR_TOPIC` health check to both branches of `dashboard/server/api/health.get.ts`.
- [ ] Test Engineer: Dev integration — submit a menu with the cache toggle for a two-diet `protein_grid` step twice; confirm the first writes two per-diet cache docs and wakes the backing model, the second serves both from cache with no model start.
- [ ] Full-stack: Add the generator Cloud Run deploy step to `scripts/deploy.js` and `scripts/deploy-all.js`, min-instances 1, no GPU or MIG.
- [ ] Complete: All success criteria in `plan.md` met and verified.
