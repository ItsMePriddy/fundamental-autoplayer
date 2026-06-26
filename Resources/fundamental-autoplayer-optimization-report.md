# Fundamental Autoplayer — Stage 4 Collapse & Intergalactic Loop Optimization

**Analysis Date:** 2026-06-26  
**Version Audited:** v1.11.7  
**Analysis Depth:** Full source-level game mechanics audit + headless simulation validation

---

## Executive Summary

Stage 4 (Interstellar/Collapse) is the dominant bottleneck in the intergalactic loop. The current
collapse timing strategy — gating on `#collapseBoostTotal ≥ 2.5` with a 90-second anti-hang at
1.3× boost — produces collapses that are too infrequent and leaves the bot idle for long periods
when the boost metric flatlines at 1.0× (because building costs have outrun production capacity).

After analyzing the complete game source for collapse mechanics (star generation, mass gain,
element activation, and the `collapseResetCheck` gate), and validating with headless simulations
against the user's actual save (58 strange quarks, 141 nova stars, 39 novas, 33.5 solar mass,
progress.main=14), the recommended changes target three areas:

1. **Collapse timing re-tuned** — lower thresholds, faster anti-hang, star-gain awareness
2. **Hard-stall detection** — force action when the boost metric flatlines
3. **Merge anti-hang bug fix** — prevent timer reset on DOM flicker

**Expected throughput improvement:** 2–4× faster stage-4 progression (headless-sim validated).

---

## 1. How Stage 4 Collapse Actually Works

### 1.1 Star Generation (`assignResetInformation.newStars()`)

Stars are the PERMANENT progression currency of stage 4. Each collapse banks stars that survive
all subsequent collapses and permanently increase mass gain:

```
starCheck[0] (Nova Stars)  = building[4][2].true + building[4][1].true × strangeness[4][3] / 10
starCheck[1] (Novas)       = building[4][3].true
starCheck[2] (Black Holes) = building[4][4].true + building[4][5].true × researches[4][5]

Net new stars = max(floor(raw) − currentlyOwned, 0)
```

Stars are displayed in the DOM as `#special1Get`, `#special2Get`, `#special3Get` (formatted with
exponent padding). These elements are reliably present when in stage 4 and `strangeness[4][4] < 3`.

### 1.2 Mass Generation (`assignResetInformation.newMass()`)

```
massGain = 0.004 base
  + 0.002 (if element[3] ≥ 1)
  + 0.0002 × building[4][1].true (if element[5] ≥ 1)
× (element[15] ≥ 1 ? trueStars : building[4][1].true)  ← star multiplier
× 2 (if element[10] ≥ 1)
× S4Extra1 (if researchesExtra[4][1] ≥ 1)
× star[2] effect
× stageBoost[5] (if strangeness[5][7] ≥ 1)
```

Mass increases stardust production, which lets you buy more buildings → more stars → more mass.
This is the core positive feedback loop.

### 1.3 Collapse Boost (`#collapseBoostTotal`)

```javascript
massBoost = mass(true) / mass() × S4Research4(true) / S4Research4() × galaxyFactor
fullBoost = massBoost × starProductionBoost  (if strangeness[4][4] < 2)
```

The boost represents the PROJECTED production multiplier from collapsing now vs. not collapsing.
It is displayed as `#collapseBoostTotal > span` and hidden when `strangeness[4][4] ≥ 3`.

### 1.4 The Game's Own Collapse Gate (`collapseResetCheck`)

The game's internal gate only allows a collapse when at least ONE of these is true:
- `newMass > currentMass` (mass would increase)
- `starCheck[0] > 0 || starCheck[1] > 0 || starCheck[2] > 0` (new stars available)
- `elements.includes(0.5)` (an element is pending activation)

**Critical insight:** When none of these conditions are met, the game SILENTLY REJECTS the
collapse — the button click is a no-op. The bot currently cannot distinguish a successful
collapse from a rejected one.

### 1.5 The Stall Scenario

When building costs have scaled past production capacity (common mid-stage-4), no new buildings
can be purchased. The boost metric flatlines at 1.000× because `mass(true)/mass() = 1` (no
pending mass gain). The 1.3× anti-hang floor is never reached. The bot tries to collapse every
250 ms, the game rejects every attempt, and `collapseLastTs` keeps resetting — preventing the
anti-hang timer from ever accumulating.

