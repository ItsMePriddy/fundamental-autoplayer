# Stage 5 (Intergalactic/Merge) Mechanics Analysis & Optimization Strategy

> **Status: open, not implemented.** `Fundamental.user.js` still ships `mergeBoost: 2.0` /
> `mergeMinBoost: 1.2` unchanged — nothing here has shipped yet. Treat the specific
> thresholds in this doc as unvalidated: Section 3.3 derives a required boost around
> `base^true_g` (thresholds like 1e6-1e30x), while Section 9.1's practical rule says
> "roughly `base` (2-6x)" — those disagree by many orders of magnitude and the doc
> doesn't reconcile them. Don't ship a merge-threshold change from this analysis alone;
> validate candidate thresholds with `headless/sweep.js` against a save that has reached
> true vacuum first (the mechanics below are otherwise a solid reference).

> **Date**: June 27, 2026  
> **User State**: Stage 4, 1793.8 solar mass, [268,123,50] stars, 59.6 strange quarks (1.6 current), progress.main=14, element 26 (Iron)=0, **no stage 5 access yet**

---

## 1. The Intergalactic Loop — End-to-End Mechanics

### 1.1 Loop Architecture

The "intergalactic loop" is the core late-game progression cycle:

```
Stage 4 (Interstellar) → Stage 5 (Intergalactic) → [first merge → true Vacuum] → Merge resets → Stage reset → Stage 1 → 2 → 3 → 4 → 5 → ...
```

**Detailed flow**:

1. **Stage 4 → Stage 5 entry**: Requires `elements[26] >= 1` (Iron) in false vacuum, or `strangeness[5][3] >= 1` in true vacuum. Stage 5 gives access to Galaxies (building index 3) which cost Collapse mass.

2. **First Merge (Collapse Vacuum)**: When you have `upgrades[5][3] == 1` (Galactic Merger, costs 1e5 stardust) and `true_galaxies >= mergeRequirement()`, the merge changes the vacuum from false→true. This is a one-time transition.

   - `mergeRequirement() = 22 + trueUniverses` (or `22 + stability` in challenge)
   - The merge collapses the false vacuum into true vacuum, unlocking all stages simultaneously and enabling the full merge+stage-reset loop.

3. **Subsequent Merges (in true Vacuum)**: Each merge converts true galaxies into Galaxy Groups (reward[0]) and Star Clusters (reward[1]), resetting stages 4-5 (and possibly 1-3). This provides production boosts via:
   - `reward[0]` → multiplies galaxy stardust production
   - `reward[1]` → increases the clusterEffect exponent
   - `mergeScore` increases → enables Universe creation

4. **Stage Reset from Stage 5**: Resets all stages (1-5, or 1-6), awards Strange quarks based on galaxies + multipliers, and loops back to stage 1 (or 2/3/4 if milestones skip stages).

5. **Repeat**: Each loop earns more quarks → buys strangeness[5] upgrades → stronger galaxies → more quarks → ...

### 1.2 When Stage 5 Becomes Active

From `Stage.js` `stageResetCheck(5)` and `setActiveStage`:

- **False vacuum**: Stage 5 is only accessible when `stage.current >= 5`. This requires stage-resetting from stage 4 at least once (stage 4 reset → current=5).
- **True vacuum**: All stages 1-5 (and 6) are always active simultaneously (`activeAll` includes all stages).

### 1.3 Stage 5 Production Chain

Stage 5 has 4 buildings:
| Index | Building | Produces | Cost scaling |
|-------|----------|----------|-------------|
| 0 | Stardust | — | (from stage 4) |
| 1 | Stars | Stardust | 2.0× per level |
| 2 | Nebulas | Stars | 2.0× per level |
| 3 | Galaxies | Collapse mass | 1.11× per level (modified by elem 32, challenge) |

**Galaxy Production formula** (from `stage5Cache()`):

```
production = base ^ true_galaxies × multiplier
```

where:
- `base = (vacuum ? 2 : 6) + S5Upgrade2()`
- `S5Upgrade2 = log₁₀(max(mass/1e4, 10)) / (vacuum ? 4 : 2)`
- `multiplier = (total_galaxies + 1) / (true_galaxies + 1) × reward[0]() × ...`
- Various upgrades multiply this further (S5Upgrade0, S5Upgrade1, S5Research2, S5Research3, etc.)

**Critical insight**: The base is raised to the power of `true_galaxies`, making galaxies provide exponential production growth. Each true galaxy multiplies stardust production by `base` (e.g., base=2→6 means each galaxy doubles to 6× production).

---

## 2. Merge Mechanics — Deep Dive

### 2.1 mergeResetCheck() Flow

