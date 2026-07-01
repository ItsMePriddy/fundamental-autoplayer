# Strangeness Purchase Optimization Analysis

> **Status: applied.** This doc's core recommendation (Section 8) — replace the
> then-configured, now-maxed `strangenessTargets: ['strange6Stage4','strange7Stage4']`
> with the stage-5 unlocks — already shipped as
> `strangenessTargets: ['strange3Stage5', 'strange4Stage5']` in `Fundamental.user.js`.
> `strange5Stage5` was deliberately left out (see that CONFIG field's comment: at 15,600
> quarks it would just timeout-hold). The "current targets" snapshot below is stale;
> the purchase-order and cost-table reference material (Sections 3-5) still holds.

**Date:** 2026-06-27  
**Current State:** 59.6 strange quarks | Stage 4 (Interstellar) | Stage 5 (Intergalactic) unlocked, zero purchases

---

## 1. Current Strangeness Levels

### Stage 4 — Interstellar (`player.strangeness[4]`)

| idx | Name | Level | Max | Next Cost | Effect |
|-----|------|-------|-----|----------:|--------|
| 0 | Hotter Stars | 4 | 8 | **9** | Stars produce 1.6× more Stardust |
| 1 | Cheaper Stars | 1 | 4 | **5.4** | Stars 2× cheaper |
| 2 | New Upgrade | 0 | 3 | **4** | Unlocks Planetary nebula / White dwarfs / Nucleosynthesis |
| 3 | Main giants | 1 | 2 | **6** | 10% Brown dwarfs → Red giants after Collapse |
| 4 | Automatic Collapse | 0 | 1 | **12** | Auto-collapse when enough boost/Solar mass |
| 5 | Auto Structures ⭐ | **1** | **1** | — MAXED | Permanent auto for all Interstellar Structures |
| 6 | Element automatization ⭐ | **1** | **1** | — MAXED | Elements no longer need Collapse |
| 7 | Strange boost | 0 | 1 | **24** | Strange quarks boost Interstellar Structures |
| 8 | Neutronium | 0 | 8 | 12,000 | +Neutron stars, +strength |
| 9 | Newer Upgrade | 0 | 3 | 240,000 | Unlocks Nucleosynthesis / Quark-nova / Inner Black hole |

⭐ = Currently listed in `strangenessTargets` — **both are already maxed and will never be purchasable again.**

### Stage 5 — Intergalactic (`player.strangeness[5]`)

| idx | Name | Level | Max | Next Cost | Effect |
|-----|------|-------|-----|-----------|--------|
| 0 | Bigger Structures | 0 | 8 | **24** | First two Intergalactic Structures 1.6× stronger |
| 1 | Higher density | 0 | 8 | **36** | First two Intergalactic Upgrades 1.8× stronger |
| 2 | **Strange gain** 🔑 | 0 | 2 | **4** (lvl1), **16** (lvl2) | **1.4× more Strange quarks from ALL Stage resets** |
| 3 | **Gravitational bound** 🔑 | 0 | 1 | **24** | Intergalactic immune to Collapse + enables auto-upgrade |
| 4 | Automatic Galaxy | 0 | 1 | 15,600 | Auto-buy Galaxies on Collapse |
| 5 | Auto Structures | 0 | 1 | **24** | Permanent auto for first two Intergalactic Structures |
| 6 | Automatic Stage | 0 | 1 | 480 | Auto-trigger Stage reset |
| 7 | Strange boost | 0 | 1 | **120** | Strange quarks boost Intergalactic (Solar mass gain) |
| 8 | Strange growth | 0 | 1 | 6,000 | Unlock another Strange Structure |
| 9 | Automatic Merge | 0 | 1 | 6,000,000 | Auto-merge Galaxies |
|10 | Galactic tide | 0 | 3 | 20,000,000 | Galaxy-based passive boosts + new Upgrades |

🔑 = Critical for loop acceleration. Bold costs = affordable within first ~100 quarks.

---

## 2. Cost Mechanics

The cost formula (from `Stage.js:calculateStrangenessCost`):

- **Additive scaling** (default, non-vacuum): `cost = firstCost + scaling × currentLevel`
- **Exponential scaling** (when `scalingType[index] = true` OR in true Vacuum): `cost = firstCost × scaling^currentLevel`

Stage 5 idx2 (`strange3Stage5`) uses **exponential** scaling (`scalingType[2] = true`):
- Level 1: `4 × 4^0 = 4`
- Level 2: `4 × 4^1 = 16`
- Total to max: **20 quarks**

All other affordable Stage 4/5 upgrades use additive scaling at their first purchase (level 0 → 1):
- Cost = `firstCost + scaling × 0 = firstCost`

---

## 3. Highest-ROI Analysis

### Tier 0: The Quark Multiplier (strange3Stage5)
**Effect:** 1.4× more Strange quarks from ANY Stage reset per level (max 2 levels = 1.96× total).  
**Why it's #1:** This compounds ALL future quark income. Every quark spent on this pays back exponentially over subsequent resets. At 20 total quarks, this is the cheapest compound multiplier in the game.  
**Verdict:** Buy both levels IMMEDIATELY (cost: 4 + 16 = 20). No other purchase should happen before this.

