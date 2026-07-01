# Fundamental Autoplayer — session handoff

Read this first. For mechanics detail, `Fundamental.user.js`'s `CONFIG` block and
each stage's `*Step()` function are the source of truth — every threshold has an
inline comment explaining *why* it's set that way. This file only holds what the
code itself can't tell you: where things live, what's validated, and what's open.

## What this is
A Tampermonkey userscript that auto-plays awWhy's **Fundamental** idle game
(https://awwhy.github.io/Fundamental/, source github.com/awWhy/Fundamental) by
driving its DOM — the game ships as a non-module IIFE with no exposed globals.
- Script: `Fundamental.user.js` — current shipped version: **v1.13.1**
- Repo: https://github.com/ItsMePriddy/fundamental-autoplayer
- Install/update URL: `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`
- User-facing install/usage docs: `README.md`

## Workflow
- Don't use browser screenshots or Chrome tooling without asking first — validate
  timing/CONFIG changes with `headless/sweep.js` against a real save instead (see
  below); it runs the actual compiled game logic at high speed.
- Ship loop: edit -> bump `@version` (only when behavior actually changes — a
  comment-only or tooling-only change doesn't need one) -> `node --check
  Fundamental.user.js` -> update the shipped-version line above -> commit -> push
  -> give the raw install link. The HUD/console/install-URL all read `@version`
  from `document.currentScript` at runtime, so there's no separate constant to sync.

## Layout
- `Fundamental.user.js` — the bot. `CONFIG` holds every tunable threshold with its
  rationale inline; `fastResets()`/`slowResets()` dispatch to each stage's
  `*Step()` function, which holds that stage's trigger logic and priority order.
- `headless/` — Node harness that compiles the real game TypeScript and runs it
  with timewarp (`build.sh` + `engine.js`), so policies can be validated against
  ground truth instead of guessed in the live browser. `headless/sweep.js` is the
  one tool to run before shipping any CONFIG change — see its header comment for
  usage, and `headless/NOTES.md` for harness gotchas (don't re-derive those).
- `Resources/saves/` — exported save snapshots used as `sweep.js` fixtures.
  `sweep.js` defaults to the newest file here; pass `--save=` to override.
- `Resources/analysis/` — point-in-time research docs (mechanics deep-dives, ROI
  derivations). Each has a status header (**applied** / **superseded** / **open**)
  — read that before trusting a conclusion inside; a doc can be kept for its
  derivations while its headline recommendation is stale or wrong.

## Validated tuning (current CONFIG reflects all of these — re-run sweep.js to reproduce)
| Stage | Setting | Why |
|---|---|---|
| 2 Submerged | `vaporizeMode: 'fixed'`, `vaporizeBoost: 2.25` | headless sweep; the adaptive ln(boost)/elapsed rule underperforms badly here. Re-checked 2026-07: vaporize cadence does NOT degrade as banked clouds grow within a run (~35-45s/cycle steady from 1e0 to 1e7 clouds), and clouds are zeroed by every stage reset anyway — the "fixed ratio gets harder over a session" theory is refuted |
| 4 Interstellar | `collapseMassMultiplier: 1.3` (primary), `collapseBoost: 2.0` (secondary) | Re-validated 2026-07 with the hardened sweep + full trigger cascade: the curve is *flat* — at steady state 1.3x/2x/5x/20x/100x differ by only ~5% quarks/sim-hour (6.74 -> 6.41). 1.3 is still the best point but the historical "6x faster than alternatives" claim was an artifact of a broken harness. Don't burn time re-tuning this; the payoff isn't there |
| 5 Intergalactic | `strangenessTargets: ['strange3Stage5', 'strange4Stage5']` | strange3 compounds all future quark income; strange4 stops Collapse from wiping Stage 5 progress |

## Native automation handoff (v1.13.1)
The game runs its OWN auto-vaporize/auto-collapse check every tick inside
`timeUpdate` once unlocked (strangeness[2][4]≥1 / strangeness[4][4]≥1, or the
alternate `researchesAuto[2]` route), thresholded by the `#vaporizationInput` /
`#collapseInput` settings fields (defaults 3× / 2×, otherwise never touched).
`configureNativeAutomation()` writes CONFIG values into those fields once per
session, unconditionally — harmless pre-unlock because the game only reads them
inside the natively-gated auto path. (v1.13.0 instead tried to *detect* the
unlock via `#toggleVaporizationHotkey`/`#toggleCollapseHotkey` visibility; that
never fired because those elements are built lazily by `openHotkeys()` only when
the player opens the Hotkeys window. Lesson recorded below.)
**Units:** `#vaporizationInput` takes the vaporize boost ratio (`vaporizeBoost`),
but `#collapseInput` is compared against the PRODUCTION-BOOST formula
(`#collapseBoostTotal`), not the raw-mass ratio — it maps to `collapseBoost`,
never `collapseMassMultiplier`. The script's own per-stage polling continues to
run alongside; both systems then share consistent thresholds.

**DOM-signal rule of thumb (learned the hard way in v1.13.0):** before gating any
feature on a DOM element's presence/visibility, verify the element exists in the
static page HTML (`curl` the live site) or is created at boot — several of the
game's panels (Hotkeys, version info, other `buildBigWindow` users) construct
their DOM lazily on first open, so "the compiled source sets its style" does not
mean "the element exists during normal play". The live deployed bundle and the
master-branch clone are both v0.2.9 today (verified 2026-07-01) — no version
drift, but re-check that when validating DOM assumptions after game updates.

## Open items
- **Stage 5 merge threshold is unvalidated.** `mergeBoost: 2.0` / `mergeMinBoost: 1.2`
  were carried over from the collapse pattern, not derived for merge — merge has a
  fundamentally different cost (resetting true-galaxy count loses exponential
  production). See `Resources/analysis/stage5-merge-optimization.md`: its own math
  is internally inconsistent (two derivations disagree by many orders of
  magnitude), so don't ship a threshold change from it directly. Validate any
  candidate with `headless/sweep.js` against a save that has reached true vacuum
  (the current save fixture hasn't).
- Stage 6 (Abyss/nucleation) timing is still fully deferred to the game's own
  automation (`highStageResets: false`) — untuned, no headless data yet.
- `headless/sweep.js`'s collapse cascade intentionally omits the
  `#collapseBoostTotal >= collapseBoost` secondary trigger (the formula uses the
  game's custom bignum class; transcription risk outweighed fidelity). Known,
  disclosed gap — see the comment at the trigger cascade in sweep.js.

## Headless harness
`headless/README.md` explains how the harness works; `headless/NOTES.md` has the
resolved quirks (offline-flag, `checkProgress`, new-game setup) — treat both as
current and don't re-derive what they already answer.
