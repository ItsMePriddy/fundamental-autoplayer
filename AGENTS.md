# AGENTS.md — Fundamental Autoplayer & Game Internals

> **Purpose:** Give future agents a single-file map of the bot and game so they don't
> need to comb through 20k lines of compiled game source or reverse-engineer mechanics
> from scratch. Read this first; drill into specific files only when modifying them.

## 1. What This Is

A Tampermonkey userscript (`Fundamental.user.js`, ~2100 lines) that auto-plays
[awWhy's **Fundamental**](https://awwhy.github.io/Fundamental/) idle game (v0.2.9)
by driving its DOM. The game ships as a non-module IIFE bundle with **no exposed
globals** — all interaction is via clicking buttons and reading DOM text.

- **Repo:** https://github.com/ItsMePriddy/fundamental-autoplayer
- **Install URL:** `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`
- **Current version:** v1.18.1 (see `@version` header)
- **Game source (compiled):** `headless/build/*.js` — the real game TypeScript
  compiled to CommonJS for headless validation

## 2. Codebase Map

```
Fundamental.user.js          The bot. Everything ships from this one file.
├── CONFIG (L83-296)         Every tunable threshold with inline rationale
├── Helpers (L301-395)       $, clickIf, textOf, numFromText, readNum, activeStage
├── Setup (L397-500)         acceptOfflineDialog, applySettings, configureNativeAutomation
├── Buying (L502-666)        buyEverything, buyStrangenessSmart (smart strangeness)
├── Stage steps (L668-1028)  vaporizeStep, collapseStep, mergeStep, shouldHoldStage5Reset
├── fastResets (L1029-1109)  Dispatches to stage-specific step each tick
├── Milestone engine (L1144-1437) msValueFromSave, milestoneEngine, msCloseWindow
├── Export/save (L1400-1500) backupSave, exportSaveFile, suppressExportDownloads
├── tick() (L1505-1545)      Main loop: milestone → settings → resets → buy → slow-resets → export → HUD
└── HUD (L1599-2101)         Side panel rendering + button handlers

headless/                     Node harness that runs the REAL game logic at high speed
├── build.sh                  Clones game repo, compiles TypeScript → ./build/
├── engine.js                 Loads game, exposes newGame/buyBuildings/vaporBoost/mergeBoost
├── _globals.js               Stubs browser globals (document, localStorage, etc.)
├── sweep.js                  Canonical validation tool — compares CONFIG strategies
├── grid-sweep.js             Single-axis parameter sweep (e.g. --axis=collapseMult)
├── milestone-probe.js        Milestone-specific validation against a real save
├── NOTES.md                  Harness gotchas (offline flag, checkProgress — DO NOT re-derive)
├── README.md                 Harness usage
└── build/                    Compiled game source (the ground truth)
    ├── Player.js             Player state object, global info, upgrade/strangeness definitions
    ├── Stage.js              timeUpdate, buyBuilding, stageResetCheck, calculateEffects, milestone info
    ├── Check.js              checkBuilding/Upgrade, milestoneGetValue, milestoneCheck
    ├── Reset.js              reset(), resetStage(), resetVacuum() — what gets wiped on each reset
    ├── Update.js             DOM update logic (shows what elements display what values)
    ├── Special.js            checkProgress(), inflation tree, challenges
    ├── Main.js               Boot/init, save key ('fundamentalSave'), quark gain
    ├── Limit.js              Custom bignum class (used everywhere for large numbers)
    ├── Hotkeys.js            Hotkey panel (built lazily — see pitfalls)
    └── Types.js              Type definitions (empty in compiled output)

Resources/
├── saves/                    Exported save snapshots for sweep.js fixtures
└── analysis/                 Point-in-time research docs (each has status: applied/superseded/open)

HANDOFF.md                    Session handoff — validated tuning table + open items
README.md                     User-facing install/usage docs
```

## 3. Game Mechanics (Non-Vacuum)

The game has **6 stages** but non-vacuum play targets stages 1-5 (stage 6/Abyss
needs the inflation tree, out of scope).

### 3.1 Stage Progression

| # | Name           | Small Reset (reset0) | Stage Reset (reset1) | Key Resource    |
|---|----------------|----------------------|----------------------|-----------------|
| 1 | Microworld     | Discharge            | → Stage 2            | Energy          |
| 2 | Submerged      | Vaporize             | → Stage 3            | Clouds/Drops    |
| 3 | Accretion      | Rank up              | → Stage 4            | Mass            |
| 4 | Interstellar   | Collapse             | → Stage 5            | Solar Mass/Stars|
| 5 | Intergalactic  | Merge                | → (stays 4/5 co-active) | Galaxies    |

**Critical:** Stages 4 and 5 are **co-active** once Iron (element 26) is bought.
Collapse keeps running during stage 5. The stage reset from 4→5 is Iron-gated.

### 3.2 Reset Mechanics (what gets wiped)

From `Reset.js`:

| Reset         | Wipes                                                           | Keeps                          |
|---------------|-----------------------------------------------------------------|--------------------------------|
| Discharge (s1)| Energy, "produced this reset" quark count                       | Buildings, researches          |
| Vaporize (s2) | Stage-2 chain + upgrades, drop total, puddle count              | Researches, clouds             |
| Collapse (s4) | `collapse.mass = 0.01235` (zeroed!), production                 | Stars, elements, researches    |
| Merge (s5)    | `mergeInfo` (galaxy count for boost calc), NOT `collapse.mass`  | Everything else                |
| Stage reset   | Current stage's resources + buildings                           | Strangeness, quarks, milestones|

### 3.3 Strangeness (Quarks)

- Each stage reset grants ~1 Strange quark (quarks are the prestige currency)
- **Unspent quarks boost production** via `Math.pow(unspent + 1, exponent)`:
  - Stage 1: exp 0.22, Stage 2: exp 0.18, Stage 3: exp 0.76, Stage 4: exp 0.16, Stage 5: exp 0.06
- Gating: s1 needs `strangeness[1][6]≥1`, s2 needs `strangeness[2][6]≥1`,
  s3 needs `strangeness[3][7]≥2`, s4 needs `strangeness[4][7]≥1`, s5 needs `strangeness[5][7]≥2`
- **Smart strangeness** (v1.18.0+): routes quarks to current stage first (highest exponent),
  then highest→lowest. Always buys "Strange gain" (`strange3Stage5`) first.
- Save location: `localStorage['fundamentalSave']` → `sv.strange[0].current` (unspent quarks)

### 3.4 Milestones (the REAL progression gates)

Two per stage (index 0 and 1), 6-8 tiers each. Final tier = permanent unlock.
A tier is auto-awarded when its counter reaches the need value **while the run's
stage time is under a per-tier limit** that shrinks as tiers rise.

**What each milestone tracks** (from `Check.js milestoneGetValue`, non-vacuum):

| Stage | idx 0                       | idx 1                                    |
|-------|-----------------------------|------------------------------------------|
| 1     | `buildings[1][0].total`     | `discharge.energy`                       |
| 2     | `buildings[2][1].total`     | `buildings[2][2].current` (puddles)      |
| 3     | `buildings[3][0].total`     | `buildings[3][4].true + [3][5].true`     |
| 4     | `buildings[4][0].total`     | **`collapseInfo.newMass`** (LIVE mass!)  |
| 5     | `collapseInfo.trueStars`    | `buildings[5][3].true` (galaxies)        |

**⚠️ s4[1] (Supermassive) reads `collapseInfo.newMass` — the LIVE solar mass,
NOT the banked `collapse.mass`.** The bot originally read `sv.collapse.mass`
(banked, only updates on collapse) and saw "stalled" when the counter was
actually growing. Fixed in v1.18.1: now reads `#mainCapS5 > span` (stage 5)
or `#footerStat2Span` (stage 4) from the DOM.

**Milestone counters are WIPED by the stage's small reset:**
- Discharge zeroes s1 counters (energy + produced-quark total)
- Vaporize zeroes s2 counters (drop total + puddle count)
- Collapse zeroes s5[0] (trueStars) — but NOT s4[1] (newMass persists)
- Collapse also zeroes `collapse.mass` but NOT `collapseInfo.newMass`

**Final-tier unlocks:** Permanent Microworld/Submerged/Accretion, Intergalactic
structures (`milestones[4][1]≥8`), Galaxy researches (`milestones[4][0]≥8`),
stage-5 strangeness, auto-stage-to-Intergalactic toggle.

### 3.5 Native Game Automation

The game has its own auto-vaporize/auto-collapse that runs inside `timeUpdate`
once the matching strangeness upgrades are bought (`strangeness[2][4]≥1` /
`strangeness[4][4]≥1`). Thresholds come from `#vaporizationInput` /
`#collapseInput` settings fields.

The bot pre-configures these once per session via `configureNativeAutomation()`:
- `#vaporizationInput` ← `vaporizeBoost` (same units as boost ratio)
- `#collapseInput` ← `collapseBoost` (production-boost formula, NOT raw mass ratio)

## 4. Bot Architecture

### 4.1 Tick Loop (every 250ms)

```
tick()
  ├── acceptOfflineDialog()        Auto-click "claim" on offline-time popup
  ├── milestoneEngine()            Sets msCtl.hold BEFORE resets consume it
  ├── applySettings()              Confirmations → "None", toggles ON
  ├── configureNativeAutomation()  Write CONFIG thresholds to game inputs
  ├── fastResets()                 Stage-specific small reset (discharge/vaporize/collapse/merge)
  ├── buyEverything()              Buy all structures + upgrades + strangeness
  │   ├── makeAllFooter            Structures
  │   ├── createAllFooter          Upgrades/researches
  │   └── buyStrangenessSmart()    Smart strangeness (current-stage-first)
  ├── slowResets() (every 8s)      Stage reset (#reset1Button) + end reset (#reset2Button)
  ├── exportSaveFile() (every 10s) Click #export to claim Strange quark rewards
  └── updateHud()                  Render side panel
```

**Order matters:** Resets run BEFORE purchases. Until `researchesExtra[2][0]`
is owned, pending cloud gain derives from CURRENT (spendable) Drops — buying
first made the bot vaporize on stale inflated numbers (v1.13.2 fix).

### 4.2 Milestone Engine (L1144-1437)

The most complex subsystem. Runs every tick, reads the game's autosave from
`localStorage['fundamentalSave']` (btoa-encoded JSON, refreshed every 20s by
the game — the milestone DOM spans only update while the Milestones subtab is
open, so the DOM can't be polled for milestone state).

**Flow:**
1. Decode save, extract `milestones[s][i]` (current tiers) and time info
2. For each stage, compute per-tier time limits via `msLimitSec()` using
   `MS_SCALING`/`MS_TIME_BASE`/`MS_TIME_K` constants (mirrored from game source)
3. Find "open" windows: tiers where `current < need` AND `stageTime < limit`
4. For each open window:
   - Track `peak` (highest counter value seen) and `lastImprove` (last >2% gain)
   - **Rate-based reachability** (v1.18.1): after 30s of tracking, compute
     `rate = (peak - startPeak) / elapsed`. If `projectedSec > windowRemaining × 1.5`,
     mark dead and release — prevents holding for mathematically unreachable targets
   - **Stall release**: if no >2% improvement in 12 min (`runStallReleaseMs`),
     mark dead for this run
5. If any open window remains alive → `msCtl.hold = true` (holds stage reset)
6. After ramp phase (`milestoneRampFrac = 0.3` of tightest window), suppress
   discharge/vaporize (own clicks + `toggleAuto1`/`toggleAuto2`)
7. **NEVER suppress collapse** — sim showed 97% of star target from normal
   collapse cadence vs 3% suppressed
8. On failed/stalled window: per-tier retry backoff (30min/1h/3h by peak/need
   ratio, ×2 per consecutive fail, 6h cap), persisted in `localStorage['fbMilestoneBackoff']`

**Console debug:** `window.FundamentalBot.milestoneReport()` dumps live state.

### 4.3 Smart Strangeness (v1.18.0+, L581-666)

Routes the shared quark pool to maximize production:
1. Always click `strange3Stage5` (quark multiplier) first — compounds all future income
2. Compute marginal benefit of hoarding vs spending for each stage:
   `boostLossFraction(quarks, cost, exp)` = production loss if quarks are spent
3. Detect stage-boost gating (is the stage's strangeness gate met?)
4. If a `strangenessTargets` entry is unowned and within its saving window
   (`strangenessTargetTimeoutMs`), hold all other strangeness spending
5. Otherwise: spend on current stage first (highest exponent), then highest→lowest

### 4.4 Stage-Specific Reset Logic

| Stage | Function        | Trigger                                              |
|-------|-----------------|------------------------------------------------------|
| 2     | vaporizeStep()  | `#vaporizationBoostTotal ≥ vaporizeBoost (2.25)`    |
| 4     | collapseStep()  | Primary: `projectedMass/bankedMass ≥ 1.3×`          |
|       |                 | Secondary: `#collapseBoostTotal ≥ collapseBoost (2.0)`|
|       |                 | Star batch: pending remnants ≥ 50 (with 30s gap)    |
|       |                 | Anti-hang: 120s elapsed, boost ≥ 1.0× floor         |
|       |                 | Hard stall: 300s without ANY collapse               |
| 5     | mergeStep()     | `#mergeBoostTotal ≥ mergeBoost (2.0)` or 120s anti-hang|
|       |                 | Self-disables when `strangeness[5][9]≥2` (game auto-merges)|

### 4.5 CONFIG Block (L83-296)

Every threshold has an inline comment explaining WHY it's set that way. This is
the source of truth for all tuning. Key entries:

| Setting | Value | Rationale |
|---------|-------|-----------|
| `tickMs` | 250 | Main loop interval |
| `vaporizeBoost` | 2.25 | Headless sweep; curve flat 2-3 (<6% variance) |
| `collapseMassMultiplier` | 1.3 | Headless sweep; 1.3× beat 2.5× and 5× |
| `collapseStarBatch` | 50 | ≥50 identical to disabling; pre-v1.14 (batch 1) was 2.6× slower |
| `mergeBoost` | 2.0 | Carried from collapse pattern — **unvalidated** for merge |
| `milestoneRampFrac` | 0.3 | Full-window suppression reached 1e-159% of s1 target |
| `runStallReleaseMs` | 720000 (12min) | Declare window dead if no >2% progress |
| `strangenessTargetTimeoutMs` | 600000 (10min) | Per-target saving window before resuming normal buying |

## 5. DOM Reference (Stable IDs)

The game's DOM button IDs are stable across the UI. These are the ones the bot uses:

```
#reset0Button     Discharge/Vaporize/Rank/Collapse/Merge (stage-dependent)
#reset1Button     Stage reset (shows "gain N Strange quarks" when ready)
#reset2Button     End reset
#makeAllFooter    Buy all structures
#createAllFooter  Buy all upgrades/researches
#createAllStrangeness  Buy all strangeness
#vaporizationBoostTotal > span  Stage 2 boost ratio
#collapseBoostTotal > span      Stage 4 production boost
#mergeBoostTotal > span         Stage 5 merge boost
#mainCapS5 > span               Live solar mass (collapseInfo.newMass) — stage 5
#footerStat2Span                Banked solar mass (collapse.mass) — stage 4
#stageWord                      Current stage name text
#export                         Export save (also claims Strange quark rewards)
#vaporizationInput              Native auto-vaporize threshold (bot writes vaporizeBoost)
#collapseInput                  Native auto-collapse threshold (bot writes collapseBoost)
toggleConfirm0..7               Confirmation toggles (Safe→None→All)
toggleAuto0..11                 Game's native automation toggles
toggleNormal0                   Auto-stage-switch toggle
```

**Readiness is read from button text** — reset buttons are never `.disabled`,
they just read "Next goal is...", "Requires...", etc. when not ready.

## 6. Save Structure

Key: `localStorage['fundamentalSave']` → `atob()` → `JSON.parse()`

```
sv = {
  strange: [{ current, total, ... }],     // [0].current = unspent quarks
  buildings: [[[{ total, current, true }]]], // [stage][building_idx]
  discharge: { energy },                   // s1[1] milestone counter
  vaporization: { clouds },                // s2 resource
  collapse: { mass, stars: [...] },        // mass = BANKED (zeroed on collapse)
  mergeInfo: { galaxies, ... },            // s5 merge state
  milestones: [[tier0, tier1], ...],       // [stage][index] = current tier
  time: { stage, vacuum, ... },            // run timers
  progress: { main },                      // see ladder below
  stage: { current, active: [...] },
  strangeness: [[...]],                    // [stage][idx] = upgrade level
  toggles: { auto, supervoid, ... },
}
```

**progress.main ladder** (from `Check.js checkProgress`, non-vacuum):
1=`buildings[1][1].true≥12` · 2=`upgrades[1][9]==1` · 3=`current≥2` ·
4=`clouds>1e4` · 5=`current≥3` · 6=`mass≥5e29` · 7=`current≥4` ·
8=`collapse.stars[1]≥1` · 9=`current≥5` · 10=`active≥5` · 11=`strange[0].total>0`

## 7. Headless Validation

**Before shipping any CONFIG change that affects stage timing, run:**
```bash
cd headless
./build.sh                    # one-time: clone + compile game
node sweep.js                 # compare all strategies against newest save
node sweep.js shipped         # run just the shipped config
node sweep.js --simHours=100  # longer run for more stable numbers
node grid-sweep.js --axis=collapseMult  # single-axis parameter sweep
node milestone-probe.js ship  # milestone-specific validation
```

`sweep.js` loads a real save from `Resources/saves/` and runs the actual compiled
game logic with timewarp (4 hours simulates in <1 second). It uses `engine.js`'s
`vaporBoost()`/`mergeBoost()` helpers (which call the game's own
`Stage.calculateEffects` functions) so the sweep can't drift from what the DOM shows.

**Harness gotchas (from NOTES.md — DO NOT re-derive):**
- `global.offline.active` defaults TRUE in headless → short-circuits `progressMain()`.
  Must set `global.offline.active = false` each tick.
- `progress.main` only advances via `checkProgress()` which the browser calls in
  `visualUpdate()` — the headless driver does NOT call visualUpdate, so it MUST
  call `checkProgress()` manually each tick or progress stays 0 → hard stall at stage 3.

## 8. Ship Workflow

1. Edit `Fundamental.user.js`
2. Bump `@version` in header (only when behavior actually changes)
3. Update `BOT_VERSION` fallback string (keep in sync with `@version`)
4. `node --check Fundamental.user.js` — syntax validation
5. For CONFIG/timing changes: run `headless/sweep.js` to validate
6. Commit with descriptive message
7. `git push origin main`
8. Provide raw install link: `https://raw.githubusercontent.com/ItsMePriddy/fundamental-autoplayer/main/Fundamental.user.js`

The HUD/console/install-URL all read `@version` from `document.currentScript`
at runtime, so there's no separate constant to sync (except the fallback).

## 9. Pitfalls & Lessons Learned

1. **DOM elements built lazily:** Several game panels (Hotkeys, version info) are
   constructed on first open, not at boot. "The compiled source sets its style"
   does NOT mean "the element exists during normal play." Verify with `curl` of
   the live site before gating on element presence.

2. **Save vs live values:** The autosave (`localStorage['fundamentalSave']`) is
   refreshed every 20s by the game. Some values (like `collapse.mass`) are banked
   high-water marks that lag behind live values (`collapseInfo.newMass`). When
   tracking progress, prefer DOM elements that show live values over save fields.
   The milestone engine bug (v1.18.1) was caused by reading banked instead of live.

3. **Reset order matters:** Resets MUST run before purchases. Buying first caused
   stage-2 vaporize to fire on stale inflated boost readings (v1.13.2 fix).

4. **Star batching is critical:** Firing collapse on ANY pending star remnant
   (batch 1) was 2.6× slower than batch ≥50. +1-star collapses wipe production
   before buildings compound.

5. **Collapse is NOT suppressed during milestones:** Normal collapse cadence
   reaches 97% of the star milestone target; suppressing collapses starves
   production to ~3%.

6. **Adaptive vaporize underperforms on stage 2:** The ln(boost)/elapsed rule
   peaks at ~1.05 on Submerged due to cloud divisor + effect softcap. Use fixed
   mode (2.25×).

7. **Tab must stay in foreground:** Game clock freezes in background tabs
   (requestAnimationFrame). Bot shows "paused - tab hidden" and skips actions.

8. **Milestone tables are v0.2.9 constants:** `MS_SCALING`/`MS_TIME_BASE`/
   `MS_TIME_K` in the userscript mirror the game source. A game update can
   silently change them. Re-verify against a fresh compile whenever the game
   version bumps.

9. **Custom bignum:** The game uses a custom `Limit` class for large numbers.
   Transcription risk when reimplementing formulas in the headless harness.
   The sweep intentionally omits the `#collapseBoostTotal` secondary trigger
   for this reason (known, disclosed gap).

10. **`#collapseInput` units differ from `#vaporizationInput`:** Vaporize input
    takes the boost ratio (same as `vaporizeBoost`), but collapse input is
    compared against the production-boost formula (`#collapseBoostTotal`), NOT
    the raw mass ratio. It maps to `collapseBoost`, never `collapseMassMultiplier`.

## 10. Open Items (from HANDOFF.md)

- **Stage 5 merge threshold unvalidated:** `mergeBoost: 2.0` / `mergeMinBoost: 1.2`
  carried from collapse pattern, not derived for merge. Merge has fundamentally
  different cost (resetting true-galaxy count loses exponential production).
- **Fine collapse-multiplier re-sweep:** 1.3× beat 2.5× and 5×, but the 1.1-2.0
  band hasn't been re-swept since star batching stopped dominating.
- **Stage 6 (Abyss):** Fully deferred to game's own automation. No headless data.
- **Milestone engine live-shakedown:** Sim-validated but the userscript
  implementation (autosave polling, toggleAuto handoff, backoff persistence)
  needs live monitoring. `milestoneReport()` is the debug tool.