```
mergeResetCheck(rewards):
  IF upgrades[5][3] != 1 → return false
  
  IF NOT vacuum AND (rewards===null OR tree[0][5]<1 OR challenge===1):
    IF rewards===true OR galaxies < mergeRequirement() → return false
    IF rewards===null:
      IF strangeness[5][9] < 1 → return false  // need auto-merge
      mergeReset(true)  // FIRST MERGE: collapse vacuum!
    return true
  
  // In true vacuum (or stabilized false vacuum):
  IF rewards===null → return false  // auto-check only fires with rewards
  
  // Compute rewards:
  mergeReward() → sets checkReward[0], checkReward[1]
  
  IF rewards===true:
    // Auto-claim rewards without merging:
    IF strangeness[5][9] >= 2 → claim rewards to permanent
  
  // Check merge conditions:
  IF resets >= mergeMaxResets() → return false
  IF !auto[9] → return false
  IF strangeness[5][9] < 1 → return false
  IF since < input[1] → return false  // time gate
  IF galaxies < input[0] → return false  // galaxy gate
  mergeReset()  // STANDARD MERGE
  
  return galaxies >= 1 AND resets < mergeMaxResets()
```

### 2.2 mergeRequirement() and mergeMaxResets()

```javascript
mergeRequirement = 22 + (challenge===1 ? stability : trueUniverses)
```

The first merge requires 22+ true galaxies (with no universes).

```javascript
mergeMaxResets(safe):
  base = 2 + researchesExtra[5][3]
  if elements[30] >= 1: base += highestElement - 29
  if safe: return base
  if tree[0][5] >= 1: base += trueUniverses()
  return base
```

- **Safe resets**: The base amount (2 + research). You can always do this many.
- **Non-safe resets**: Additional resets from universes (tree[0][5]). These increase Universe cost.

### 2.3 mergeReset() — What Happens

```javascript
mergeReset(vacuumChange=false):
  IF vacuumChange (first merge):
    Set inflation.vacuum = true
    Reset vacuum (resets all stages, sets active=1)
    Increment cosmon count
  
  ELSE (standard merge):
    merge.resets++
    Convert true galaxies → rewards[0] (groups) and rewards[1] (clusters)
    Reset buildings[5][3].true = 0
    Reset stages 4-5 (and 1-3 if tree[1][5] < 4)
    Reset researches for stage 4
    Stage.current = 6 (Abyss, unlocks stage 6 access)
```

### 2.4 mergeReward() — Reward Calculation

```javascript
mergeReward():
  requirement = groupsCost() = 50 - S5Extra5()
  // S5Extra5(level) = (19 - level) * level / 2, max 45 at level 9-10
  
  checkReward[0] = // Galaxy Groups
    if researchesExtra[5][1] >= 2:
      floor(total_galaxies / requirement) - rewards[0]
    elif researchesExtra[5][1] >= 1:
      floor(true_galaxies / requirement) - claimed[0]
    else: 0
  
  checkReward[1] = // Star Clusters
    if researchesExtra[5][4] >= 2: 
      floor(total_galaxies / 100) - rewards[1]
    elif researchesExtra[5][4] >= 1:
      floor(true_galaxies / 100) - claimed[1]
    else: 0
```

- **Galaxy Groups** cost 50 galaxies each (reducible to 5 with max S5Extra5).
- **Star Clusters** cost 100 galaxies each.
- At `researchesExtra[5][1] >= 2` (and `[5][4] >= 2`), rewards use TOTAL galaxies (including previous merge rewards), making each subsequent merge more powerful.

### 2.5 reward[0] and reward[1] — The Production Boost

```javascript
reward[0](post, clusterEffect = reward[1]()):
  groups = post ? rewards[0] + checkReward[0] : rewards[0]
  return ((groups + 1) × S5Extra2(level, groups)) ^ clusterEffect

reward[1](post):
  clusters = post ? rewards[1] + checkReward[1] : rewards[1]
  return 1 + clusters / 10

S5Extra2(level, groups) = (8 + level × groups) / 8
```

**reward[0]** is the galaxy group multiplier that boosts stardust production. It grows super-exponentially:
- At 0 groups: reward[0] = 1^clusterEffect = 1
- At 10 groups, S5Extra2=3 (level 2): reward[0] = (11×3)^clusterEffect = 33^clusterEffect
- At 100 groups: ~ (101×26)^clusterEffect = 2626^clusterEffect

**reward[1]** is the clusterEffect exponent: each 10 clusters add +1 to the exponent, making reward[0] grow even faster.

### 2.6 The "#mergeBoostTotal" Threshold

From `Update.js` line 350, displayed as the merge boost:

```
mergeBoost = (true_g / (total_g + 1) + 1) × 
             (reward[0](true, reward[1](true)) / reward[0]())
```

This approximates the post/pre merge production ratio from the galaxy multiplier component. It does NOT include:
- The loss of `base^true_galaxies` (exponential production from true galaxies)
- The star/nebula/cluster production multipliers

