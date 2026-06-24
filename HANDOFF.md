# Fundamental Autoplayer — session handoff

Pick up here in a new session. Read this first, then `headless/NOTES.md` for deep mechanics.

## What this is
A Tampermonkey userscript that auto-plays awWhy's **Fundamental** idle game
(https://awwhy.github.io/Fundamental/, source github.com/awWhy/Fundamental).
- Script: `/Users/spencer/Downloads/Personal/Claude/Fundamental Player/Fundamental.user.js`
- Repo: https://github.com/ItsMePriddy/fundamental-autoplayer (public). Author = `ItsMePriddy` / `spencer@thepriddys.com`.
- Install/update (always the same raw URL): `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`
- **Current shipped version: v1.9.1.**

## TOKEN DISCIPLINE (the user's #1 priority — read this)
- Do **NOT** use the Chrome MCP / screenshots without asking first — image tokens are the biggest cost. Ask, explain what you need and why.
- The **headless harness (Node/Bash) is cheap and preferred** for any testing/validation — no browser.
- For live info, give the user a small console one-liner to paste (DOM-only; game has no globals).
- Keep responses concise. Bump `@version`, `node --check`, commit, push, and reply with the clickable install link. That's the loop.

## How the bot works (DOM-driven; game is an IIFE with no globals)
Main loop `tick()` every 250ms: `acceptOfflineDialog` → `applySettings` (set confirms None, enable game auto-toggles + auto-stage-switch) → `buyEverything` → `fastResets` → (slow cadence) `slowResets` + auto-export → `updateHud`.
- `activeStage()` reads `#stageWord` text → stage 1-6 (Microworld..Abyss).
- Reset readiness read from button **text** (buttons never get `.disabled`).

### Per-stage reset logic (`fastResets` / helpers)
- **Stage 1 discharge:** spam `reset0Button` (regain always good; label is misleading so don't gate on it).
- **Stage 2 vaporization:** `vaporizeStep` — fire when `#vaporizationBoostTotal>span` ≥ `vaporizeBoost` (2.25, headless-validated optimum; curve flat 2–3). Adaptive ln(boost)/elapsed mode exists but is WORSE here — leave 'fixed'.
- **Stage 3 rank:** attempt `reset0Button` (hard-gated by mass + maxRank).
- **Stage 4 collapse:** `collapseStep` — dual trigger: boost `#collapseBoostTotal>span` ≥ `collapseBoost` (2.5) OR anti-hang (`collapseMaxWaitMs` 90s @ ≥ `collapseMinBoost` 1.3). PLUS **element-pending trigger**: collapse ASAP when any `#elementN.awaiting` exists (elements only activate on collapse and their boost isn't in the boost metric). Elements bought each tick via `createAll`.
- **Stage 5 merge / 6 nucleation:** `highStageResets` (default false) → currently rely on the game's own auto-resets. **NOT yet tuned — this is the main next work.**

### Strangeness (`buyStrangenessSmart`) — shared quark pool
Game default (`createAllStrangeness`) dumps stage-1 first (bad). Instead:
1. Always buy `strange3Stage5` (the 1.4× quark-gain multiplier — the only globally-compounding strangeness).
2. `strangenessTarget` (default `strange7Stage4` = "Elements no longer require Collapse", idx6 max1): while unowned, buy only it + the multiplier and HOLD the rest (save quarks) → it's the next purchase. Releases after `strangenessTargetTimeoutMs` (10min) if it can't be bought. Owned-detection parses the button's "cur/max" text.
3. Then current-stage-first, then highest→lowest.

### Export (`tick`) — stage 5+
Click `#export` every `exportEveryMs` (10s) to claim Strange-quark rewards. Reward rate is proportional to elapsed time (`conversion=min(time/12h,1)`) so cadence-invariant in total — 10s just reinvests continuously vs idle. The save-file download is **suppressed** via an `HTMLAnchorElement.prototype.click` override for `data:text/plain` download anchors (no files saved; reward kept). Manual exports are suppressed too — user can still backup via Settings → save console → Copy.

### UI
Minimal top-center banner `#fbBar` (status/stage/uptime, click to toggle). Console API: `window.FundamentalBot` = `{ start, stop, tick, report, cycles, log, CONFIG }`. (`log` entries: `💥 collapse (element)` / `📤 export` etc.)

## CONFIG knobs (top of the script)
tickMs, vaporizeMode/vaporizeBoost, collapseBoost/collapseMaxWaitMs/collapseMinBoost, collapseOnElement/collapseElementGapMs, autoExport/exportEveryMs, smartStrangeness, strangenessTarget/strangenessTargetTimeoutMs, highStageResets, verbose.

## Headless harness (`headless/`) — local clone already exists
`./build.sh` clones the game, guards Main.ts's boot block behind `__HEADLESS__`, compiles TS→CJS to `headless/build/`. `engine.js` runs the REAL logic with timewarp (4h sim < 1s). Scripts: `solve.js`, `sweep.js`, `optimize.js`.
- **Required quirks:** set `global.offline.active=false` AND call `Special.checkProgress()` each tick, else `progress.main` freezes (stall at stage 3). New-game init: `prepareVacuum(false)` + `updatePlayer(deepClone(playerStart),false)` + `global.paused=false` + `U.stageUpdate()`. Drive with `timeUpdate(step,step)`; buy max with `buyBuilding(i,s,0,false)`.
- Used to validate vaporization 2.25. Deep mechanics in `headless/NOTES.md`.

## Local-cloning-for-testing — decision (pros/cons)
We already clone+run headless, so the answer is "already done." The one upgrade that would make it genuinely useful for CURRENT (stage 4/5) ROI questions: **load the user's real save** into the harness (`updatePlayer(JSON.parse(atob(saveString)))`) so sims start from their actual state instead of a rushed/unrepresentative one.
- Pros: ground-truth ROI A/B sweeps from real state; token-cheap (Bash summaries); timewarp; no save-clobber; deterministic.
- Cons: one-time save paste (could be a few KB of the user's tokens); harness maintenance (re-run build.sh if the game updates); DOM-stub edge cases; some debugging risk wiring save-import.
- Recommendation: worth it ONLY when doing a rigorous tuning pass (e.g., stage-5 merge timing). For incremental heuristic tweaks, the read-source + small-console-snapshot approach we've used is cheaper. Default: keep heuristic; offer save-import-seeded headless sweep when precision is wanted.

## Game state (as of handoff)
User is **early in Intergalactic (stage 5 / merge loop)**. Does NOT yet have auto-collapse or "elements no longer require collapse" strangeness (hence v1.9.0 element-collapse trigger + v1.9.1 strangenessTarget to grab the latter next).

## Next steps / open optimizations
1. **Stage 5 (merge) tuning** when it's developed — give merge dedicated logic like collapse (boost from `#mergeBoostTotal>span`); currently relies on game auto (`highStageResets` off).
2. Stage 6 (nucleation) later.
3. Optional: save-import in the headless harness for a precise strangeness/collapse/merge ROI sweep from the real save.
4. Re-tune collapse/strangeness once the "elements no collapse" + auto-collapse strangeness are owned (some triggers self-disable then).

## Workflow norms
Per change: edit → bump `@version` → `node --check` → `git commit` (author ItsMePriddy/spencer@thepriddys.com, end body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`) → `git push` → reply with the clickable raw install link. Tampermonkey sometimes caches updates → tell user to reopen the raw link to force-reinstall.