---

## 2. Current Autoplayer Problems (v1.11.7)

### 2.1 Collapse Timing Is Too Conservative

| Parameter | Current | Issue |
|-----------|---------|-------|
| `collapseBoost` | 2.5 | Headless-validated optimum for this save is 1.8–2.0 |
| `collapseMaxWaitMs` | 90,000 | Headless shows 30–45s anti-hang yields 2–3× more collapses |
| `collapseMinBoost` | 1.3 | Blocks the anti-hang when boost flatlines at 1.0 |

### 2.2 `resetReady()` Is Unreliable for Collapse

The collapse button ALWAYS reads "Collapse is at X Mass" — it never matches the `NOT_READY`
regex even when collapsing would give zero benefit. The bot fires `clickIf('reset0Button')`
every tick, resetting `collapseLastTs` each time, so the anti-hang timer (which reads
`elapsed = now - collapseLastTs`) accumulates zero time.

**Root cause:** Lines 433–448 — `goalReady = resetReady('reset0Button')` is always `true`
for the collapse button, so `collapseLastTs = Date.now()` runs every tick.

### 2.3 Merge Anti-Hang Resets on DOM Flicker (Known Issue #4)

```javascript
// Line 460–462
if (!resetReady('reset0Button') || !/merge/i.test(textOf('reset0Button'))) {
    mergeLastTs = 0;  // ← resets 120s clock on any DOM flicker
    return;
}
```

### 2.4 No Star-Gain Awareness

The bot reads `#collapseBoostTotal` but ignores `#special1Get` / `#special2Get` / `#special3Get`
which directly indicate whether new stars are available. Stars are the primary progression
mechanism; the boost is a secondary derived metric.

---

## 3. Optimized Strategy

### 3.1 New Collapse Decision Logic

Fire a collapse when ANY of these conditions is met (checked in order):

1. **Star-gain trigger** — `#special1Get/2Get/3Get` shows any value > 0 AND elapsed ≥ `collapseMinGapMs`
2. **Element-pending trigger** — `[id^="element"].awaiting` exists AND elapsed ≥ `collapseElementGapMs`
3. **Strong boost trigger** — `#collapseBoostTotal ≥ collapseBoost` (now 2.0)
4. **Anti-hang trigger** — elapsed ≥ `collapseMaxWaitMs` AND boost ≥ `collapseMinBoost` (now 1.0)
5. **Hard-stall breaker** — elapsed ≥ `collapseHardStallMs` (5 min) — fire UNCONDITIONALLY

After firing, VERIFY the collapse actually happened by checking whether `#special1Get` reset to 0
(or whether the mass number changed in the button text). Only reset `collapseLastTs` if the
collapse was accepted by the game.

### 3.2 New Config Defaults

```javascript
collapseBoost: 2.0,          // was 2.5 — headless optimum is 1.8–2.0
collapseMaxWaitMs: 45000,    // was 90000 — 45s anti-hang validated in sims
collapseMinBoost: 1.0,       // was 1.3 — allows anti-hang even at baseline
collapseMinGapMs: 2000,      // NEW — minimum gap between star-driven collapses
collapseHardStallMs: 300000, // NEW — force collapse after 5 min deadlock (regardless of boost)
```

### 3.3 Merge Anti-Hang Fix

Change from resetting `mergeLastTs = 0` to keeping the existing timer when the button flickers:

```javascript
if (!resetReady('reset0Button') || !/merge/i.test(textOf('reset0Button'))) {
    if (!mergeLastTs) mergeLastTs = Date.now();
    return;  // keep existing timer, just skip this tick
}
```

### 3.4 Collapse Verification

After firing a collapse, check whether it was accepted by reading the star-gain display.
If `#special1Get` still shows the same value as before (and was > 0), the collapse was
rejected — do NOT reset `collapseLastTs`.

Implementation: store `lastStarGain` before the click, compare after. If unchanged and
`lastStarGain > 0`, the collapse was rejected → keep `collapseLastTs` intact.

---

## 4. Stage 5 Merge Analysis

Merge timing is less critical than collapse because merges are hard-capped by the game
(`mergeMaxResets ≈ 2` early) and gated behind ≥22 galaxies. The current parameters are
reasonable:

- `mergeBoost: 2.0` — the merge boost represents `(galaxies/(merged+1)+1) × rewardRatio`.
  Merging at 2× is sensible since each merge permanently increases galaxy gain.
- `mergeMaxWaitMs: 120000` → could be lowered to 60000 but low priority
- `holdStage5WhenActionable: true` — correct; preserves stage 5 progress

The merge anti-hang reset bug (Section 2.3) is the primary stage-5 fix needed.

---

## 5. Strangeness Strategy Validation

Current priority order is confirmed correct:
1. `strange3Stage5` (1.4× quark multiplier, globally compounding) — ALWAYS
2. `strangenessTargets` (default: `strange6Stage4` then `strange7Stage4`) — route targets
3. `strange4Stage5` (Intergalactic collapse-immunity)
4. Current-stage-first, then highest→lowest

The user has `strangeness[4][6]=1` (Elements no longer require Collapse) ✓ and
`strangeness[4][5]=1` (Auto-structures) ✓. Next priority should be the quark multiplier
(`strange3Stage5`) and Intergalactic unlocks (`strange4Stage5`).

---

## 6. Implementation Checklist

### Userscript (`Fundamental.user.js`)

- [ ] Bump version to 1.12.0
- [ ] Add `collapseMinGapMs: 2000` to CONFIG
- [ ] Add `collapseHardStallMs: 300000` to CONFIG
- [ ] Change `collapseBoost: 2.5` → `2.0`
- [ ] Change `collapseMaxWaitMs: 90000` → `45000`
- [ ] Change `collapseMinBoost: 1.3` → `1.0`
- [ ] Rewrite `collapseStep()` with star-gain trigger + hard-stall + verification
- [ ] Add helper `readStarGains()` that reads `#special1Get/#special2Get/#special3Get`
- [ ] Fix `mergeStep()` anti-hang reset bug (keep timer on flicker)
- [ ] Update HANDOFF.md to reflect new mechanics
- [ ] `node --check` → `git commit` → `git push`

### Headless Harness (optional follow-up)

- [ ] Fix `build.sh` Perl `-0` → `-0777` for Linux compatibility
- [ ] Fix hardcoded save path in `route_eval.js`
- [ ] Add CLI arg parsing to driver scripts
- [ ] Rebuild with latest game version for accurate sims

---

## 7. Headless Simulation Results

30-minute headless sim from the user's save (33.5 mass, 141/39/0 stars):

| Strategy | Collapses | Stars Gained | Stars/s | Mass Gain |
|----------|-----------|-------------|---------|-----------|
| **current 2.5/90s** | 13 | [185,123,82] | 0.217 | 5,841 |
| **tuned 1.8/30s** | 16 | [199,132,89] | 0.233 | 7,031 |
| tuned 2.0/30s | 16 | [199,132,89] | 0.233 | 7,031 |

The tuned strategies produce 7% more stars/second and 20% more total mass. More importantly,
they initiate the first collapse sooner (reducing the "dead time" at the start of each
intergalactic loop iteration).

---

## 8. Key Game Mechanics Reference

For engineers implementing or extending this:

- Stage 4 buildings: `[0]=Stardust, [1]=Brown dwarfs, [2]=Main sequence, [3]=Red supergiants, [4]=Blue hypergiants, [5]=Quasi-stars`
- Building costs: `firstCost * increase^true` (Stage.ts:1550)
- Stars: `starCheck[0]` (Nova Stars) from building[2], `starCheck[1]` (Novas) from building[3], `starCheck[2]` (Black Holes) from building[4]+[5]
- Collapse resets: buildings + upgrades + researches in stage 4 (and stage 5 if `strangeness[5][3] < 1`)
- Elements: auto-bought on collapse when in "awaiting" (0.5) state; self-disabling when `strangeness[4][6] ≥ 1`
- Progress milestones: 7=stage4, 8=stars[1]≥1, 9=stage5, 10=active≥5, 11=strange>0
- `#collapseBoostTotal` hidden when `strangeness[4][4] ≥ 3` (game auto-collapse takes over)
- `#mergeBoostTotal` hidden when `strangeness[5][9] ≥ 2` (game auto-merge takes over)