**Current threshold recommendation (2.0)**: The merge is worthwhile when this displayed boost ≥ 2.0×. However, this threshold is conservative — the actual total boost includes the galaxy base exponent loss.

---

## 3. Optimal Merge Boost Threshold

### 3.1 The Full Production Ratio

Pre-merge galaxy production component:
```
P_before ∝ base^true_g × (total_g + 1)/(true_g + 1) × reward[0](current)
```

Post-merge:
```
P_after ∝ base^0 × (total_g - true_g + 1)/1 × reward[0](new_groups, new_clusters)
```

Total production ratio:
```
R = base^(-true_g) × (total_g - true_g + 1)/(total_g + 1) × (true_g + 1) × 
    reward[0](new) / reward[0](current)
```

The displayed mergeBoost approximates the last two terms. The first term `base^(-true_g)` is critical — it represents the loss of exponential production from true galaxies.

### 3.2 When base^(-true_g) Matters

- **Low base** (base ≈ 2): Each true galaxy doubles production. Losing 10 true galaxies costs 2^10 = 1024× production. The merge groups must provide >1024× boost to break even.
- **High base** (base ≈ 20+ with high mass and upgrades): Each galaxy provides 20×. Losing 10 galaxies costs 20^10 ≈ 10^13×. The rewards must be enormous.

**However**, the reward[0] formula is super-exponential. With enough groups, it can overcome the base^true_g loss.

### 3.3 Optimal Threshold Derivation

For a merge to be worthwhile:
```
base^(-true_g) × (galaxies_remaining_factor) × reward[0](new) / reward[0](old) ≥ 1
```

Solving for the case where rewards come from total_galaxies (researchesExtra[5][1] ≥ 2):

```
reward[0](new) / reward[0](old) ≥ base^true_g / (galaxies_factor)
```

With reward[0](new) = ((groups_old + groups_new + 1) × S5Extra2) ^ (1 + clusters/10 + clusters_new/10) and reward[0](old) = ((groups_old + 1) × S5Extra2) ^ (1 + clusters/10), the reward ratio is approximately:

```
reward_ratio ≈ ((groups_old + groups_new + 1) / (groups_old + 1)) ^ clusterEffect
```

For typical early-stage-5 values (groups=0-5, clusters=0-2, base=2-6, true_g=22-30):

| Scenario | true_g | base | groups gained | reward_ratio needed | reward_ratio achieved | Optimal? |
|----------|--------|------|---------------|---------------------|----------------------|----------|
| First merge | 22 | 2-6 | 0-1 | 2^22≈4e6 | ~1 (no groups yet) | **Yes (required)** |
| Early merge | 30 | 3 | 2-3 | 3^30≈2e14 | ~27 (at 3 groups, 0 clusters) | **No** |
| Mid merge | 40 | 4 | 5-8 | 4^40≈1e24 | ~10^8 | **No** |
| Late merge (50 groups) | 50 | 5 | 5-10 | 5^50≈9e34 | ~10^15 | **No** |
| Endgame (100 groups) | 30 | 6 | 3-5 | 6^30≈2e23 | ~10^30 | **Yes** |

**Key finding**: The displayed 2.0× threshold is **too low** for early stage 5 play! The real threshold should account for the base^true_g loss. A better rule:

```
Optimal displayed mergeBoost ≥ base^true_g / (galaxies_remaining)
```

For early stage 5 with base ≈ 3 and true_g ≈ 25: threshold ≈ 3^25 ≈ 8.5e11. This is enormous and essentially means **don't merge until you have significant group rewards accumulated from previous merges**.

### 3.4 Practical Merging Strategy

**Phase 1: First merge** (required)
- Merge at exactly `mergeRequirement()` galaxies (22+)
- This transitions vacuum, no choice

**Phase 2: Post-first-merge**
- DO NOT merge again immediately
- Build up galaxies (true + current), let them accumulate
- Galaxy production is exponential in true_g; wait as long as possible
- When `reward[0]()` becomes enormous (from accumulated groups), THEN a merge converts true galaxies into more groups at favorable rates
- Rule of thumb: merge when reward[0]() ≥ base^true_g × 10

**Phase 3: Multiple merges**
- With `strangeness[5][9] >= 2`, auto-claim rewards without resetting — this is the key breakthrough
- At this point, you can accumulate groups/clusters permanently while keeping galaxies
- The merge becomes about the `mergeMaxResets` limit rather than production optimization

### 3.5 Recommended Thresholds

| Game Phase | Displayed mergeBoost | Notes |
|------------|---------------------|-------|
| Pre-strangeness[5][9]=2 | **≥ 1e6** | Need massive reward accumulation |
| Post-strangeness[5][9]=2 | ≥ 2.0 | Auto-claim eliminates tradeoff |
| Approaching mergeMaxResets | **Any** | Must merge to reset counter |
| Before Stage Reset | **≥ 5.0** | Don't waste merge on low boost |

