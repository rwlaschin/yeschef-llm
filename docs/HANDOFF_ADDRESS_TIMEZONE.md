# Handoff — plan-wizard Address/Timezone rows + Translate boot test

Written 2026-08-12. Session stopped mid-verification at the user's request (meeting).
Nothing is committed anywhere — per standing rule, no git was used. All changes sit in the
working tree of `yeschef/`.

---

## 1. What this work was

Split the plan wizard's single "Location" row into two rows on `/plans/create` → **Facility** section:

- **ADDRESS** — Google's recommended single combo box (`<gmp-place-autocomplete>` /
  `PlaceAutocompleteElement`), revealed behind the row's `Change` button, animating in and out.
- **TIMEZONE** — derived automatically from the picked address via the existing offline
  ZIP/lat-long resolver, with the existing `TIMEZONES` picker retained as a manual override.

User's original instruction: *"Update this component to be 2 pieces. the address (use the standard
search bar address look up that google recommends, please our theme.) and then auto look up the
timezone please."*

---

## 2. Files changed (all in `yeschef/`, all uncommitted)

| File | Change |
|---|---|
| `src/components/plans/AddressAutocomplete.tsx` | The widget component. Loads Places via `@googlemaps/js-api-loader` (`setOptions` at **module scope**), themed with `--yc-*` tokens, host reserves `h-[52px]`. |
| `src/components/pages/CreatePlanPage.tsx` | New `Reveal` component (~line 149); `'address'` added to the `picker` union (~line 410); `handleAddress` (~line 387); the two rows in the Facility section (~lines 1068-1096). |
| `app/layout.tsx` | Comment only. The user reverted the Translate `<Script>` back to `strategy="afterInteractive"` — **that revert is intentional, do not undo it.** The comment above it was corrected to match and to point at the e2e spec. |
| `e2e/system/translateBoot.spec.ts` | **NEW, NEVER RUN.** See §5. |

`@googlemaps/js-api-loader@^2.1.1` is installed (in `package.json`).

`npx tsc --noEmit -p tsconfig.json` → clean as of the stop.
(Bare `tsc --noEmit` silently passes broken code — always pass `-p tsconfig.json`.)

---

## 3. Verified — do not re-litigate these

Each was checked by a dispatched agent against the live dev server, with per-frame numbers printed.

- **Widget is not a permanent fixture.** `widgetPresentBeforeChange=false`; it only mounts when
  `Change` is clicked.
- **Theme applied.** `bg=rgb(255,253,240)` (`--yc-cream`), `color=rgb(78,42,14)` (`--yc-cinnamon`),
  `colorScheme=light`, `radius=12px`. `color-scheme: light` is **required** — the element's default is
  `light dark`, which renders the field black on a dark-mode machine.
- **Labels present.** `Address` / `Timezone`, 11px uppercase, via the existing `FieldLabel`.
- **Enter animation.** `opacity: 0.176 → 1`, height `19.6px → 55.9 → 73.9 → 76px → auto`.
- **Exit animation.** After `Close` the widget is **still mounted** at `opacity: 0.862 → 0.229`, gone
  by 1.5s — children are held through the leave spring.
- **Timezone row slides, not pops.** On close its `top` travels `593.73 → 524` across **242 frames /
  37 distinct positions**, largest single-frame delta 8px.
- **At rest the wrapper is `height: auto; overflow: visible`** — required, or the address prediction
  dropdown gets clipped.
- **`setOptions()` warning fixed.** It was inside the effect, so it re-ran on every reveal-open.
  Moved to module scope; agent confirmed the warning is absent across 3 open/close cycles with the
  widget mounting each time.
- **Address → timezone chain works.** Verified earlier with a real click: picking
  `3542 MacIntosh St, Santa Clara, CA 95054, USA` set the timezone to `America / Los Angeles`.

---

## 4. NOT verified — pick up here

### 4a. The double-expansion fix (highest priority)

User's report: *"you seem to be expanding BOTH the inner text input and the outter one which breaks
the animation."*

Diagnosed mechanism: `Reveal` measures content height with
`inner.current?.getBoundingClientRect().height` **at enter**, but `AddressAutocomplete` appends the
Google widget *asynchronously* after `importLibrary('places')` resolves. So the outer box sprang to a
stale height, then grew a second time when the widget appeared and `atRest` handed height back to
`auto`.

Fix applied: the host div reserves the field's height up front —
`className="yc-place-autocomplete h-[52px]"` — and the widget CSS uses `height: 100%` instead of
`min-height: 52px`. Nothing is left to re-measure.

`tsc` is clean. **The behaviour was never observed.** The verification agent was killed mid-run.

