---
modified: 2026-08-14
dependencies: [llm-pipeline]
supersedes: null
---

# Multi-Devbox Fleet (up to 4 boxes under pm2)

## Problem

Box identity is duplicated across `ecosystem.devbox.config.cjs:70` (the `a`..`d` app list), `scripts/devbox.js:87` (VM/IP/zone derivation), `scripts/devbox.js:116` (hostname), `/etc/hosts`, and `.env.dev:39` (a single scalar `WORKER_OLLAMA_HOST`), so nothing reconciles them and a box created under the wrong name went undetected. No `ollama-*` app is registered in pm2, so the running L4 VM bills with no entry in `pm2 list` and `pm2 stop ollama-a` fails. There is no command that reports state, uptime, accrued cost, load, GPU and RAM for more than one box, so that report is reconstructed by hand per box.

## Solution

Add `config/devboxes.json` as the single declared source of truth for up to four boxes (`a`..`d`) plus the rate table, read by both the CJS pm2 ecosystem file and the ESM scripts; derive every VM name, hostname, machine type, model and zone preference list from it. Hold NO reserved IPs: a box gets an ephemeral address when it boots and gives it up when it stops, and `/etc/hosts` is resynced on every start because that address changes. Make `pm2 start ecosystem.devbox.config.cjs --only ollama-<n>` the sole power switch by having `scripts/devbox-agent.mjs` adopt an already-RUNNING VM instead of booting it, and by giving the agent the follow-on duties of `/etc/hosts` sync and worker-target reconciliation. Add `scripts/devbox-watch.mjs` — one concurrent, SSH-timeout-tolerant multi-box report with per-box and total cost accrued from each VM's `lastStartTimestamp`.

## Scope

### 1. `config/devboxes.json` (new) — the single source of truth

JSON, not `.js`, for one reason: `ecosystem.devbox.config.cjs` is CommonJS and is `require()`d by the pm2 CLI, so it cannot `import` an ESM module, while the repo is `"type": "module"` (`package.json:5`). JSON is the only form both halves read without a build step or a duplicated list.

Shape:

- `boxes`: object keyed by short name, at most 4 keys, each key matching `^[a-d]$`. Per box: `machine`, `gpus`, `disk`, `model`, `zones` (ordered preference list of full zone names), `enabled` (boolean), and an optional `vm` override for a VM whose real GCE name diverges from the convention. No address field — nothing is reserved.
- `dnsSuffix`: default `dev.yeschef.life`, overridden by `DEVBOX_DNS_SUFFIX` as today (`scripts/devbox.js:114`).
- `rates`: `{ "<machine-type>": { "default": <number>, "<region>": <number> } }`. `default` carries the existing us-central1 reference numbers from `scripts/devbox.js:52` (`g2-standard-8` 0.85, `g2-standard-24` 2.15, `g2-standard-48` 4.30). A region with no explicit entry resolves to `default` and every rendered figure derived from a `default` is marked with `*` and a footnote naming it a us-central1 reference rate, so a us-east4 box is never presented as a measured price.

### 2. `config/devboxes.js` (new, pure ESM accessor)

Reads the JSON via `fs.readFileSync` + `JSON.parse` (not an import attribute, keeping Node-version coupling out), validates it, and exports the derivations that `scripts/devbox.js` performs inline today:

- `BOX_NAMES` — enabled keys, in `a`..`d` order.
- `boxDef(name)` — the merged record; throws on an unknown name, on more than 4 boxes, or on a key outside `a`..`d`.
- `vmOf(name)` → `boxes[name].vm ?? yc-ollama-${name}` (replaces `scripts/devbox.js:87`'s `${PREFIX}-${name}`).
- `hostOf(name)` → `ollama-${name}.${dnsSuffix}` (replaces `scripts/devbox.js:116`).
- `rateFor(machine, region)` → `{ rate, isReference }`.

No Mongo, no GCP, no `dotenv` import, mirroring the purity rule stated in `config/regions.js`'s header so both a pm2 config load and a script can import it cheaply.

### 3. `ecosystem.devbox.config.cjs` (update)

- `require('./config/devboxes.json')` and build `apps` by mapping the enabled box names through the existing `devbox(name)` factory (`ecosystem.devbox.config.cjs:23`) instead of the hand-written `[devbox('a'), devbox('b'), devbox('c'), devbox('d')]` at line 70.
- Preserve verbatim, for every generated app: `autorestart: false` (line 28), `max_restarts: 0` (line 32), `kill_timeout: 120000` (line 30), `watch: false`, the `pm2-dev.mjs` wrapper with component `script` and tag `ollama-<name>` (line 26), and the `--only` money guard at line 61 — the guard keeps gating the box apps and continues to pass `bare` through unconditionally.
- Add one non-GPU app, `ollama-watch`: `pm2-dev.mjs "node scripts/devbox-watch.mjs --follow=300" script ollama-watch`, `autorestart: true`, `max_restarts: 5`. It is exempt from the money guard's withholding list because it starts no VM; it only reads. It ships as component `script`, tag `ollama-watch`, adding no logd component (`yeschef/tools/logd/components.mjs` stays a closed enum).

### 4. `scripts/devbox.js` (update)

- Replace the local `PREFIX`/`HOURLY`/`box()`/`hostOf()` derivations (lines 46, 52, 87, 116) with imports from `config/devboxes.js`. `box(name)` keeps discovering the live zone via `zoneOfVm` (line 82) — the registry's `zones` list is preference for `create`, never an assumption for the other verbs.
- **NO RESERVED ADDRESSES. The IP's lifetime is the box's lifetime: box up → IP exists, box down → IP is gone.** Today line 236 reserves a regional address before line 240 creates the instance, so a `ZONE_RESOURCE_POOL_EXHAUSTED` at 240 leaves a paid reservation behind — the mechanism that produced four `yc-ollama-001-ip` reservations across four regions. The fix is not to reorder the reservation but to delete it: `create` stops calling `addresses create` and drops `--address=` entirely, letting GCE attach an **ephemeral** external IP at boot. GCE then owns the whole lifecycle — the address appears when the VM runs and is released when it stops — so an orphan reservation is not merely unlikely, it is unrepresentable. A stopped box costs disk only, never an idle address.
- `create` walks `boxes[name].zones`, attempting `instances create` in each; on `ZONE_RESOURCE_POOL_EXHAUSTED` it advances to the next zone. Because nothing is reserved at any point, a failed walk leaves nothing behind at all.
- **The consequence, stated plainly: a box's IP CHANGES on every start.** That is what makes item 8's `/etc/hosts` sync load-bearing rather than a convenience — clients address `ollama-<name>.<suffix>`, and the name is the only stable handle a box has. Every code path that brings a box up must resync the name before the box is announced as usable.
- `create` reads `machine`, `gpus`, `disk`, `model` from the registry as defaults (replacing the literals at lines 232-235), with the existing `--machine=`/`--gpus=`/`--disk=`/`--model=` flags still overriding.
- New verb `ips`: a **leak detector**, not a manager. It lists every address resource matching `^yc-ollama-` across all regions and, under the ephemeral model, should always print nothing. Any row it prints is a bug or a hand-made reservation. `ips --prune --yes` deletes rows whose status is `RESERVED` (never `IN_USE`), naming each as it goes.
- Fix `delete`: line 415 calls `dnsDelete(b)`, which is defined nowhere in the file, so the verb throws after deleting the VM and before releasing the IP — the exact path that manufactures an orphan reservation. Define `dnsDelete` as the Cloudflare `DELETE` counterpart of `dnsSync` (line 135), no-op when `CLOUDFLARE_API_TOKEN` is unset, and move the call before the address deletion.
- `hosts` gains `--write` (see item 8) and takes its entry list from the registry ∩ live boxes rather than live boxes alone, so a deleted box's stale line is removed even though the box no longer appears in `allBoxes()` (line 167).
- `list` uses `rateFor(machine, region)` for its burn line instead of `HOURLY[b.machine]`, and marks reference rates.

### 5. `scripts/devbox-agent.mjs` (update) — "this just happens"

The agent keeps its defining property: its lifetime is the VM's power state, and its SIGINT/SIGTERM/SIGHUP handler (line 46) still powers the VM down before exit. Added responsibilities, all after a `start` that returned 0 (line 56):

- **Adoption, not boot.** No change is needed to make adoption safe: `devbox.js start` at line 254 reads `describe(b, "status")` and only issues `instances start` when the status is not `RUNNING`, otherwise printing "already RUNNING" and proceeding to DNS sync and `waitForOllama`. The agent therefore attaches to the live VM without a stop, a restart, or a second boot. Double-booting is prevented by pm2 itself refusing a second app of the same name; the agent additionally exits non-zero if `describe` reports a status of `STOPPING`/`SUSPENDING`, rather than racing a shutdown.
- **`pm2 start` MUST run the capacity find-loop; pm2 itself must never be the retry mechanism.** Observed 2026-08-14: `pm2 start … --only ollama-001` on a TERMINATED box returned `ZONE_RESOURCE_POOL_EXHAUSTED (state:STOCKOUT)` from `us-east4-c`, `devbox.js:258` threw, the agent exited 1 at line 57, and pm2 left the app stopped with no retry — because `autorestart: false` / `max_restarts: 0` are deliberate invariants (item 3) and must stay. So the loop lives INSIDE the start path, where a failed attempt costs an API call rather than a process respawn on billable hardware. Both invariants hold: pm2 never restarts the agent, and the operator still gets a box.
  - **Implement the loop that was RUN AND PROVEN on 2026-08-14, not a new abstraction.** It acquired an L4 on roughly the 25th attempt when every zone in us-central1, us-west1 and us-east1 was stocked out. Its exact shape, which the code should reproduce:

    ```
    for each round (unbounded, or until DEVBOX_START_DEADLINE):
      for Z in <every L4 zone, ordered>:
        attempt `instances create` in Z
        on exit 0        -> read the assigned ephemeral IP off the instance,
                            log "SUCCESS zone=<Z> ip=<IP> <hh:mm:ss>", stop the loop
        on stderr containing ZONE_RESOURCE_POOL_EXHAUSTED
                         -> log "<hh:mm:ss> <Z> STOCKOUT", continue
        on any other error
                         -> log "<hh:mm:ss> <Z> OTHER: <first ERROR line>",
                            save the full stderr for that zone, continue
        sleep 8-15s
    ```

    Four properties earned the hard way today, each of which the implementation must keep:
    - **One log line per attempt, classified.** `STOCKOUT` vs `OTHER` is the distinction that matters: it is how `us-central1-f` was caught as a zone with **no nvidia-l4 at all** (a permanent `OTHER`, not a transient stockout) and pruned from the list. Collapsing both into "failed" hides that.
    - **Full stderr kept per `OTHER` zone.** Diagnosing the `us-central1-f` case required the actual error text, not the classification.
    - **Never trust the `zonesAvailable` hint in the error body.** GCE reported `zonesAvailable: us-central1-a` in one failure and `us-central1-b,us-central1-a` in another, seconds apart, while both of those zones were themselves refusing instances. The hint is stale on arrival; walk the list, do not chase the hint.
    - **A short pause, then keep cycling the same list.** Capacity appeared and vanished within seconds — `us-central1-a` was stocked out, then reported available, then refused again. One pass over the zones is not a verdict; the loop has to come back around.
  - **The loop ALWAYS walks zones. Camping on one region is prohibited** — the user's rule, verbatim: "should not sit on one region. that's a no no". A retry that can only ever hit one zone is exactly the trap observed on 2026-08-14: the box was stopped in `us-east4-c` while that was the only US zone with L4 capacity, and by restart time the zone was stocked out with nothing else to try. So the find-loop's unit is the whole `boxes[name].zones` list, cycled with a short pause, never a single zone polled repeatedly.
  - **Therefore `stop` TEARS THE BOX DOWN, and `start` always creates.** `instances start` can only resume a VM in the zone it already occupies — a VM cannot be moved — so retaining a stopped VM is what pins the box to one region. Retention and zone-walking are mutually exclusive, and zone-walking wins. `pm2 stop ollama-<n>` deletes the instance (and with it the boot disk); `pm2 start … --only ollama-<n>` creates a fresh instance wherever capacity exists. This is the same rule as the IP, one level up: box up → instance exists, box down → instance is gone.
  - **The price, stated: a fresh box re-pulls its model.** ~5 GB for `llama3.1:8b`, once per start, and the boot disk is rebuilt from the image. That is the cost of never being stuck, and it is the trade the user chose over keeping a disk that can only boot in one zone.
  - **`DEVBOX_START_DEADLINE`** (default 30 min) bounds the hunt across the full zone list. On expiry the agent exits non-zero with elapsed time, attempt count and the per-zone outcomes, so a fleet-wide stockout is a reported failure rather than a process that looks alive forever.
- **`/etc/hosts` sync** by invoking `devbox.js hosts --write` for its own box only. It re-runs the sync whenever a poll cycle observes the box's public IP has changed (a region rebuild), so a client name never resolves to a dead address.
- **Worker-target reconciliation.** The agent computes `hostOf(name)` and compares it to the host in `WORKER_OLLAMA_HOST`. It never edits `.env.dev`. When the running `bare` app targets a box that is not up, or targets a box other than the one the operator designated `primary` in the registry, the agent logs a single line naming the mismatch and the one command that fixes it. Choosing the target stays an explicit operator act because `scripts/worker-native.mjs:25` maps `WORKER_OLLAMA_HOST` onto `OLLAMA_HOST` once, at boot: a worker cannot be retargeted without a restart, and the `bare` app drains the same subscription as the Docker `workers` app, so a second worker started to reach a second box would split messages between them.
- **Fan-out across boxes is a worker-count decision, not a per-request one.** One `bare` worker points at exactly one box. Boxes `b`..`d` are addressed directly by name (`http://ollama-b.dev.yeschef.life:11434`) by `devbox.js chat`/`use`/`pull`, by the dashboard, and by any ad-hoc client — they do not need to be the subscription's target to be useful.

### 6. `scripts/devbox-watch.mjs` (new) — the multi-box watch report

A plain script, not a new duty of the agent: the agent's lifetime is a power switch and must not gain a failure mode that could take a box down, and a report has to cover boxes whose agent is not running (the invisible-but-billing case this whole plan exists to close).

Collection, per invocation:

1. **One** `gcloud compute instances list --filter="labels.purpose=ollama-devbox" --format="csv[no-heading](name,zone,status,machineType.basename(),lastStartTimestamp,networkInterfaces[0].accessConfigs[0].natIP)"` — every box's state, machine, region and start time in a single API call, no SSH. This call is the report's floor: if it succeeds the report prints, whatever else fails.
2. Per box, concurrently via `Promise.allSettled`, each wrapped in its own `AbortController` deadline (`--ssh-timeout`, default 45s, below the observed ~120s IAP hang):
   - `gcloud compute ssh <vm> --tunnel-through-iap --command="nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits; cat /proc/loadavg; free -m | awk '/Mem:/{print $3, $2}'"` — GPU, load and RAM in one session, so a box costs one SSH, not three.
   - `curl -sf -m 5 http://<hostOf(name)>:11434/api/ps` for the warm model.
3. Cross-reference `pm2 jlist` by app name `ollama-<name>`: a box `RUNNING` in GCE with no pm2 app, or a pm2 app `online` whose VM is `TERMINATED`, is flagged.

Degradation: a rejected or timed-out per-box collector renders that box's stat cells as `?` and appends a reason to the footer. It never blocks or delays another box's row, and never suppresses the report — state, uptime, rate and cost come from step 1 and remain accurate for a box whose SSH is dead.

Invocation: `npm run box:watch` (one shot, exits), `npm run box:watch -- --follow=300` (reprints every 300s, the cadence the report is read at), `--json` for machine-readable output. The pm2 app in item 3 is the follow form, so the report accumulates in logd and `npm run logs -- script --tag ollama-watch` replays it.

Column layout, one row per box in the registry plus a total line:

```
BOX  VM             STATE       ZONE        PM2      UP      $/HR   COST    LOAD 1/5/15       GPU%  VRAM MiB     TEMP  PWR    RAM MiB      OLLAMA
a    yc-ollama-001  RUNNING     us-east4-c  online   6h12m   0.85*  $5.27   0.31/0.28/0.24    94    21504/23034  71C   132W   9812/32089   llama3.1:8b
b    yc-ollama-b    RUNNING     us-west1-a  online   0h41m   0.85*  $0.58   ?/?/?             ?     ?            ?     ?      ?            answering
c    yc-ollama-c    TERMINATED  us-east1-c  stopped  -       -      -       -                 -     -            -     -      -            -
d    -              ABSENT      -           -        -       -      -       -                 -     -            -     -      -            -

2 RUNNING of 4 defined — $1.70/hr, $5.85 accrued.  * us-central1 reference rate, not a us-east4 quote.
b: SSH timed out after 45s — GPU/load/RAM unavailable, state and cost are current.
ACCESS: tcp:11434 from <allowlist>
```

`STATE` is GCE's own status, so `ABSENT` (no VM) is distinct from `TERMINATED` (VM exists, stopped). `PM2` is the app status, so `RUNNING` beside a blank `PM2` is the billing-while-invisible alarm, printed in the footer as an explicit warning line.

### 7. Per-box cost accounting

- `UP` and `COST` derive from GCE's `lastStartTimestamp` from step 1 of the collector, not from pm2 uptime and not from local state: the timestamp survives a pm2 restart, an agent crash, and an adoption of a box pm2 never started, all of which would understate a bill.
- `COST = (now - lastStartTimestamp) hours × rateFor(machine, region).rate`, per box.
- The total is the sum over boxes whose GCE status is `RUNNING`. `$/HR` totals the same set. A stopped box contributes zero to both and its row shows `-`, with the footer stating that a stopped box still bills its boot disk — but never an address, since none is held.
- Any figure whose rate came from `rates.<machine>.default` is suffixed `*`; a region with an explicit entry in `rates` prints unmarked.

### 8. `/etc/hosts` writing — the print-only stance, stated

`scripts/devbox.js:318`'s `hosts` verb prints the `sed`+`printf` command instead of running it, and its comment gives the reason: `/etc/hosts` needs sudo, and a script that silently rewrites system files is worse than one you paste.

**The ephemeral-IP decision (item 4) forces this to change, and the user made that decision explicitly: "box is up -> ip is created, box is down -> remove ip".** Once no address is reserved, a box's IP differs on every start, so a printed command that a human may or may not paste is no longer sufficient — an unsynced `/etc/hosts` leaves the box unreachable by the only stable handle it has. Writing therefore becomes the default on the box-up path, and the print-only form is retained as an explicit opt-out:

- `hosts --write` performs the edit; the agent calls it on every successful start. `hosts` with no flag still prints exactly what it prints today and writes nothing, so the inspect-first workflow survives for anyone who wants it. `DEVBOX_HOSTS_NO_WRITE=1` forces print-only even on the agent path, for a machine where editing the file is unacceptable — there the operator pastes the command and the box is unusable by name until they do.
- It never invokes `sudo` and never escalates. If the file is not writable by the current user it prints the command and says why it declined. (`/etc/hosts` is mode 0666 on this machine, so the opt-in path works without escalation; on a machine where it is not, the behavior is identical to today.)
- Its edit is scoped: it only removes lines whose hostname matches `^ollama-[a-d]\.<dnsSuffix>$` and only appends lines for boxes in the registry, preserving the delete-then-append ordering already reasoned out at `scripts/devbox.js:322` so a region move replaces a line rather than duplicating a name. Every other line is byte-identical.
- It prints the before/after diff of the lines it touched.

The rationale that survives: the original objection was to a *silent* rewrite, and to sudo. A printed diff, a scoped edit that touches only `ollama-[a-d]` lines, and a refusal to escalate is not silent — and the ephemeral-IP model means the alternative is a name that points at a dead address after every restart, which is worse than the thing the print-only rule was protecting against.

### 9. Stockout handling for boxes `b`..`d`

- Each box carries its own ordered `zones` list in the registry. Seed them so the four boxes do not all queue on the same pool: box `a` leads with `us-east4-c` (the zone with verified capacity), and `b`..`d` lead with distinct regions among us-central1, us-west1, us-east1, us-west4, each falling back through the others.
- `create` walks the list and treats `ZONE_RESOURCE_POOL_EXHAUSTED` as "try the next zone", not as a failure. Quota is not the binding constraint (L4 quota is 24/16/16/16/16 across those five regions against a maximum of four single-GPU boxes); capacity is, which is why the fallback is ordered and cross-region.
- **The regional-IP problem disappears with the ephemeral model.** A reserved address is regional and cannot follow a box across regions, which is exactly why cross-region stockout fallback manufactured orphans. With no reservation at all (item 4), a box simply gets an ephemeral address in whatever region accepted it, and a zone that refuses the VM leaves nothing behind to clean up.
- Siblings landing in different regions is normal and costs nothing extra, because clients address `ollama-<name>.<suffix>` rather than a number — the reason names exist. A cross-region rebuild is a DNS/`/etc/hosts` repoint, which items 5 and 8 make automatic.
- The shared firewall rule `yc-ollama-allow` (tcp:11434, target tag `ollama-devbox`, `scripts/devbox.js:48`) already covers every box in every region through the tag, so no per-box rule is added. Ollama has no authentication, so the source allowlist stays the only guard and stays an explicit list; `ensureFirewall` (line 206) is unchanged and `create` keeps calling it. Four boxes multiply the exposure of one allowlist mistake by four, so `devbox-watch` prints the current allowlist in its footer on every report and prints a warning line when `0.0.0.0/0` appears in it.

### 10. Reconciling the existing `yc-ollama-001` VM

The running VM is literally named `yc-ollama-001` in `us-east4-c`; the convention is `a`..`d`. A GCE instance cannot be renamed, and `scripts/devbox.js:87`/`:116` derive the VM name and the hostname from the box name. Both paths are viable and the choice is the user's:

**Path A — carry an alias (no VM touched).** Set `boxes.a.vm = "yc-ollama-001"` in the registry. Cost: one override field on one box, permanently, and a VM whose console name does not match its pm2/DNS name. Everything else — pm2 app `ollama-a`, hostname `ollama-a.dev.yeschef.life`, `/etc/hosts`, `.env.dev` — reads `a`. Requires repointing `WORKER_OLLAMA_HOST` from `ollama-001.dev.yeschef.life` to `ollama-a.dev.yeschef.life` (`.env.dev:39`) and restarting the `bare` app, plus replacing the `ollama-001` line in `/etc/hosts`. Keeps the only US zone with verified nvidia-l4 capacity.

**Path B — recreate as `a`.** Delete the VM and create box `a` fresh. Cost: the `us-east4-c` capacity slot is released and re-acquiring it is not guaranteed, since every nvidia-l4 zone in us-central1, us-west1 and us-east1 returned `ZONE_RESOURCE_POOL_EXHAUSTED`; the boot disk and its pulled models are rebuilt from scratch; the box is unavailable for the rebuild window. Gain: zero override fields and a name that matches everywhere.

Either path leaves the framework identical — the `vm` override exists in the schema regardless, because a name/VM divergence is possible again after any rebuild.

**The prevention.** This mismatch happened because a box's name was chosen at the moment `create` was typed, and nothing declared the permitted set. With `config/devboxes.json` in place, `create <name>` resolves the box through `boxDef(name)`, which throws for any key outside `a`..`d` and for a fifth box, so `create 001` fails before a single gcloud call. The declared list, not the operator's memory, is what makes the name legal.

## Target Design Docs

- `docs/design/gpu-devboxes.md` (new — no design doc currently describes the devboxes; the closest, `docs/design/llm-pipeline.md`, covers the request path and its dev/deploy execution model, not the hand-operated GPU boxes). It documents, as built: the `config/devboxes.json` registry and every name derived from it; pm2 as the sole power switch and why `autorestart: false` / `max_restarts: 0` / the `--only` money guard exist; the agent's lifetime-is-power-state contract and its adoption of an already-RUNNING VM; the ephemeral-IP rule (box up creates the address, box down releases it) and why it makes the `/etc/hosts` resync load-bearing rather than optional; zone-preference stockout walking; per-region rate resolution and reference-rate marking; the watch report's collection model, its degradation contract and its column layout; the shared-firewall/no-Ollama-auth constraint; and the `script`-component/`ollama-<name>`-tag logd convention. Use Cases 1-4 below fold into its Use Cases section.
- `docs/design/llm-pipeline.md` (update) — add to its dev execution model that `WORKER_OLLAMA_HOST` names exactly one box and is read once at boot by `scripts/worker-native.mjs:25`, so retargeting the `bare` worker is a restart; and that `bare` and the Docker `workers` app drain the same subscription, so a second worker for a second box splits messages rather than doubling throughput. Reference `gpu-devboxes.md`.

## Parallel / Dependent Breakdown

- **Group A (prerequisite, gates everything):** `config/devboxes.json` + `config/devboxes.js` + `config/devboxes.test.js`, and the `package.json` `test` glob extension. Nothing else lands first.
- **Group B (after A, parallel with C/D):** `scripts/devbox.js` refactor to the registry — `box()`, `hostOf`, rate lookup, `create` defaults.
- **Group C (after A, parallel with B/D):** `ecosystem.devbox.config.cjs` generated `apps` list, invariants preserved, `ollama-watch` app added.
- **Group D (after A, parallel with B/C):** `scripts/devbox-watch.mjs` with its collectors and formatters exported for test, plus `scripts/devbox-watch.test.mjs`.
- **Group E (after B):** `create` zone-walk with the reservation path removed entirely (ephemeral IP); `ips` as a leak detector; the `dnsDelete` fix.
- **Group F (after B):** `hosts --write` and `scripts/devbox-hosts.test.mjs`.
- **Group G (after C and F):** `scripts/devbox-agent.mjs` adoption guard, hosts sync on start and on IP change, and worker-target mismatch logging.
- **Group H (after D and G):** the `pm2 jlist` cross-reference rows and the billing-while-invisible warning, which need both the report and the registered apps to exist.
- **Group I (after G, blocked on the user's item-10 decision):** the box-`a` reconciliation — registry overrides or recreate, plus `.env.dev:39` and the `/etc/hosts` line.
- **Group J (last):** `docs/design/gpu-devboxes.md` and the `llm-pipeline.md` update.

## Use Cases

### 1. Adopt an already-running box into pm2 without powering it down

- **Goal.** Bring a GPU VM that is already RUNNING and billing under pm2's ownership, with no stop, restart or second boot.
- **Stakeholders.** The operator paying by the hour; anyone whose worker is mid-generation against that box.
- **Actors.** Operator; pm2 CLI; `scripts/devbox-agent.mjs`; `scripts/devbox.js`; GCE.
- **Preconditions.** The box has an enabled entry in `config/devboxes.json`; its VM reports `RUNNING`; no pm2 app named `ollama-<name>` exists.
- **Postconditions.** `pm2 list` shows `ollama-<name>` as `online`; the VM was never stopped or restarted; `/etc/hosts` resolves `ollama-<name>.<suffix>` to the VM's current IP; `pm2 stop ollama-<name>` will power the VM off.
- **Basic Course of Events (BCE).**
  1. Operator runs `pm2 start ecosystem.devbox.config.cjs --only ollama-<name>`.
  2. The money guard at `ecosystem.devbox.config.cjs:61` sees `--only` and exposes the generated app list built from `config/devboxes.json`.
  3. pm2 spawns `pm2-dev.mjs` → `scripts/devbox-agent.mjs <name>`, which calls `devbox("start", NAME)` at line 56.
  4. `devbox.js start` (line 254) reads `describe(b, "status")`, sees `RUNNING`, skips `gcloud compute instances start`, and prints "already RUNNING".
  5. `dnsSync` and `waitForOllama` confirm the endpoint answers; `start` exits 0.
  6. The agent runs `devbox.js hosts --write` for this box, logs the URL, and enters its 30s poll loop, logging only on change (line 67).
- **Alternate Flows.** The VM reports `TERMINATED`: step 4 issues `instances start` and the same postconditions are reached after boot.
- **Exceptions.** `describe` reports `STOPPING` or `SUSPENDING` — the agent exits non-zero without touching the VM, rather than racing a shutdown, and pm2 leaves the app `errored` with `max_restarts: 0` so nothing loops on billable hardware. `start` exits non-zero for any other reason — the agent exits 1 at line 57 and supervises nothing.

### 2. Watch all four boxes in one report

- **Goal.** See state, uptime, hourly rate, accrued cost, load average, GPU utilization/memory/temperature/power and RAM for every declared box, plus a combined burn total, in one command.
- **Stakeholders.** The operator watching spend; anyone diagnosing a slow generation.
- **Actors.** Operator; `scripts/devbox-watch.mjs`; GCE Compute API; IAP SSH; Ollama HTTP; pm2.
- **Preconditions.** `config/devboxes.json` declares at least one box; gcloud is authenticated.
- **Postconditions.** One table printed, one row per declared box plus a total line; every declared box appears whether or not its VM exists; the exit code is 0 when the instance list succeeded.
- **Basic Course of Events (BCE).**
  1. Operator runs `npm run box:watch`.
  2. The script loads `config/devboxes.js` for the declared box list and rate table.
  3. It issues one `gcloud compute instances list --filter="labels.purpose=ollama-devbox"` for name, zone, status, machine type, `lastStartTimestamp` and IP.
  4. It reads `pm2 jlist` and maps app `ollama-<name>` status onto each row.
  5. For each `RUNNING` box concurrently, under a 45s per-box deadline, it runs the single combined `nvidia-smi` + `/proc/loadavg` + `free -m` SSH command, and `curl /api/ps`.
  6. It computes `UP` from `lastStartTimestamp` and `COST` from `UP × rateFor(machine, region)`, marking reference rates with `*`.
  7. It prints the table, the `n RUNNING of m defined` total burn and accrued line, one footer line per degraded box, and the firewall allowlist.
- **Alternate Flows.** `--follow=300` repeats steps 3-7 every 300s until interrupted. `--json` emits the same collected record set as JSON instead of the table.
- **Exceptions.** A box's SSH exceeds the deadline — its stat cells render `?`, a footer line names the timeout, and its state/uptime/cost cells stay accurate from step 3. A box is `RUNNING` in GCE with no pm2 app — the row shows a blank `PM2` cell and the footer prints a warning that the box is billing outside pm2's ownership. Step 3 itself fails — the script exits non-zero printing the gcloud error, since no row can be trusted.

### 3. Create the second box when the leading zone is out of L4 capacity

- **Goal.** Stand up box `b` without leaving an orphan static IP behind when a zone refuses the instance.
- **Stakeholders.** The operator, who should be left with no address resource whether the create succeeds or not; anyone waiting on the second box.
- **Actors.** Operator; `scripts/devbox.js create`; GCE.
- **Preconditions.** `config/devboxes.json` has an enabled `b` with an ordered `zones` list; no VM named per `vmOf('b')` exists; L4 quota is available in the candidate regions.
- **Postconditions.** Either a `RUNNING` VM in one of the preferred zones with an ephemeral external IP and `/etc/hosts` resolving `ollama-b.<suffix>` to it; or no VM at all. No address resource exists in either outcome.
- **Basic Course of Events (BCE).**
  1. Operator runs `npm run box:create -- b`.
  2. `create` reads `machine`, `gpus`, `disk`, `model` and `zones` from `boxDef('b')`.
  3. `ensureFirewall` (line 206) confirms the shared `yc-ollama-allow` rule exists.
  4. For the first zone, it attempts `gcloud compute instances create` with the `ollama-devbox` tag and `purpose` label, and no `--address` flag, so GCE attaches an ephemeral external IP.
  5. It reads the assigned IP off the created instance and calls `hosts --write`, pointing `ollama-b.<suffix>` at it.
  6. `waitForOllama` polls the name; the registry's `model` is pulled over IAP SSH.
  7. `status` prints the box.
- **Alternate Flows.** Step 4 returns `ZONE_RESOURCE_POOL_EXHAUSTED` — the loop advances to the next zone and repeats, having created nothing; a box landing in a different region from its siblings is a normal outcome because clients address `ollama-b.<suffix>`, not the number.
- **Exceptions.** Every zone in the list is exhausted — `create` exits non-zero having created no VM and no address resource, so there is nothing to clean up. Step 5's `/etc/hosts` write is refused (file not writable, or `DEVBOX_HOSTS_NO_WRITE=1`) — `create` prints the IP and the paste-able command and exits non-zero, because a box whose name does not resolve is not usable by any client and must not be reported as ready.

### 4. Confirm no address reservation is leaking

- **Goal.** Prove the fleet holds no reserved IPs, since under the ephemeral model a box's address is created with the VM and released when it stops.
- **Stakeholders.** The operator, who paid ~$0.004/hr per idle reservation per region for four orphans before this rule existed.
- **Actors.** Operator; `scripts/devbox.js ips`; GCE.
- **Preconditions.** gcloud is authenticated.
- **Postconditions.** Either the listing is empty — the expected steady state — or every row printed is named for the operator to judge.
- **Basic Course of Events (BCE).**
  1. Operator runs `npm run box:ips`.
  2. The script lists every address resource matching `^yc-ollama-` across all regions, with status and region.
  3. It prints nothing and exits 0, because no code path reserves an address.
- **Alternate Flows.** A row appears — a hand-made reservation, or a regression that reintroduced `addresses create`. The script prints it with its status and region and exits non-zero, so the leak is loud rather than a line item on a bill. `npm run box:ips -- --prune --yes` then deletes rows whose status is `RESERVED`.
- **Exceptions.** A listed address is `IN_USE` — never a prune candidate, since detaching a live box's IP would break every client name pointing at it. `--prune` without `--yes` prints the deletion set and exits 0 without deleting.

## Success Criteria

- `node -e "const d=require('./config/devboxes.json'); const k=Object.keys(d.boxes); if(k.length>4||k.some(n=>!/^[a-d]$/.test(n))) process.exit(1)"` exits 0.
- `node -e "import('./config/devboxes.js').then(m=>{m.boxDef('001')})"` exits non-zero with an error naming the permitted `a`..`d` set; `npm run box:create -- 001` exits non-zero and issues no gcloud call.
- `node -e "import('./config/devboxes.js').then(m=>console.log(m.BOX_NAMES.join(',')))"` and `node -e "console.log(require('./ecosystem.devbox.config.cjs').apps.map(a=>a.name).filter(n=>n.startsWith('ollama-')).join(','))"` (run with `--only` present in argv) print the same box set — the ecosystem file holds no independent list.
- `node -e "const a=require('./ecosystem.devbox.config.cjs').apps.filter(x=>x.name.startsWith('ollama-')&&x.name!=='ollama-watch'); if(!a.every(x=>x.autorestart===false&&x.max_restarts===0&&x.kill_timeout===120000)) process.exit(1)"` exits 0.
- `pm2 start ecosystem.devbox.config.cjs` with no `--only` prints the withholding line and registers no `ollama-<letter>` app: `pm2 jlist` contains `bare` and no box.
- Adopting the running box: before, `gcloud compute instances describe <vm> --format="value(lastStartTimestamp)"` is recorded; after `pm2 start ecosystem.devbox.config.cjs --only ollama-a` returns, `pm2 describe ollama-a` reports `online` and the same `lastStartTimestamp` is unchanged — proving no stop/start occurred.
- `pm2 stop ollama-a` returns and `gcloud compute instances describe <vm> --format="value(status)"` reports `TERMINATED` or `STOPPING` — pm2 is the power switch.
- `npm run box:watch` prints one row per declared box including boxes with no VM (`ABSENT`) and a total line of the form `n RUNNING of m defined — $X/hr, $Y accrued`, and exits 0 in under 60s with at least one box's SSH deliberately blocked (`--ssh-timeout=1`), with that box's stat cells `?`, its state/uptime/cost cells populated, and a footer line naming the timeout.
- With a box `RUNNING` in GCE and its pm2 app stopped, `npm run box:watch` output contains a warning line naming that box as billing outside pm2.
- `npm run box:watch -- --json` output parsed by `node -e` yields, per running box, non-null `lastStartTimestamp`, `upSeconds`, `ratePerHour`, `isReferenceRate` and `accruedCost`, and a top-level total equal to the sum of the running boxes' `accruedCost` to within one cent.
- `node scripts/devbox.js hosts` with no flag prints the `sudo sh -c` command and leaves `/etc/hosts` byte-identical (`shasum /etc/hosts` unchanged); `DEVBOX_HOSTS_NO_WRITE=1` makes even the agent's start path print-only and leave the file untouched.
- `node scripts/devbox.js hosts --write` run twice leaves `/etc/hosts` byte-identical between the two runs, contains exactly one line per declared live box, and leaves every line not matching `ollama-[a-d]\.<suffix>` unchanged (diff against a copy taken before the first run shows only `ollama-*` lines).
- `gcloud compute addresses list --project=yeschef-c572a --filter="name~^yc-ollama-"` prints zero rows after a `create`, after a `pm2 stop`, and after a full stockout-exhausted `create` attempt — no code path reserves an address. `npm run box:ips` exits 0 with empty output in that steady state and non-zero if any row exists; `npm run box:ips -- --prune` without `--yes` deletes nothing.
- `grep -n "addresses create" scripts/devbox.js` returns no match — the reservation path is gone, not merely reordered.
- A box's IP is allowed to differ across a stop/start cycle: record `gcloud compute instances describe <vm> --format="value(networkInterfaces[0].accessConfigs[0].natIP)"`, `pm2 stop ollama-a`, `pm2 start … --only ollama-a`, and confirm `/etc/hosts` resolves `ollama-a.<suffix>` to whatever the NEW value is — `dscacheutil -q host -a name ollama-a.<suffix>` matches the fresh describe output, and `curl http://ollama-a.<suffix>:11434/api/tags` answers without any manual edit.
- `node scripts/devbox.js delete <a nonexistent box>` exits without a `dnsDelete is not defined` ReferenceError.
- `npm test` is green, including `config/devboxes.test.js`, `scripts/devbox-watch.test.mjs` and `scripts/devbox-hosts.test.mjs`, with `worker/admission.test.js`, `worker/semaphore.test.js` and `worker/ollama.test.js` passing unchanged.
- `npm run logs -- script --tag ollama-watch` returns report output, and `yeschef/tools/logd/components.mjs` is unchanged.

## Testing Requirements

- **Unit — `config/devboxes.test.js` (new, `node:test` + `node:assert/strict`, matching `config/models.test.js`'s style).** Covers: a registry of 5 boxes throws; a key outside `a`..`d` throws (the `001` case from Use Case 3's Exceptions and item 10's prevention claim); `vmOf`/`hostOf` derive `yc-ollama-b` and `ollama-b.dev.yeschef.life` from `b`; a `vm` override returns the override while `hostOf` still returns the conventional name; the schema rejects any `addr`/reservation field, so the reservation model cannot creep back in via config; `rateFor("g2-standard-8","us-central1")` returns `{rate:0.85,isReference:true}` when no region override exists and `{isReference:false}` when one does; `rateFor` on an unknown machine type returns rate 0 rather than `undefined` (the `HOURLY[b.machine] || 0` behavior at `scripts/devbox.js:52` must not regress into `NaN` in a total).
- **Unit — `scripts/devbox-watch.test.mjs` (new).** The collector's pure functions are exported for this and take injected fake collectors, so no gcloud, SSH or pm2 process runs. Covers: `UP`/`COST` computed from a fixed `lastStartTimestamp` and a fixed clock (6h12m at 0.85 → $5.27); a `TERMINATED` box contributes 0 to both the hourly and accrued totals; total accrued equals the sum over `RUNNING` boxes only; one rejected per-box collector renders `?` cells while that row's state/uptime/cost stay populated and the other rows are unaffected (Use Case 2's Exceptions); a per-box collector that never settles is cut off by the deadline and does not delay the other rows (assert total elapsed under the deadline plus a margin with two boxes, one hanging); a declared box absent from the instance list renders as `ABSENT`; a box `RUNNING` with pm2 status absent produces the billing-outside-pm2 warning; `*` appears exactly on rows whose rate resolved from `default`.
- **Unit — `scripts/devbox-hosts.test.mjs` (new).** The `/etc/hosts` rewrite is implemented as a pure `(hostsText, entries) => hostsText` transform and tested without touching the filesystem. Covers: an existing `ollama-a.dev.yeschef.life` line is replaced, not duplicated, when its IP changes (the double-entry failure the comment at `scripts/devbox.js:322` guards against); unrelated lines including `127.0.0.1 localhost` and comments are byte-identical; applying the transform twice is idempotent; a declared box removed from the registry has its line deleted; a hostname that merely contains `ollama-a` as a substring of a longer name is not matched.
- **Unit — `scripts/devbox-agent.test.mjs` (new).** The agent's decision logic is extracted into a pure function over an injected status string and tested without spawning `devbox.js`: `RUNNING` → adopt without issuing start; `TERMINATED` → issue start; `STOPPING`/`SUSPENDING` → refuse and exit non-zero; a non-zero `start` exit → do not supervise.
- **Config regression — `package.json`.** The `test` script's globs (`package.json:19`) currently cover only `worker/**/*.test.js` and `functions/**/*.test.js`, so `config/models.test.js` is not executed today; extend the globs to `config/**/*.test.js` and `scripts/**/*.test.mjs`, and confirm `npm test` runs the pre-existing `config/models.test.js` as part of the same change.
- **Regression — existing worker suite.** `worker/admission.test.js`, `worker/semaphore.test.js` and `worker/ollama.test.js` pass unchanged, proving nothing in this plan touched the dispatch path or the Ollama client.
- **Operator-run integration checks.** Executed as the commands enumerated in `## Success Criteria`, in this order, none of them creating a VM: the registry and ecosystem-parity `node -e` assertions; the no-`--only` withholding check; the adoption check comparing `lastStartTimestamp` across a `pm2 start`; `pm2 stop` → GCE status; `npm run box:watch` with `--ssh-timeout=1` for the degradation path; `--json` totals; `hosts` with and without `DEVBOX_HOSTS_NO_WRITE`, comparing `shasum /etc/hosts`; and `npm run box:ips` plus `--prune` without `--yes`.

## Out of Scope

- No VM is created, started, stopped, deleted or recreated as part of this plan. No box `b`, `c` or `d` is provisioned.
- No gcloud mutation of any kind is executed: no instance, address, firewall or DNS change.
- No edit to `/etc/hosts`.
- No `pm2 start` / `pm2 stop` / `pm2 save` of any `ollama-*` app.
- No decision on box `a`'s reconciliation (item 10) — both paths are specified, neither is chosen or executed.
- No change to `.env.dev:39`; retargeting `WORKER_OLLAMA_HOST` is a separate operator act gated on item 10.
- No new logd component; `yeschef/tools/logd/components.mjs` stays closed and boxes keep shipping as `script` with an `ollama-<name>` tag.
- No Cloud Monitoring ops-agent install, no GPU metrics pipeline; GPU stats stay SSH-collected on demand.
- No authenticating proxy in front of Ollama and no widening of the `yc-ollama-allow` source allowlist.
- No load balancing, no request-level routing across boxes, no second Pub/Sub subscription; one `bare` worker keeps targeting one box.
- No change to the MIG production capacity path (`scripts/deploy.js`, `scripts/rollback.js`, `config/regions.js`) or to the capacity-steering controller.
- No dashboard UI for the fleet; the watch report is terminal output only. No mockup is required.