---

## 4. Optimal Galaxy-Buying Strategy

### 4.1 Galaxy Cost Structure

Galaxies are bought with Collapse mass (not stardust):
- First cost: 1e50 stardust... wait, let me re-check.

Actually, looking at `calculateBuildingsCost` and `buyBuilding`:

```javascript
// Stage 5, index 3 (Galaxies):
currency = player.collapse.mass  // Paid with Collapse mass!
multi = false  // Buy one at a time
```

The cost formula for building index 3 in stage 5:
```
cost = firstCost × increase ^ true_galaxies
firstCost = 1e5  // from Player.js line 331
increase = 1.11  // from Player.js line 341
```

But there are cost modifiers:
```javascript
if (elements[32] >= 1): increase -= 0.01  // 1.10
if (challenge === 0): increase += 0.05     // 1.16 (in Void)
if (challenge === 1): increase += 0.01     // 1.17
if (elements[36] >= 1): firstCost /= 1.21
```

So galaxy N costs: `firstCost × increase^(N-1)` mass.

### 4.2 Mass Production vs Galaxy Affordability

Galaxies cost mass, and each galaxy boosts stardust production (which eventually buys more buildings → more mass). The cycle:
1. Collapse to get mass
2. Spend mass on galaxies
3. Galaxies boost stardust → more buildings → more stars → more mass on next collapse

The cost of galaxy N+1 vs galaxy N:
```
cost(N+1) / cost(N) = increase ≈ 1.11
```

The production boost from adding galaxy N+1:
```
P(N+1) / P(N) = base  // Each galaxy multiplies production by base
```

**Optimal when**: `base > increase`, i.e., when each galaxy provides more production than its cost increase. Since `base ≈ 2-6` (and growing) and `increase = 1.11` (fixed), **galaxies are ALWAYS worth buying** in terms of marginal ROI.

### 4.3 Galaxy Rush vs Balanced Building

The production chain is:
```
Galaxies → Nebulas → Stars → Stardust → (back to stage 4 buildings) → Collapse → Mass → more Galaxies
```

Galaxies boost ALL of stage 5 (stars, nebulas, plus themselves via S5Research3). Stars and nebulas also boost each other. The optimal ratio depends on your current building levels but generally:

- **Priority 1**: Get Stars (b1) and Nebulas (b2) to reasonable levels first — they multiply galaxy production
- **Priority 2**: Galaxies (b3) — provides exponential scaling
- **Priority 3**: Balance Stars/Nebulas/Galaxies as the production chain saturates

The optimal galaxy count is when the marginal mass cost of the next galaxy equals the expected mass gain from the production boost over a collapse cycle. In practice: **buy galaxies whenever you can afford them** (after maintaining a healthy star/nebula base).

### 4.4 Galaxy Buying in Different Vacuum States

- **False vacuum**: Galaxies are harder to maintain (only stage 5 active). Priority: build enough for first merge.
- **True vacuum**: All stages active. Galaxies boost everything via `strangeness[5][10]` passives. **Buy aggressively**.

---

## 5. strangeneness[5] Upgrades — Priority Analysis

### 5.1 Complete Upgrade Table

| idx | Name | Effect | Max | First Cost | Scaling | Type |
|-----|------|--------|-----|-----------|---------|------|
| 0 | Bigger Structures | 1.6× to first two Structures per level | 8 | 24 | 2 | Linear |
| 1 | Higher density | 1.8× to first two Upgrades per level | 8 | 36 | 2 | Linear |
| 2 | Strange gain | 1.4× Strange quarks from resets | 2 | 4 | 4 | **Exponential** |
| 3 | Gravitational bound | Immune to Collapse / Unlock Stage 5 | 1 | 24 | 1 | Linear |
| 4 | Automatic Galaxy | Auto Collapse for Galaxies | 1 | 15600 | 1e308 | Linear |
| 5 | Auto Structures | Permanent auto for first two | 1 | 24 | 1 | Linear |
| 6 | Automatic Stage | Auto Stage reset | 1 | 480 | 1 | Linear |
| 7 | Strange boost | Quarks boost Solar mass (^0.06) | 1 | 120 | 5e13 | **Exponential** |
| 8 | Strange growth | Unlock Strangelets | 1 | 6000 | 1e308 | Linear |
| 9 | Automatic Merge | Auto Merge Galaxies | 1 | 6e6 | 1e308 | Linear |
| 10 | Galactic tide | Boost lower Stages by Galaxies | 3 | 2e7 | 3 | Linear |

### 5.2 Cost Calculation (Linear vs Exponential)

**Linear** (`scalingType=false`): cost = `firstCost + scaling × currentLevel`
**Exponential** (`scalingType=true`): cost = `firstCost × scaling^currentLevel`