### Tier 1: Intergalactic Unlocks (strange4Stage5)
**Effect:** Makes Intergalactic Stage immune to Collapse reset + enables Upgrade automatization to work within Intergalactic.  
**Why it's #2:** Without this, Collapse resets wipe Intergalactic progress, making the loop fundamentally broken. This is a gating unlock, not just a boost.  
**Verdict:** Buy immediately after strange3Stage5 (cost: 24).

### Tier 2: Automation (Stage 4 idx4)
**Effect:** Automatically Collapse when enough boost or Solar mass reached.  
**Why it's #3:** Collapse is the bridge between Interstellar (stage 4) and Intergalactic (stage 5). Automating it removes the biggest manual bottleneck in the intergalactic loop.  
**Verdict:** Buy next (cost: 12).

### Tier 3: Production & Content Unlocks
**Stage 4 idx2 (New Upgrade, cost 4):** Unlocks new Researches and Upgrades (Planetary nebula, White dwarfs, Nucleosynthesis). These are gating unlocks that open new power vectors.  
**Stage 4 idx0 (Hotter Stars lvl 5, cost 9):** 1.6× more Stardust from Stars — direct stage 4 production boost that feeds Collapse → Solar mass → Galaxies.  
**Stage 4 idx1 (Cheaper Stars lvl 2, cost 5.4):** Stars 2× cheaper — accelerates stage 4 build speed.  
**Stage 4 idx3 (Main giants lvl 2, cost 6):** 20% Brown dwarfs → Red giants. More star conversion = more Collapse output.

### Tier 4: Direct Intergalactic Boosts
**Stage 5 idx0 (Bigger Structures, cost 24):** First two Intergalactic Structures 1.6× stronger. Direct boost to stage 5 production.  
**Stage 5 idx5 (Auto Structures, cost 24):** Permanent auto for Intergalactic Structures. Reduces manual intervention.  
**Stage 5 idx1 (Higher density, cost 36):** First two Intergalactic Upgrades 1.8× stronger.

### Tier 5: Too Expensive for Now
**Stage 5 idx7 (Strange boost, cost 120):** Quark-based Intergalactic boost. Good long-term, but costs more than the entire Tier 3 combined.  
**Stage 5 idx6 (Automatic Stage, cost 480):** Auto stage reset. Great for full automation but too expensive for first ~100 quarks.  
**Stage 5 idx4 (Automatic Galaxy, cost 15,600):** Critical long-term but way out of budget.

---

## 4. Optimal Purchase Order (First ~100 Quarks)

Starting with 59.6 quarks:

| Step | Purchase | Cost | Running Total | Quarks Left | Rationale |
|------|----------|------|---------------|-------------|-----------|
| 1 | **strange3Stage5 lvl 1** | 4 | 4 | 55.6 | Quark multiplier — compounds ALL future income |
| 2 | **strange3Stage5 lvl 2** | 16 | 20 | 39.6 | Max the multiplier (1.4² = 1.96× total) |
| 3 | **strange4Stage5** | 24 | 44 | 15.6 | Intergalactic collapse immunity + auto-upgrade enable |
| 4 | **s4 idx4 (Auto Collapse)** | 12 | 56 | 3.6 | Automate the stage 4→5 bridge |
| — | *(wait for quarks to accumulate)* | — | 56 | ~44 remaining of 100 budget | — |
| 5 | **s4 idx2 (New Upgrade)** | 4 | 60 | 40 | Unlock Planetary nebula / White dwarfs |
| 6 | **s4 idx0 (Hotter Stars lvl 5)** | 9 | 69 | 31 | More Stardust → more Collapse mass |
| 7 | **s4 idx1 (Cheaper Stars lvl 2)** | 5.4 | 74.4 | 25.6 | Cheaper Stars → faster stage 4 builds |
| 8 | **s4 idx3 (Main giants lvl 2)** | 6 | 80.4 | 19.6 | 20% Brown dwarfs → Red giants |
| 9a | **s5 idx5 (Auto Structures)** | 24 | 104.4 | -4.4 | Slightly over budget — save 5 more quarks |
| 9b | *or* **s5 idx0 (Bigger Structures)** | 24 | 104.4 | -4.4 | Direct Intergalactic production boost |
| 10 | **s4 idx7 (Strange boost)** | 24 | 128.4 | — | Quark-based Interstellar boost (next after s5 idx0/idx5) |
| 11 | **s5 idx7 (Strange boost)** | 120 | 248.4 | — | Quark-based Intergalactic boost |

**Summary:** Steps 1-8 fit within ~80 quarks and capture all the high-ROI cheap upgrades. Steps 9+ extend slightly past 100 quarks for the first Intergalactic direct boosts.

---

## 5. Current `strangenessTargets` Are Obsolete

