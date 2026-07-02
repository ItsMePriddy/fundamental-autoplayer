# Fundamental Autoplayer — session handoff

Read this first. For mechanics detail, `Fundamental.user.js`'s `CONFIG` block and
each stage's `*Step()` function are the source of truth — every threshold has an
inline comment explaining *why* it's set that way. This file only holds what the
code itself can't tell you: where things live, what's validated, and what's open.

## What this is
A Tampermonkey userscript that auto-plays awWhy's **Fundamental** idle game
(https://awwhy.github.io/Fundamental/, source github.com/awWhy/Fundamental) by
driving its DOM — the game ships as a non-module IIFE with no exposed globals.
- Script: `Fundamental.user.js` — current shipped version: **v1.15.1**
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
| 2 Submerged | `vaporizeMode: 'fixed'`, `vaporizeBoost: 2.25` | headless sweep; the adaptive ln(boost)/elapsed rule underperforms badly here. Re-checked 2026-07: vaporize cadence does NOT degrade as banked clouds grow within a run (~35-45s/cycle steady from 1e0 to 1e7 clouds), and clouds are zeroed by every stage reset anyway — the "fixed ratio gets harder over a session" theory is refuted. v1.13.2 fixed a real user-spotted race: until `researchesExtra[2][0]` is owned, pending cloud gain derives from CURRENT (spendable) Drops, so buying before reading the boost span fired vaporize on stale, inflated numbers — tick() now runs resets before purchases, and the vap log records projected vs actual cloud gain |
| 4 Interstellar | `collapseStarBatch: 50` / `collapseStarGapMs: 30s` (v1.14.0), `collapseMassMultiplier: 1.3` (primary), `collapseBoost: 2.0` (secondary) | User-spotted, sim-confirmed (100 matched sim-hours, 2026-07-02): firing the star trigger on ANY pending remnant (pre-v1.14) gave 6.66 qks/simH vs 17.0 with batch>=50/30s-gap or star-off — ~2.6x slower overall and ~12x slower star banking, because +1-star collapses wipe production before buildings compound (live symptom: collapses at ~1.001x mass, reason "stars"). Batch>=50 measured identical to star-off; kept as a solar-hardcap safety valve. This also RESOLVES the earlier "flat multiplier curve" mystery: it was flat because the star trigger dominated every strategy — under batching the multiplier matters again (1.3x: 17.0 > 2.5x: 15.3 > 5x: 13.1) |
| 5 Intergalactic | `strangenessTargets`: quark multiplier -> gravitational bound -> the automation chain (Auto Collapse s4, Auto Vaporization s2, Auto Stage, Auto Galaxy, Auto Merge) | v1.15.0: each target now gets ONE bounded saving window (`strangenessTargetTimeoutMs`, per-target timer) then buying resumes with the target still clicked first each tick. Pre-v1.15, unlocked-but-expensive targets held ALL strangeness spending indefinitely — this froze strangeness buying entirely once the cheap early targets were owned (user-reported symptom). The generic loop also now clicks `strange11Stage5` (Galactic tide), which the old 1..10 loop could never buy |

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
- **Fine collapse-multiplier re-sweep under star batching.** 1.3x beat 2.5x and 5x
  with the v1.14 batch gating, but the 1.1-2.0 band hasn't been re-swept since the
  star trigger stopped dominating — cheap to run (`node grid-sweep.js
  --axis=collapseMult` now inherits the batched shipped config). Same for
  `collapseStarBatch`/`collapseStarGapMs` themselves: 50/30s measured identical to
  disabling the trigger, so the exact values are uncritical, but they've not been
  tuned finely.
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