Additionally, the "Strange boost" series (index 6 for stages 1-2, index 7 for stages 3-5) gets cost multiplied by `100^total` where total = number of stage-boosts at level ≥ 2 across stages 1-5. This is a cross-stage penalty.

### 5.3 Costs for Each Level

| idx | Level 0→1 | 1→2 | 2→3 | 3→4 | 4→5 | 5→6 | 6→7 | 7→8 | Total (8) |
|-----|-----------|-----|-----|-----|-----|-----|-----|-----|-----------|
| 0 | 24 | 26 | 28 | 30 | 32 | 34 | 36 | 38 | 248 |
| 1 | 36 | 38 | 40 | 42 | 44 | 46 | 48 | 50 | 344 |
| 2 | 4 | 16 | — | — | — | — | — | — | 20 |
| 3 | 24 | — | — | — | — | — | — | — | 24 |
| 7 | 120 | (5e13×120) | — | — | — | — | — | — | 120 |

### 5.4 Priority Ranking for User (59.6 total, 1.6 current quarks)

**CRITICAL**: Strangeness is bought with **current** strange quarks, not total. The user has 59.6 total but only 1.6 current. They MUST do stage resets to accumulate current quarks before buying anything.

#### Tier 0: Must-Buy First (enablers)

1. **idx3 — Gravitational Bound** (24 quarks) — TOP PRIORITY
   - In false vacuum: Makes Stage 5 immune to Collapse reset AND allows auto-upgrades to work. Without this, every Collapse resets your stage 5 progress.
   - In true vacuum: Unlocks Intergalactic Stage directly and gives +1 to quarks from stage resets.
   - Cost: 24 quarks (one-time).

2. **idx2 — Strange Gain** (4, then 16) — SECOND PRIORITY
   - First level: 4 quarks → 1.4× quarks from all stage resets. Pays for itself after ~3 stage resets.
   - Second level: 16 quarks → 1.4^2 = 1.96× total. Pays for itself after ~5-6 stage resets.
   - This is the only exponential-scaling strangeness in stage 5 — get both levels ASAP.

#### Tier 1: Core Power (production multipliers)

3. **idx0 — Bigger Structures** (24-50 for 2 levels)
   - Boosts Stars and Nebulas by 1.6× per level. These multiply galaxy production.
   - Level 1: 24 quarks (1.6×)
   - Level 2: 26 more (2.56× total)
   - At these costs, levels 1-2 are efficient. Higher levels face diminishing returns.

4. **idx1 — Higher density** (36-74 for 2 levels)
   - Boosts S5Upgrade0 and S5Upgrade1 by 1.8× per level.
   - S5Upgrade0 = 3 × 1.8^level (boosts Stars)
   - S5Upgrade1 = 2 × 1.8^level (boosts Nebulas)
   - Level 1: 36 quarks
   - Level 2: 38 more

#### Tier 2: Automation (QoL + sustained progression)

5. **idx5 — Auto Structures** (24 quarks)
   - Makes auto-buy for first two structures permanent.
   - Without strangeness[5][4], only first two structures auto-buy. With idx4, all structures auto-buy.
   - Cost: 24 quarks

6. **idx6 — Automatic Stage** (480 quarks)
   - Auto triggers stage resets. Essential for idle/headless play but expensive.
   - Requires `strangeness[5][6] >= 2` in false vacuum for stage 5 auto-reset.
   - Cost: 480 quarks — **save for later**

#### Tier 3: Late-Game Power

7. **idx7 — Strange boost** (120 quarks)
   - Total strange quarks boost Solar mass gain by ^0.06. 
   - At 100 quarks: 100^0.06 = 1.32×. At 1000: 1000^0.06 = 1.51×. Modest.
   - Cost: 120 quarks

8. **idx9 — Automatic Merge** (6e6 quarks)
   - Automatically merges galaxies. Requires `strangeness[5][9] >= 2` for auto-claim (no reset needed).
   - Cost: 6,000,000 quarks — **endgame only**

9. **idx4 — Automatic Galaxy** (15600 quarks)
   - Auto-collapses when able to afford new galaxy. Removes solar mass limit.
   - Cost: 15,600 quarks — **post-stage-5 content**

10. **idx8 — Strange growth** (6000 quarks)
    - Unlocks Strangelets from stage 5 resets. Second currency.
    - Cost: 6,000 quarks

11. **idx10 — Galactic tide** (2e7+)
    - Boosts lower stages based on galaxies. Unlocks new upgrades.
    - Cost: 20,000,000+ quarks — **very endgame**

### 5.5 Recommended Purchase Order

With 59.6 total quarks (need to stage-reset to convert to current):

