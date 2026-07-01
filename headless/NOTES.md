# Headless mechanics notes (resolved — do not re-derive)

## Critical harness requirements (else progression silently stalls)
- `global.offline.active` defaults to TRUE in a fresh headless init and short-circuits
  `progressMain()` (Special.ts top: `if (progress>=25 || global.offline.active) return`).
  MUST set `global.offline.active = false` (it can get re-set, so clear it each tick).
- `progress.main` is advanced ONLY by `checkProgress()` (Special.ts:1544), which the browser
  calls inside `visualUpdate` (Update.ts:651). The headless driver does NOT call visualUpdate,
  so it MUST call `require('./build/Special').checkProgress()` each tick or `progress.main`
  stays 0 → maxRank capped at 4 → hard stall at stage 3.
- With BOTH fixes, the headless bot progresses stage 1→4 (`progress.main` 0→7) — proving the
  earlier "stall" was a harness artifact, NOT a game limitation. The real browser game (which
  runs visualUpdate) progresses fine; these fixes are headless-only.

## progress.main milestone ladder (checkProgress, non-vacuum; all inflation-free)
prog 1=`buildings[1][1].true>=12` · 2=`upgrades[1][9]==1` · 3=`current>=2` · 4=`clouds>1e4`
· 5=`current>=3` · 6=`Accretion mass buildings[3][0]>=5e29` · 7=`current>=4` · 8=`collapse.stars[1]>=1`
· 9=`current>=5` · 10=`active>=5` · 11=`strange[0].total>0`. checkProgress sets prog to the
highest satisfied (top-down), so reaching `current>=N` can skip the development milestones below.

## Stage progression & activation
- `activeAll` (global.stageInfo.activeAll) in NON-vacuum is effectively ONLY the current stage
  (`[1]`→`[2]`→`[3]`…), not cumulative (Update.ts ~2220, gated by per-stage milestones[s][1]).
  Production/buying only run for activeAll stages → you can't develop a stage once you leave it.
- `current` advances mainly via `researchesExtra[1][2]` (Stage.ts:1432: `current = level[2]>1?2:3`),
  i.e. buying the stage-unlock research auto-advances — so "buy everything" rushes stages before
  they're developed. Other setters: Stage.ts:1527 (current=5), :2645/:2869 (current=4).
- Internal `stageResetCheck(1/2/3/5)` in timeUpdate is gated by `toggles.auto` (OFF by default)
  → with autos off, only manual `*ResetUser` advances. Reaching a stage auto-grants
  `researchesAuto[2]=1` (Stage.ts:1590+) i.e. auto-stage-reset unlocks as you progress.
- maxRank non-vacuum = `progress.main>=6 ? 5 : 4`. Stage 6 (Abyss) needs the inflation tree
  (tree[0][5],[4], darkness) = OUT of scope. Practical non-vacuum target = stages 1-5.

## Per-prestige reset mechanics
- Stage1 discharge: spam (regain always good). Don't gate on `reset0Button` text — it reads
  "Next goal is X Energy" even when dischargeable. True gate `dischargeResetCheck()`:
  `energy<energyTrue || (strangeness[1][4]<2 && energy>=next)`.
- Stage2 vaporization: prestige reset; fire when boost ≥ ~2.25 (headless-validated; curve flat
  2-3, <6%). Boost read from `#vaporizationBoostTotal>span`. Wipes whole stage-2 chain+upgrades
  (keeps researches+clouds). Cloud divisor S2Upgrade2 is large (~3e15 early) so clouds grow slowly.
  NOTE: the adaptive ln(boost)/elapsed rule UNDERPERFORMS here (peaks at ~1.05) — use fixed.
- Stage3 rank: `rankResetCheck` gated by mass ≥ rankCost AND rank<maxRank — safe to attempt.
- Stage4 collapse: requires `upgrades[4][0]==1`; stars gained = `collapseInfo.starCheck[0..2]`
  (set by `assignResetInformation.newStars()`); on collapse it auto-buys "ready" elements
  (value 0.5). Solar mass grows by banking `collapseInfo.newMass` per collapse.
- Stage5 merge: `mergeResetUser`; reward galaxies.

## DOM map (for the userscript / per-stage UI overlay)
- Stage name+color: `#stageWord` (text → ['','Microworld','Submerged','Accretion','Interstellar','Intergalactic','Abyss']).
- Buildings i=1..6: `building{i}Name` / `building{i}Cur` (held) / `building{i}True` (×owned, "[639]")
  / `building{i}Prod` (rate) / `building{i}BuyX` (×N or "Locked") / `building{i}Btn` ("Need: X" / "Unlocked with Upgrade").
- Resets: `reset0Main`/`reset0Button` (discharge/vaporize/rank/collapse/merge/nucleation, stage-dependent),
  `reset1Main`/`reset1Button` (stage reset, shows requirement + "gain N Strange quarks"), `reset2Button` (end reset).
- Boost spans: `#vaporizationBoostTotal>span` (s2), `#collapseBoostTotal>span` (s4, only when strangeness[4][4]<3), `#mergeBoostTotal>span` (s5).
- Footer resource stats: `footerStat1/2/3` are STAGE-DEPENDENT (e.g. stage3 = Mass / Missing / Missing),
  so cross-stage values (clouds/drops while in another stage) are NOT always present — verify per use.
- Buy/auto controls: `makeAllFooter`, `createAllFooter`, `createAllStrangeness`, `toggleAll`,
  `toggleAuto0..11`, `toggleVerse0`, `toggleNormal0`, `toggleConfirm0..7` (Safe→None→All), `stageSwitch1..6`.

## Status
- The headless build is reproducible via `./build.sh`; `engine.js` carries the
  offline-flag + `checkProgress` fixes documented above.
- `sweep.js` is the canonical validation tool (see `headless/README.md`) — it
  loads a real save and compares named CONFIG-threshold strategies against each
  other, using `engine.js`'s `vaporBoost()`/`mergeBoost()` helpers so the sweep
  can't silently drift from what the DOM actually shows in-game.