### Current targets: `['strange6Stage4', 'strange7Stage4']`

| Target | Stage 4 idx | Name | Current Level | Max Level | Status |
|--------|------------|------|---------------|-----------|--------|
| strange6Stage4 | 5 | Auto Structures | **1** | **1** | ❌ MAXED — can never be bought again |
| strange7Stage4 | 6 | Element automatization | **1** | **1** | ❌ MAXED — can never be bought again |

### Impact of keeping these targets:
The `buyStrangenessSmart()` function holds ALL other strangeness purchases while saving quarks for an unowned target. Since both targets are maxed, they will ALWAYS appear as "unowned" (the `strangeUnowned()` check looks for `current/max` ratio < 1 in the DOM text, but maxed upgrades show no ratio, which may cause them to be skipped OR hung on indefinitely).

**Either way, these targets serve no purpose and must be replaced.**

### Recommended new targets:
```javascript
strangenessTargets: ['strange3Stage5', 'strange4Stage5', 'strange5Stage5']
```

This matches the v1.12 HANDOFF.md documented strategy:
- `strange3Stage5` — quark multiplier (highest priority, always)
- `strange4Stage5` — Intergalactic collapse immunity + auto-upgrade enable
- `strange5Stage5` — Intergalactic building automation (expensive at 15,600, but the target-hold mechanism will save for it once the first two are owned)

After `strange3Stage5` and `strange4Stage5` are both bought (total 44 quarks), the bot should:
1. Still try `strange3Stage5` first (it'll skip since maxed)
2. Try `strange5Stage5` — but at 15,600 quarks, the `strangenessTargetTimeoutMs` (10 min) will expire since it's expensive but NOT locked, and the bot will release the hold
3. Fall through to `strange4Stage5` (skip, maxed), then buy current-stage-first

This gives the right behavior: save for the big targets but don't starve progress if they're too expensive.

---

## 6. Detailed ROI Justification

### Why strange3Stage5 is mathematically dominant
Every strange quark earned comes from Stage resets. The quark multiplier applies to ALL resets across ALL stages. At 1.96× (both levels), you effectively earn quarks 96% faster forever. The payback period on a 20-quark investment is approximately:

- Without multiplier: each reset yields Q base quarks
- With 1.96×: each reset yields 1.96Q quarks
- Payback: need to earn 20 / 0.96 ≈ 20.8 base resets worth of quarks to break even

In the Intergalactic loop where resets happen frequently, this pays back extremely fast.

### Why stage 4 automation comes before stage 5 production
The intergalactic loop depends on Collapse (stage 4) to generate Solar mass, which buys Galaxies (stage 5). Without Auto Collapse (s4 idx4), the loop stalls whenever the bot isn't actively collapsing. With it automated, the loop runs continuously.

Stage 5 production boosts (s5 idx0, s5 idx1) multiply an engine that isn't running yet. First get the engine running (auto-collapse), then turbocharge it.

### Why s4 idx2 (New Upgrade) is high priority at only 4 quarks
This unlocks three new research/upgrade lines:
- **Planetary nebula** (Stage Research, 1e11 Stardust)
- **White dwarfs** (Collapse Research, 1e50 Stardust)
- **Nucleosynthesis** (Upgrade, 1e52 Stardust)

These are content gates — you literally cannot access these power vectors without this strangeness. At 4 quarks, it's the cheapest content unlock available.

---

## 7. Source Data References

All cost/effect data extracted from the compiled game build:

- **Strangeness definitions:** `Player.js` lines 1075-1305 (`global.strangenessInfo[1]` through `[6]`)
- **Stage 4 (Interstellar) data:** `Player.js` lines 1189-1228
- **Stage 5 (Intergalactic) data:** `Player.js` lines 1229-1283
- **Cost calculation:** `Stage.js` lines 2584-2606 (`calculateStrangenessCost`)
- **Purchase logic:** `Stage.js` lines 2112-2372 (`buyStrangeness`)
- **Auto-buy logic:** `Stage.js` lines 3058-3104 (`autoStrangenessAdd/Remove`)
- **Smart buy logic:** `Fundamental.user.js` lines 359-374 (`buyStrangenessSmart`)
- **Current HANDOFF strategy:** `HANDOFF.md` lines 91-101

---

## 8. Action Items

1. ✅ **Immediately:** Change `strangenessTargets` from `['strange6Stage4','strange7Stage4']` to `['strange3Stage5','strange4Stage5','strange5Stage5']` in `Fundamental.user.js`
2. **If manually playing:** Buy strange3Stage5 level 1 → level 2 → strange4Stage5 immediately (20 + 24 = 44 quarks from 59.6 available)
3. **Then:** Buy s4 idx4 Auto Collapse (12 quarks) → s4 idx2 New Upgrade (4 quarks) → s4 idx0 level 5 (9 quarks)
4. **After that:** Let the bot's normal priority (current stage first) handle the remaining cheap upgrades
5. **Long-term:** Save for strange5Stage5 (15,600 quarks) for full building automation