```
1. idx3  (Gravitational bound)  → 24 quarks  [ENABLER: prevents collapse from wiping stage 5]
2. idx2  (Strange gain) Lv1     →  4 quarks  [ROI: 1.4× quarks, pays back in ~3 resets]
3. idx2  (Strange gain) Lv2     → 16 quarks  [ROI: 1.96× quarks, pays back in ~6 resets]
4. idx0  (Bigger Structures) Lv1 → 24 quarks [1.6× production]
5. idx5  (Auto Structures)      → 24 quarks  [QoL: permanent auto-buy]
6. idx1  (Higher density) Lv1   → 36 quarks  [1.8× upgrades]
7. idx0  (Bigger Structures) Lv2 → 26 quarks [2.56× total production]
8. idx1  (Higher density) Lv2   → 38 quarks [3.24× total upgrades]
```

Total through step 5: **92 quarks** (need more than current 59.6). Total through step 3: **44 quarks** (affordable).

**First batch (within 59.6 total budget)**: idx3 (24) + idx2 Lv1 (4) + idx2 Lv2 (16) = **44 quarks**

After these, the user earns 1.96× more quarks per stage reset, accelerating further purchases.

---

## 6. When to Stage-Reset from Stage 5

### 6.2 The Universe Path (Better than Stage Reset)

**Creating a Universe is the optimal way to cash out merge progress:**

```javascript
verseCost = 120 × 1.5^trueUniverses
if (resets > maxSafe): verseCost *= (resets+1)/(maxSafe+1)
mergeScore = galaxies + groups×2 + clusters×4
```

When `mergeScore ≥ verseCost`, you can create a Universe. This:
1. Gives `ceil(trueUniverses^1.5)` current strange quarks
2. Grants free strangeness upgrades at universe thresholds (8, 13, 21)
3. Resets true vacuum to false (if in vacuum)
4. Increments universe count

**Universe thresholds for free strangeness[5]:**
- **8 universes**: FREE `strangeness[5][6] = vacuum ? 1 : 2` (Auto Stage Reset — saves 480 quarks!)
- **13 universes** (in vacuum): FREE `strangeness[5][8] = 1` (Strangelets — saves 6000 quarks!)
- **21 universes**: FREE `strangeness[5][9] = 1` (Auto Merge — saves 6,000,000 quarks!)

**Strategy**: The mergeScore from a single good merge run can afford the first several universes (cost 120, 180, 270...). Target 8 universes FIRST — the free strangeness[5][6] unlocks auto-stage-reset which transforms gameplay.

### 6.3 Growth Rate Analysis

The strange quarks gained from a stage 5 reset:

```javascript
quarks = strangeGain(interstellar=true, quarks=true)
```

Expanding:
```javascript
base = vacuum ? (strangeness[5][3]>=1 ? 5 : 4) : (milestones[1][0]>=6 ? 2 : 1)
if interstellar:
  base = (base + element26) × strangeMultipliers
  // element26 ≈ log10(trueTotal_stardust) - 48 (capped at 0)
base *= 1.4^strangeness[5][2] × 1.4^tree[0][2] × 1.2^tree[1][1]
```

The strangeMultipliers in vacuum (from `quarksGain()`):
```javascript
multiplier = (galaxies + 1) × S5Extra2(researchesExtra[5][2])
// where S5Extra2(level, groups = rewards[0]) = (8 + level × groups) / 8
```

Note: `S5Extra2` is called with just the research level, defaulting `groups` to current `rewards[0]`. So groups actively boost quarks earned.

Full quark formula for stage 5 reset:
```
quarks = base_vacuum × (base_interstellar + element26) × (galaxies+1) × S5Extra2 × multipliers × 1.4^strangeness[5][2] × 1.4^tree[0][2] × 1.2^tree[1][1]
```

### 6.4 Cycle Time vs Quark Growth

From `stageResetCheck(5, quarks)`:

```javascript
// Requirements to NOT auto-reset (i.e., conditions under which auto-reset is BLOCKED):
if !auto[0] → BLOCKED (auto stage reset disabled)
if strangeness[5][6] < (vacuum ? 1 : 2) → BLOCKED
if challenge !== null → BLOCKED
if (normal[4] && auto[9] && upgrade[5][3] && strangeness[5][9]>=1 && 
    merge.input[0]<=0 && can_merge && merge.resets < mergeMaxResets) → BLOCKED
// (This means: if you can still merge, don't stage-reset yet)
```

Then checks `stage.input[which]` against thresholds (time, quarks, peak).

### 6.5 Optimal Reset Strategy

**When you CAN still merge** (`merge.resets < mergeMaxResets`):
- **Merge to boost production** within this run. Merging converts true galaxies into temporary groups/clusters that accelerate galaxy rebuilding.
- **Check Universe affordability**: If `mergeScore ≥ verseCost`, consider creating a Universe for free quarks + upgrades rather than merging more.
- If the displayed merge boost is low (< 2.0×), you may be better off continuing to accumulate galaxies rather than merging.

