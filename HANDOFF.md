# Fundamental Autoplayer - session handoff

Pick up here in a new session. Read this first, then `headless/NOTES.md` and
`Resources/fundamental-autoplayer-optimization-report.md` for deeper mechanics.

## What this is
A Tampermonkey userscript that auto-plays awWhy's **Fundamental** idle game
(https://awwhy.github.io/Fundamental/, source github.com/awWhy/Fundamental).
- Script: `/Users/spencer/Downloads/Personal/Coding/Fundamental Player/Fundamental.user.js`
- Repo: https://github.com/ItsMePriddy/fundamental-autoplayer
- Install/update URL: `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`
- Current shipped target: **v1.12.4**.

## Token discipline
- Do **not** use browser screenshots or Chrome tooling without asking first.
- Prefer the Node/headless harness for validation.
- For live game state, use small DOM-only console snippets; game internals are not global.
- Normal ship loop: edit -> bump version -> `node --check` -> commit -> push -> give the raw install link.

## How the bot works
Main loop `tick()` every 250ms:
1. If the tab is hidden, show paused state and skip game actions.
2. Accept the offline-time dialog if present.
3. Apply settings: confirmation toggles to `None`, game automation toggles on.
4. Buy structures/upgrades/strangeness.
5. Run stage-specific fast reset logic.
6. On slower cadence, run stage/end resets and auto-export.
7. Update the HUD.

The game is bundled as a non-module IIFE, so the bot drives stable DOM controls.
`activeStage()` reads `#stageWord`; reset readiness is inferred from button text
except where a stage has custom logic.

## Per-stage reset logic
- Stage 1 discharge: click `#reset0Button` continuously. The label can be misleading, but the reset is cheap and beneficial.
- Stage 2 vaporization: fixed mode, fire when `#vaporizationBoostTotal > span` reaches `vaporizeBoost = 2.25`. Headless sims showed this beats the adaptive rule for Submerged.
- Stage 3 rank: attempt `#reset0Button`; the game gates it internally.
- Stage 4 collapse: see the dedicated section below.
- Stage 5 merge: `mergeStep()` gates merges on `#mergeBoostTotal > span >= 2.0`, with a 120s anti-hang at `>= 1.2`. It preserves its timer through DOM flicker and defers to game automation once merge boost disappears.
- Stage 6 nucleation: off by default (`highStageResets = false`), leaving timing to the game's automation.

## Stage 4 collapse model in v1.12.4
This was retuned from source-level game analysis plus 30-minute headless sims from
the user's real Interstellar save (58 quarks, 141 nova stars, 39 novas, 33.5 mass,
`progress.main = 14`). The v1.12.1 update adds mass-threshold gating and an ROI
multiplier heuristic to prevent collapsing for negligible mass gains.

Key mechanics:
- `#special1Get`, `#special2Get`, `#special3Get` show `starCheck[0/1/2]`, the most reliable signal that collapse is beneficial.
- `#collapseBoostTotal` is only a production boost metric and can flatline at `1.000x` when no more buildings can be purchased.
- The collapse button shows projected newMass: `Collapse is at X Mass`; `#solarMassStat > span` shows the banked currentMass used for threshold and ROI comparisons.
- The game silently rejects collapse clicks unless star gain is positive, new collapse mass exceeds current mass, or elements are pending.
- **Mass thresholds**: The game unlocks new buildings/upgrades/researches at specific solar masses (unlockB/unlockU/unlockR in collapseInfo). Collapsing right when crossing a threshold unlocks new content immediately.

Current config (empirically optimized from 3-agent sweep):
- `collapseBoost = 2.0`
- `collapseMaxWaitMs = 120000` (2 min — safety net, not primary driver)
- `collapseMinBoost = 1.0`
- `collapseHardStallMs = 300000`
- `collapseMinGapMs = 2000`
- `collapseElementGapMs = 3000`
- `collapseMassMultiplier = 1.3` — ROI trigger: empirically optimal from 600s headless sweep
- `collapseStarMassMin = 1.15` — star trigger floor: slightly lower than ROI
- `collapseAntihangMassMin = 1.3` — antihang floor: matches primary ROI (never undercuts it)
- `collapseMassThresholds = [0.01235, 0.076, 0.18, 0.23, 0.3, 0.8, 1.3, 10, 40, 1000]`

