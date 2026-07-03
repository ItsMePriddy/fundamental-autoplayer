# Fundamental Autoplayer — session handoff

Read this first. For mechanics detail, `Fundamental.user.js`'s `CONFIG` block and
each stage's `*Step()` function are the source of truth — every threshold has an
inline comment explaining *why* it's set that way. This file only holds what the
code itself can't tell you: where things live, what's validated, and what's open.

## What this is
A Tampermonkey userscript that auto-plays awWhy's **Fundamental** idle game
(https://awwhy.github.io/Fundamental/, source github.com/awWhy/Fundamental) by
driving its DOM — the game ships as a non-module IIFE with no exposed globals.
- Script: `Fundamental.user.js` — current shipped version: **v1.17.0**
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
  one tool to run before shipping any stage-timing CONFIG change, and
  `headless/milestone-probe.js` is its counterpart for the milestone engine —
  see their header comments for usage, and `headless/NOTES.md` for harness
  gotchas (don't re-derive those).
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
| all (milestones) | `milestoneAttempts: true`, `milestoneRampFrac: 0.3`, retry backoff 30m/1h/3h by peak/need ratio (x2 per consecutive fail, 6h cap), 12-min stall release | v1.17.0, `headless/milestone-probe.js` from the 03.07.2026 save: baseline earns ZERO milestone tiers ever (small resets wipe the counters); ship policy earned +19 tiers in 36 simH — maxing Supermassive (Intergalactic unlock), Light in the dark, Satellites of Satellites, Fundamental Matter, A Nebula of Drops — with >2x baseline quarks/simH. Full-window suppression fails (1e-159% of the s1 target: production must ramp through discharges first); collapse suppression for the s5 star milestone fails (3% vs 97% with normal collapse cadence); no backoff fails economically (income -70%, near-misses never land) |

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

## Non-vacuum endgame structure (source-verified + sim-confirmed)
Corrects several earlier assumptions; don't re-derive:
- Stage resets ADVANCE the run 1->2->3->4 (each grants ~1 quark); buying Iron
  (element 26, 1e48 stardust — auto-bought by `createAllFooter`'s element loop)
  flips `current` to 5, and stages 4+5 are then CO-ACTIVE (collapse keeps
  running during stage 5).
- Once at 4/5 the stage reset maps to `stageResetCheck(5)` (Iron-gated). The
  moment Iron lands it becomes legal — pre-v1.16 the bot fired it within
  seconds, capping every run at ~4 min of stage-4 development ("stuck looping
  1-4" symptom, 115 resets with elements stuck at 11).
- The REAL progression gates are the MILESTONES — two per stage, 6-8 tiers
  each, final tier of each = a permanent unlock (Permanent Microworld/
  Submerged/Accretion, Intergalactic structures, Galaxy researches, stage-5
  strangeness, the auto-stage-to-Intergalactic toggle). `milestones[4][0]>=8`
  unlocks part of stage-5 strangeness (incl. Automatic Stage); `[4][1]>=8`
  unlocks Galaxies/Intergalactic structures; the two `milestones[5]` entries
  are gated on their `milestones[4]` twins being maxed.

## Milestone completion engine (v1.17.0 — replaces v1.16's stage-4/5 run hold)
Mechanics (source: `assignMilestoneInformation`/`milestoneCheck` non-vacuum
branches, `Reset.js reset()`):
- A tier is auto-awarded when its counter reaches the need value while the
  run's `time.stage` is under a per-tier limit that SHRINKS as tiers rise
  (stage bases 4h/8h/12h/16h divided by a percentage-power term; s5: 1h
  shrinking / flat 20 min).
- The counters are wiped by the stage's own SMALL reset: discharge zeroes the
  s1 "produced this reset" quark total AND spends the energy the other s1
  milestone scores (until `strangeness[1][4]>=2`); vaporize zeroes the s2 drop
  total + simultaneous-puddle count; collapse zeroes the s5 self-made star
  count. This is why the pre-v1.17 bot could NEVER earn stage 1-3 milestones:
  it discharged every tick and vaporized on cadence.
- The engine (all state read from the game's autosave in
  `localStorage['fundamentalSave']`, btoa(JSON) refreshed every 20s — the
  milestone DOM spans only update while the Milestones subtab is open, so the
  DOM cannot be polled): hold the stage reset while any pending tier's window
  is open; let discharge/vaporize run for the first `milestoneRampFrac` of the
  tightest open window, then suppress them (own clicks + `toggleAuto1/2` for
  the game's native autos); NEVER suppress collapse (sim: star milestone gets
  97% of target from normal collapse cadence vs 3% suppressed — collapses
  drive the production that buys stars); on a failed/stalled window start a
  per-tier retry cooldown (persisted in `localStorage['fbMilestoneBackoff']`).
- Save-proxy subtleties: s4[1] tracks BANKED `collapse.mass` (projected
  newMass isn't saved; banking happens every collapse so it tracks), s5[0]
  sums `buildings[4][1..5].true` (equals unsaved `collapseInfo.trueStars`:
  both increment per stage-4 structure buy, both zeroed per collapse/galaxy).
- `window.FundamentalBot.milestoneReport()` dumps live windows/backoff state.
- Sim trajectory from the user's real save (see the tuning table): milestones
  went `[[4,3],[5,4],[7,6],[8,4],[2,0]]` -> `[[6,5],[7,6],[7,7],[8,8],[8,0]]`
  in 36 simH. Still outstanding after that: s1[1] tier 6 (29600 energy in
  20 min, repeatedly 98-99%), s2[1] tier 7 (6400 puddles in 20 min, 96-97%),
  and s5[1] (galaxies — first attemptable once `milestones[4][1]=8` lands).
  These land on retry as strangeness compounds; backoff keeps probing cheap.

## Open items
- **Milestone engine live-shakedown.** The policy is sim-validated end-to-end
  (`headless/milestone-probe.js 'ship'`), but the userscript implementation
  (autosave polling, `estStageTime`'s own-click clock, toggleAuto1/2 handoff,
  backoff persistence) has only been desk-checked — watch the first hours of
  live play for: suppression flapping in the HUD log, spurious
  "ended with the run" backoffs right after stage resets (autosave lag), and
  the s2 puddle attempt fighting the native auto-vaporize (toggleAuto2 must
  read OFF while "vaporize held" shows). `milestoneReport()` is the tool.
- **Milestone tables are v0.2.9 constants.** `MS_SCALING`/`MS_TIME_BASE`/
  `MS_TIME_K` in the userscript mirror the game source; a game update can
  silently change them. Re-verify against a fresh compile (they live in
  `headless/build/Player.js milestonesInfo` / `Stage.js
  assignMilestoneInformation`) whenever the game version bumps.
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