**When you CANNOT merge** (hit mergeMaxResets):
- **Check if you can afford the next Universe** — if yes, create it!
- **Otherwise, stage-reset**. The peak is reached when quarks/second stops growing.
- Track `quarks_gained / stage.time` — if it's declining, you've passed the peak.

**Practical rule for headless**:
1. Merge when displayed boost ≥ 2.0 and merges remain
2. Create Universe when mergeScore ≥ verseCost
3. Stage-reset when merges exhausted AND no Universe affordable
4. Target 8 universes for free strangeness[5][6]

### 6.6 The Peak Detection Formula

Track `quarks_gained / stage_time_elapsed`. The instantaneous rate is `d(quarks)/dt`. When this starts declining, you've passed the optimal reset point.

For auto-reset: set `stage.input[2]` (time-based) to a value slightly past the expected peak, and `stage.input[3]` (peak-based) to capture the peak quarks/second.

---

## 7. User's Immediate Action Plan

### 7.1 Prerequisites for Stage 5

The user needs **element[26] (Iron) ≥ 1** to enter Stage 5. Currently at element 17 (Chlorine). Need 9 more elements.

Action plan:
1. **Continue Collapse cycles** in Stage 4
2. **Level up researches[4][5]** (Proton capture) to increase element creation speed
3. **Build Quasi-stars** (b5, costs 1e50 stardust) to get black holes → more mass → faster elements
4. Elements are created during Collapse based on mass; higher mass = more elements created
5. At 1793.8 mass, can probably reach element 26 in 5-10 more collapses with good building counts

### 7.2 After Reaching Stage 5

1. **Buy upgrade[5][3]** (Galactic Merger, 1e5 stardust) — enables merging
2. **Buy researchesExtra[5][0]** (galaxy cost info) and [5][1] (groups)
3. **Accumulate 22+ true galaxies** for first merge
4. **First merge at exactly 22 galaxies** — transitions to true vacuum
5. **In true vacuum**: Build galaxies aggressively, merge when boost ≥ 2.0×
6. **Target 8 Universes**: Accumulate mergeScore to create universes. First universe costs 120 mergeScore (reachable with ~120 galaxies or equivalent groups/clusters). Prioritize reaching 8 universes for free `strangeness[5][6]`.
7. **Buy strangeness[5][3]** (24 quarks) — prevents collapse from wiping stage 5
8. **Buy strangeness[5][2]** both levels (20 quarks) — 1.96× quarks
9. **Then follow priority list** from Section 5.5

### 7.3 Headless Automation Notes

For the headless harness:
- Stage 5 requires `activeAll.includes(5)` which is true after first merge (true vacuum)
- Auto-merge: `strangeness[5][9] >= 1` — FREE at 21 universes! Or costs 6e6 quarks
- Auto-stage-reset: `strangeness[5][6] >= 2` in false vacuum, or `>= 1` in true vacuum — FREE at 8 universes!
- Auto-galaxy-buy: `strangeness[5][4] >= 1` — costs 15600 quarks (save for later)
- The `merge.since` timer tracks time since last merge; useful for gating
- `merge.input[0]` = minimum galaxies to merge (0 = auto), `merge.input[1]` = minimum time between merges
- Universe creation auto-fires when `toggles.verses[0]` is enabled AND `universes.current >= 21`

---

## 8. CRITICAL CORRECTION: Merge Rewards Are TEMPORARY

**Merge rewards (groups and clusters) are WIPED on stage reset.** This was verified from `Reset.js` line 210-215 and 359-363. Merge rewards exist only within a single stage 5 run and are lost when you stage-reset.

### The True Purpose of Merging

Merges serve THREE purposes within a stage 5 run:

1. **Production acceleration**: Groups/clusters boost galaxy production, letting you reach higher galaxy counts before the eventual stage reset.
2. **Universe creation**: `mergeScore = galaxies + groups×2 + clusters×4` must exceed `verseCost` to create Universes. Universes give free strange quarks and automatic strangeness upgrades.
3. **Quark maximization**: More galaxies at stage-reset time = more strange quarks earned.

### Universe Thresholds (Free Strangeness[5] Upgrades)

From `Reset.js` (resetVacuum), creating Universes automatically grants:

| Universes | Free Upgrade |
|-----------|-------------|
| ≥ 8 | `strangeness[5][6] = vacuum ? 1 : 2` (Auto Stage Reset) |
| ≥ 13 (vacuum) | `strangeness[5][8] = 1` (Strangelets) |
| ≥ 21 | `strangeness[5][9] = 1` (Auto Merge) |

Additionally, `universes >= 1`: gain `ceil(trueUniverses^1.5)` current strange quarks.

---

## 9. Summary of Key Findings (Corrected)