Headless validation (user's 467.6-mass save, 600s sims):
- **1.3× mass-only**: 7 collapses, 199 stars, **0.332 stars/s** — 6× faster than anti-hang
- **1.05×**: 13 collapses, 52 stars, 0.087 stars/s — collapsing too frequently
- **2.5×+**: 1 collapse, 140 stars, 0.232 stars/s — waiting too long
- **Anti-hang 60s (no mass floor)**: 10 collapses, 33 stars, 0.055 stars/s — anti-hang was the bottleneck

`collapseStep()` uses this priority order:
1. **Mass threshold**: newMass crosses an unlock threshold that currentMass hasn't reached yet
2. **ROI multiplier**: newMass ≥ currentMass × `collapseMassMultiplier` (1.3 = 30% mass increase)
3. **Star-gain with mass floor**: stars available AND newMass ≥ currentMass × `collapseStarMassMin` (1.15 = 15% increase)
4. **Element pending**: an `#elementN.awaiting` exists and element gap elapsed
5. **Strong boost**: `#collapseBoostTotal ≥ 2.0`
6. **Hard stall**: after 5 minutes since last accepted collapse, click unconditionally
7. **Anti-hang**: after 2 min at boost ≥ 1.0 AND newMass ≥ currentMass × `collapseAntihangMassMin` (1.1 = 10% increase). This is a safety net, not the primary driver — headless data proved the anti-hang at 45s was the performance bottleneck (0.055 vs 0.332 stars/s).

Important timer behavior:
- After clicking, the bot verifies that banked mass, pending star gains, or pending elements changed before treating the collapse as accepted.
- If none changed, the collapse was silently rejected → keep `collapseLastTs` intact so timers continue accumulating.
- Collapse cadence resets when leaving/re-entering stage 4.
- If `#collapseBoostTotal` disappears, the game has taken over auto-collapse and the bot defers to it.

HUD behavior:
- The v1.12.4 HUD is a decision-oriented diagnostic panel rather than a generic
  list of game stats.
- Stage 4 shows banked mass, projected collapse mass, current/target ROI, progress
  to the next mass trigger, pending star/element signals, and the last accepted
  collapse observed this run.
- The old `Goal` row was removed because the collapse button reports projected
  mass, not a goal.
- The old Auto-export, Smart strangeness, and Collapse-on-element toggle controls
  were removed. Those strategy settings use the script defaults and are no longer
  silently restored from HUD-local persistence.
- The only primary control is Pause/Resume. Export save, Copy log, and Install
  latest are explicit utility actions.
- Install latest opens a cache-busted raw GitHub URL so Tampermonkey does not reuse
  stale userscript metadata.
- Collapse records remain available from
  `window.FundamentalBot.collapseReport()` or the HUD's Copy log action.

## Strangeness
`buyStrangenessSmart()` handles the shared strange-quark pool better than the
game's stage-1-first default:
1. Always tries `strange3Stage5`, the globally compounding quark-gain multiplier (1.4× per level, max 2).
2. If `strangenessTargets` has an unowned target, holds all other purchases to save quarks for it.
3. Then buys `strange4Stage5` (Intergalactic collapse immunity).
4. Then buys current stage first, followed by highest stage down to lowest.

Current targets (v1.12): `['strange3Stage5', 'strange4Stage5']`
- Both are also bought unconditionally before the target loop; listed as double insurance.
- strange3Stage5 = 1.4× quark multiplier (max lvl 2, costs 4+16=20 quarks)
- strange4Stage5 = Intergalactic collapse immunity (cost 24 quarks)
- After these are owned (44 quarks total), normal current-stage-first buying resumes.
- strange5Stage5 is intentionally NOT listed — it costs 15,600 quarks and would timeout-hold pointlessly.

The target hold releases only if a target appears locked for longer than
`strangenessTargetTimeoutMs`; expensive but unlocked targets are worth saving for.

## Export
On stage 5+, auto-export runs every 10s to claim strange-quark rewards. The
download is suppressed only for bot-triggered auto-exports; manual exports still
produce a save backup.

## Headless harness
`headless/` contains a local clone/build harness for the real game logic.
- `headless/build.sh` rebuilds the compiled headless game.
- `headless/engine.js` runs real logic with timewarp.
- `headless/route_eval.js` and related scripts support route comparisons.
- `headless/roiprobe.js` was added during the v1.12 collapse investigation.

Known quirks:
- Set `global.offline.active = false`.
- Call `Special.checkProgress()` each tick or `progress.main` can freeze.
- New-game setup uses `prepareVacuum(false)`, `updatePlayer(deepClone(playerStart), false)`, and `global.paused = false`.
- Drive time with `timeUpdate(step, step)`.

## Validation from v1.12 collapse tuning
From the user's actual save, 30-minute sims showed:
- v1.11.7 style, `2.5x / 90s`: 13 collapses, stars `[185,123,82]`, about `0.217 stars/s`.
- v1.12 tuning, `1.8-2.0x / 30-45s`: 16 collapses, stars `[199,132,89]`, about `0.233 stars/s`.

## Open optimizations
1. Re-run seeded sims after the user owns the key Stage 4 strangeness upgrades.
2. Tune Stage 5 merge timing once Intergalactic is more developed.
3. Tune Stage 6 nucleation later.

## Shipping reminder
After changes:
1. Run `node --check Fundamental.user.js`.
2. Commit with the requested co-author trailer when asked to ship.
3. Push `main`.
4. Tell the user to force-reinstall from:
   `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`