To verify: sample the animated wrapper's `getBoundingClientRect().height` every frame for **2.5s**
after clicking the address `Change` (long enough for Google's script to resolve). PASS only if the
height rises monotonically to ONE final value. Two plateaus = the bug is still there. Also confirm
`.yc-place-autocomplete` measures 52 both immediately and at 2.5s.

### 4b. `setPicker(null)` on selection

`handleAddress` (`CreatePlanPage.tsx:389`) now calls `setPicker(null)` so picking an address collapses
the reveal, matching `Picker`'s `onAdd → onClose`.

Never observed. It cannot be driven synthetically: an injected `new CustomEvent('gmp-select')` does
**not** reach the component's listener, and synthetic clicks do not enter the widget's closed shadow
root. **One real click settles it** — open `Change`, type, pick a prediction.

### 4c. The preload warning tradeoff

`afterInteractive` makes Next emit `<link rel="preload">` for the Translate script, and Chrome then
warns *"preloaded using link preload but not used within a few seconds from the window's load event"*.

Switching to `lazyOnload` removes the preload link (confirmed: the link disappeared from the SSR
HTML) **but the user reverted it** — the boot order matters more than the warning. The warning is
inherent to `afterInteractive`. Left as-is deliberately. Do not flip the strategy without running
§5's spec.

---

## 5. `e2e/system/translateBoot.spec.ts` — NEW AND NEVER EXECUTED

The user's instruction: *"you translate race should be an e2e test ... not a one off."*

Written by a test-engineer agent that was stopped **before it ran the spec even once**. Treat it as a
draft. It may not pass; it has never been proven able to fail.

It belongs to the existing `system` project (`playwright.config.ts:54`,
`testMatch /system\/.*\.spec\.ts/`, `storageState 'e2e/.auth/user.json'`). 8 tests covering:

1. `window.google.translate` becomes an object
2. `#google_translate_element` gets non-empty innerHTML (the widget really constructed)
3. `window.googleTranslateElementInit` is a function (the inline script ran first)
4. no `preloaded using link preload` in console, with a real 8s post-load wait
5. `yc.voiceConfig = {"lang":"fr-FR"}` → `googtrans` cookie `/en/fr`
6. the `yc-translating` flash guard is applied (via MutationObserver init script)
7. the flash guard is removed again after its 1500ms fallback
8. `en-US` leaves no `googtrans` cookie

**What it protects:** `app/layout.tsx` boots Translate as a three-part chain —
`yc-lang-boot` (beforeInteractive, sets the cookie) → `google-translate-init` (afterInteractive,
inline, defines the callback) → `translate_a/element.js` (afterInteractive, external, *calls* the
callback). If the external script ever runs before the inline one, the callback is undefined, the
widget never constructs, and the site silently stays English. A one-line `strategy` change is enough
to break it.

Next steps for it:
```bash
cd yeschef
npx playwright test --project=system e2e/system/translateBoot.spec.ts --reporter=line
```
Then **prove it can fail** — abort the `translate.google.com/translate_a/element.js` request with
`page.route()`, confirm red, restore, confirm green. A test that cannot fail is worthless.
Note: test 4 asserts the warning is absent while the code is on `afterInteractive`, which is the
strategy that *causes* the warning — expect this one to be the failure and decide whether the
assertion or the strategy is wrong.

---

## 6. Environment gotchas that cost real time today

- **`waitForLoadState('networkidle')` never fires on this app** — persistent Firestore sockets keep it
  busy. Use `'load'` plus `expect.poll` / explicit selectors.
- **Playwright hijacks AppleScript control of Chrome.** While a `Google Chrome for Testing` process is
  alive, `tell application "Google Chrome"` binds to *it*, not the user's Chrome — and JS-from-Apple-
  Events is off there, so every probe fails with *"Executing JavaScript through AppleScript is turned
  off."* `id of application "Google Chrome for Testing"` returns **`com.google.Chrome`**, the same
  bundle id as real Chrome, so neither name- nor bundle-id targeting disambiguates them. **Always
  `pkill -f "Google Chrome for Testing"` before driving the user's browser**, and never run a
  Playwright agent and an AppleScript probe at the same time. This was misdiagnosed once as a
  per-profile permission problem — that explanation was wrong.
- **Never use `front window`.** It is frequently some unrelated tab. Match the tab positively by URL:
  loop `windows` → `tabs`, pick the one whose `URL contains "localhost:3100"`, set
  `active tab index` + `index of w to 1`, `activate`, then `execute ... javascript`. A working helper
  is at `/Users/mac/.claude/jobs/108eb9b0/tmp/yc-tab.applescript` (job tmp — will not survive).
- **Chrome throttles background tabs.** A probe returning `missing value` or `0 buttons` usually means
  the tab is not foregrounded, not that the page is broken. `activate`, sleep 2, retry.
- **The dev server (`pm2` id 1, name `web`, port 3100) sometimes wedges** — every path returns 200 with
  `bytes=0` and empty `content_type`. Restart `web` when that appears. A 200 is not proof of health;
  check `size_download`.
- To fetch an authenticated page with curl, pull `__session` out of `e2e/.auth/user.json`.

---

## 7. Standing constraints for whoever picks this up

- No git. Leave changes in the working tree.
- No worktrees.
- No new scratch files in the repo — use `node -e` inline, or the job tmp dir.
- Do not certify your own work: dispatch an agent and report ITS verdict, default FAIL.
- No codebase words in UI labels. The row descriptions were rewritten once already for this:
  `"Address — sets the timezone below"` was rejected as developer content.
- The Timezone row's copy is the user's wording, spelling corrected:
  **"Determines regional cuisine and local vendors."**
- The app has **no circle-x icon** (`grep CircleX|XCircle src/` → zero hits). `Picker`'s dismiss is
  `UtensilsCrossed`; `Soup` is its add-custom icon. The address reveal deliberately reuses `Picker`'s
  close control. The user asked about a circle-x — if they want one, change `Picker` too so the two
  don't diverge.