### 9.1 Merge Boost Threshold
- The displayed "#mergeBoostTotal" (2.0×) is a **within-run production multiplier** — it compares post-merge production to pre-merge production for the galaxy-multiplier component only.
- It does NOT account for the `base^true_g` loss from resetting true galaxies to 0.
- **The 2.0× threshold is only useful as a rough guide when you have strangeness[5][9]≥2** (auto-claim without resetting).
- **Better rule**: Merge when the production boost from rewards lets you rebuild galaxies to at least `mergeRequirement()` galaxies in less time than it took to build them initially. This is roughly when the displayed boost exceeds `base` (typically 2-6×).

### 9.2 Galaxy Buying
- **Always buy galaxies when affordable** (marginal ROI is always positive)
- Maintain at least some Stars/Nebulas first (they multiply galaxy production)
- In true vacuum, prioritize galaxies aggressively (they boost all stages via strangeness[5][10])

### 9.3 Intergalactic Loop
```
Stage 4 → Stage 5 → First Merge (true vacuum) → Merge cycles → Stage Reset → repeat
                                                    ↓
                                            Create Universes at thresholds
                                                    ↓
                                            Free strangeness + quarks
```
- Merges convert true galaxies → **temporary** groups/clusters → faster rebuilding → more galaxies
- Universes convert mergeScore → current quarks + free strangeness upgrades
- Stage resets convert galaxy count → strange quarks → strangeness upgrades → stronger next loop
- The loop scales multiplicatively: each iteration earns more quarks AND produces faster

### 9.4 Strangeness Priority (Corrected)
```
1st: idx3 (Gravitational bound, 24q) — prevents collapse wipe [ENABLER]
2nd: idx2 Lv1 (Strange gain, 4q) — 1.4× quarks, pays back in ~3 resets
3rd: idx2 Lv2 (Strange gain, 16q) — 1.96× total quarks
4th: idx0 Lv1 (Bigger Structures, 24q) — 1.6× production
5th: idx5 (Auto Structures, 24q) — QoL
6th: idx1 Lv1 (Higher density, 36q) — 1.8× upgrades
7th+: idx0 Lv2, idx1 Lv2, idx6 (when affordable)
8th+: Reach 8 universes → FREE strangeness[5][6]; Reach 21 → FREE strangeness[5][9]
```

### 9.5 Stage Reset Timing
- **Merge until mergeMaxResets exhausted** OR until you can create a Universe
- **Create Universe** whenever `mergeScore ≥ verseCost` — this gives free quarks + upgrades
- **Stage-reset** when merges exhausted AND can't afford next universe
- Track quarks/second; reset when rate peaks/declines
- In true vacuum with strangeness[5][6]≥1, auto-reset handles this
- **Target 8 universes** to get free strangeness[5][6] (Auto Stage Reset) — this is the key threshold

---

## Appendix A: Key Code References

| Function | File | Line | Purpose |
|----------|------|------|---------|
| `mergeResetCheck` | Stage.js | 3987 | Main merge logic gate |
| `mergeReset` | Stage.js | 4062 | Execute merge (or vacuum collapse) |
| `mergeReserUser` | Stage.js | 4029 | User-facing merge trigger |
| `mergeReward` | Stage.js | 1333 | Calculate group/cluster rewards |
| `calculateEffects.reward` | Stage.js | 595 | reward[0] and reward[1] boost formulas |
| `calculateEffects.mergeRequirement` | Stage.js | 581 | Minimum galaxies to merge |
| `calculateEffects.mergeMaxResets` | Stage.js | 582 | Maximum merges per stage |
| `calculateEffects.groupsCost` | Stage.js | 610 | Galaxies per group |
| `calculateEffects.mergeScore` | Stage.js | 611 | Universe purchase currency |
| `stageResetCheck(5)` | Stage.js | 3257-3289 | Stage 5 reset logic |
| `stageResetReward` | Stage.js | 3395 | Quark reward calculation |
| `assignBuildingsProduction.stage5Cache` | Stage.js | 1128 | Galaxy production formula |
| `calculateEffects.strangeGain` | Stage.js | 674 | Quark gain per reset |
| `assignResetInformation.quarksGain` | Stage.js | 1355 | Quark multiplier setup |
| `strangenessInfo[5]` | Player.js | 1229-1283 | Stage 5 strangeness definitions |

## Appendix B: Merge Boost Display Formula (from Update.js:350)

```
mergeBoost = (true_galaxies / (total_galaxies + 1) + 1) × 
             reward[0](post=true, clusterEffect=reward[1](post=true)) / 
             reward[0](post=false)
```

Where:
```
reward[0](post, clusterEffect) = ((groups + 1) × S5Extra2(level, groups)) ^ clusterEffect
reward[1](post) = 1 + (clusters + [pending]) / 10
```

This formula approximates the galaxy-multiplier component of production change but omits the base^true_g factor.
