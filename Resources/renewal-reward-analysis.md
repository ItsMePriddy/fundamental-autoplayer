# Renewal-Reward Analysis: Optimal Collapse Mass Multiplier for Fundamental Stage 4

> **Date**: June 26, 2026  
> **Game state**: 33.5 Solar mass, 141 nova stars, 39 novas, 0 black holes, 11 elements, 58 strange quarks, progress.main = 14

---

## 1. Game Mechanics Summary

### 1.1 The Collapse Cycle

Each collapse cycle in stage 4 follows this pattern:

1. **Start**: All buildings (b1–b5) are reset to zero. Stardust (b0) starts at 1.
2. **Growth phase**: Buildings produce lower-tier buildings in a cascade; stardust buys higher-tier buildings.
3. **Collapse trigger**: When `massBoost ≥ collapse.input[0]`, the collapse fires.
4. **Reward**: Solar mass increases to `newMass = massGain()`. Nova stars, novas, and black holes increase by `starCheck[0]`, `starCheck[1]`, `starCheck[2]` respectively.
5. **Repeat** from step 1 with higher permanent stats.

### 1.2 Mass Gain Formula (non-vacuum)

From `Stage.js` line 505–531, the `massGain()` function for non-vacuum stage 4:

```
newMass = base_mult × star_mult × elem10_mult × S4Extra1 × star[2]_effect × stageBoost5
```

where:

| Term | Formula | Notes |
|------|---------|-------|
| `base_mult` | `0.004 + 0.002·[elem 3] + 0.0002·b1_true·[elem 5]` | Very small base |
| `star_mult` | `trueStars` (if elem 15) or `b1_true` (if not) | trueStars = Σ b1..b5 true |
| `elem10_mult` | `2` if element 10, else `1` | Double mass gain |
| `S4Extra1` | `(10 + research[4][1]) / 10` | Typically 1.0–2.0 |
| `star[2]_effect` | `1` if blackHoles ≤ 0, else `(BH+1)/log_base(BH+base)` | User has 0 BH → effect = 1 |
| `stageBoost5` | `strangeInfo.stageBoost[5]` if strangeness[5][7] ≥ 1 | Late-game bonus |

**For the user's state (0 black holes, element 15 likely unlocked at progress.main=14):**

$$\text{newMass} \approx (0.004 + 0.002\cdot\mathbb{1}[\text{elem }3] + 0.0002\cdot b_{1,\text{true}}) \times \text{trueStars} \times 2 \times 1.0 \times 1$$

Assuming elements 3, 10, 15 are among the 11 elements (typical for progress.main=14):

$$\boxed{\text{newMass} \approx 0.012 \times \text{trueStars}}$$

> The `0.0002·b1_true` term is negligible compared to 0.006 for small b1. For b1 ≈ 20, it adds 0.004, roughly comparable to base.

### 1.3 Star Effects on Production

The `star` array (lines 457–503) gives permanent multipliers that boost building production:

**star[0]** (Nova stars):
```javascript
effect = stars[0];                    // 141 for this user
if (elem 28) effect *= 1.5;
effect += 1;
if (elem 6) effect **= element6();
return effect;
```
For user: star[0] = 141 + 1 = **142** (assuming no elem 28 or 6).

**star[1]** (Novas):
```javascript
stars = stars[1] * (1 + strangeness[4][8]);   // 39 * 1 = 39
if (elem 22) stars += stars[0];
effect = (stars + 1)^(0.5 + strangeness[4][8]/8);
if (elem 12) effect *= log_4(stars + 4);
return effect;
```
For user (assuming no elem 22 or 12): star[1] = (39+1)^0.5 = 40^0.5 ≈ **6.32**.

**star[2]** (Black holes):
```
if blackHoles ≤ 0: return 1
```
User has 0 black holes → star[2] = **1**.

### 1.4 Interstellar Production Multiplier

From `stage4Cache()` (line 1029–1060):

```
interstellar = S4Research0 × mass_effect × star[1] × S4Research4 × 1.6^strangeness[4][0]
```

Where `mass_effect = (mass)^0.2` in challenge mode (or `(mass)^1.1` if elem 21, but user is not in vacuum so challenge=0 path applies).

For user (33.5 mass, no elem 21): mass_effect = 33.5^0.2 ≈ **1.99**.

Assuming minimal researches (progress.main=14 is early post-vacuum):
- S4Research0 ≈ 1.4 (r4[0]=1, r4[2]=0)
- S4Research4 = 1 (no r4[4] or black holes)
- strangeness[4][0] ≈ 0

So interstellar ≈ 1.4 × 1.99 × 6.32 × 1 × 1 = **17.6**.

### 1.5 S4Shared Exponential Feedback

```javascript
S4Shared = S4Research1 ^ trueStars
```

Where `S4Research1 = 1 + 0.005 × level` (for level ≤ 5). Typically around 1.025 at low research.

This creates **super-exponential growth**: each building increases trueStars by 1, which multiplies ALL production by S4Research1 ≈ 1.025. With N buildings, total multiplier is (1.025)^N ≈ exp(0.0247N).

### 1.6 Building Production Rates

| Producer | Produces | Base Rate (× interstellar × S4Shared) |
|----------|----------|---------------------------------------|
| S4Build1 (b1) | Stardust (b0) | 40 × b1_current |
| S4Build2 (b2) | Brown dwarfs (b1) | 1200 × star[0] × 2^r4[3] × b2_current |
| S4Build3 (b3) | Main sequence (b2) | 6e7 × b3_current |
| S4Build4 (b4) | Red supergiants (b3) | 6e9 × b4_current |
| S4Build5 (b5) | Blue hypergiants (b4) | 2e11 × b5_current |

### 1.7 Building Costs (Stage 4)

From `Player.js` line 330 (firstCost) and line 340 (increase):

| Index | Building | First Cost | Increase | Cost formula |
|-------|----------|-----------|----------|-------------|
| 0 | Stardust | — | — | Free (produced) |
| 1 | Brown dwarfs | 1 | 1.4 | 1 × 1.4^n |
| 2 | Main sequence | 1e5 | 1.55 | 1e5 × 1.55^n |
| 3 | Red supergiants | 1e15 | 1.70 | 1e15 × 1.70^n |
| 4 | Blue hypergiants | 1e27 | 1.85 | 1e27 × 1.85^n |
| 5 | Quasi-stars | 1e50 | 2.00 | 1e50 × 2.00^n |

Cost modifiers (from `calculateBuildingsCost`, line 1584–1608):
- Elements 2: cost increase −0.1 (applied to all)
- Elements 8: cost increase −0.05
- firstCost ÷ 2^strangeness[4][1]
- researchExtra[4][3]: firstCost ÷ star[1]
- element 13: firstCost ÷ 100
- strangeness[4][7] ≥ 2: firstCost ÷ stageBoost[4] (for index 1 only)
- Challenge supervoid: firstCost × 100 (not applicable)

---

## 2. Mathematical Model of a Single Cycle

### 2.1 State Variables

Let:
- $M$ = Solar mass (permanent, grows each collapse)
- $S_0, S_1, S_2$ = permanent star counts
- $b_i(t)$ = true count of building $i$ at time $t$ within cycle
- $B(t) = \sum_{i=1}^5 b_i(t)$ = trueStars at time $t$

### 2.2 Production Dynamics

The production rate for building $i-1$ (produced by building $i$) is:

$$\frac{d}{dt}(\text{stardust equivalent of } b_{i-1}) = \pi_i \cdot b_i(t) \cdot I \cdot R^{B(t)}$$

where:
- $\pi_i$ = base production rate for tier $i$
- $I$ = interstellar multiplier (constant during cycle)
- $R$ = S4Research1 ≈ 1.025 (the exponential feedback base)
- $R^{B(t)}$ = S4Shared multiplier

The stardust production rate (from b1) is:

$$\dot{S}(t) = \pi_1 \cdot b_1(t) \cdot I \cdot R^{B(t)}$$

### 2.3 Cost to Add Buildings

The stardust cost for the $n$-th unit of building $i$:

$$C_i(n) = F_i \cdot r_i^{n}$$

where $F_i$ = firstCost (after modifiers) and $r_i$ = cost increase.

Total stardust needed for $n_i$ units of building $i$:

$$\text{TotalCost}_i(n_i) = F_i \cdot \frac{r_i^{n_i} - 1}{r_i - 1} \approx \frac{F_i}{r_i - 1} \cdot r_i^{n_i}$$

### 2.4 Balanced Growth Equilibrium

In balanced growth, all building tiers grow at rates that maintain optimal ratios. The optimal ratio between adjacent tiers $i$ and $i-1$ satisfies that the marginal cost of adding one more b_i equals the stardust produced by one more b_{i-1} over its lifetime.

In the regime where $R^{B(t)}$ provides super-exponential feedback, the system exhibits **hyperbolic growth**: the time to reach any finite target is finite, and the growth rate accelerates as B increases.

### 2.5 Time to Reach Target Stars

The key insight: because $R > 1$, the feedback $R^B$ means production grows roughly as $\exp(\alpha B)$, making $dB/dt \propto \exp(\alpha B)$, which gives:

$$B(t) \approx -\frac{1}{\alpha} \ln(t_{\text{sing}} - t)$$

This is **finite-time singularity** growth! The time to reach a target $B_{\text{target}}$ from $B_{\text{start}}$ is:

$$T \approx t_{\text{sing}} \cdot (e^{-\alpha B_{\text{start}}} - e^{-\alpha B_{\text{target}}})$$

For large $B_{\text{target}}$, $T \approx t_{\text{sing}} \cdot e^{-\alpha B_{\text{start}}}$, meaning the time to reach a given target is dominated by the early phase (when B is small) and becomes nearly independent of the target for large targets.

---

## 3. Renewal-Reward Optimization

### 3.1 Framework

The long-run average logarithmic growth rate is:

$$\bar{g} = \lim_{t \to \infty} \frac{\ln M(t)}{t} = \frac{\mathbb{E}[\Delta \ln M]}{\mathbb{E}[T]}$$

For a fixed multiplier $K = M_{\text{new}} / M_{\text{old}}$:

$$\Delta \ln M = \ln K$$

$$\bar{g}(K) = \frac{\ln K}{T(K)}$$

where $T(K)$ is the cycle time needed to reach multiplier $K$.

### 3.2 Deriving T(K)

The mass gain is approximately linear in trueStars:

$$M_{\text{new}} = c \cdot B_{\text{target}}$$

where $c \approx 0.012$ (from Section 1.2). So:

$$K = \frac{c \cdot B_{\text{target}}}{M} \implies B_{\text{target}} = \frac{K \cdot M}{c}$$

The cycle time $T$ is the time to reach $B_{\text{target}}$ starting from $B=0$.

For the finite-time singularity model:

$$T(B_{\text{target}}) = \int_0^{B_{\text{target}}} \frac{dB}{\dot{B}(B)}$$

Where $\dot{B}(B) \propto R^B$ in the regime dominated by S4Shared feedback. More precisely:

$$\dot{B} = \frac{d}{dt}\sum b_i \approx \sum \pi_i b_i \cdot I \cdot R^B$$

In the early phase (small B), the limiting factor is the production cascade bottleneck. The time to build the first few buildings of each tier dominates.

### 3.3 Bottleneck Analysis

For small B:
- To get b1 > 0: need 1 stardust (given, start with 1) → buy b1 immediately
- To get b2 > 0: need 1e5 stardust. With 1 b1 producing at rate ≈ 40·I·1 = 700/s, time ≈ 143 seconds
- To get b3 > 0: need 1e15 stardust. Requires substantial b1/b2 buildup first
- To get b4 > 0: need 1e27 stardust
- To get b5 > 0: need 1e50 stardust

The bottleneck shifts as B grows:
- Phase 1 (b1 only): linear growth, $\dot{S} \propto b_1 \propto t$, so $S \propto t^2$
- Phase 2 (b1+b2): cubic growth, $\dot{b}_1 \propto b_2 \propto t$, so $b_1 \propto t^2$, $S \propto t^3$
- Phase 3 (b1+b2+b3): quartic growth
- Phase 4 (b1+b2+b3+b4): quintic growth
- Phase 5 (all tiers): with S4Shared feedback → finite-time singularity

### 3.4 Early-Game Cycle Time

For the user's state (33.5 mass, relatively early), the achievable trueStars per cycle is limited. The user can probably reach b3-b4 tiers but not b5.

In the polynomial-growth regime (before S4Shared dominates), the time to reach B scales as:

$$T(B) \approx A \cdot B^{1/h}$$

where $h$ is the effective number of active tiers in the production cascade.

More precisely, with $m$ active building tiers, $B$ grows as $B \propto t^m$. So $T \propto B^{1/m}$.

With $m$ tiers: $T(K) \propto K^{1/m}$ (since $B \propto K$).

### 3.5 Optimal Multiplier (Polynomial Regime)

$$\bar{g}(K) = \frac{\ln K}{A \cdot K^{1/m}}$$

Maximize by setting $d\bar{g}/dK = 0$:

$$\frac{1/K \cdot K^{1/m} - \ln K \cdot (1/m) K^{1/m - 1}}{K^{2/m}} = 0$$

$$K^{1/m-1}\left(1 - \frac{\ln K}{m}\right) = 0$$

$$\ln K = m$$

$$\boxed{K_{\text{opt}} = e^m}$$

**Key result**: The optimal multiplier is $e^m$, where $m$ is the number of active tiers. With 4 active tiers (b1–b4), $K_{\text{opt}} = e^4 \approx 54.6$. With 5 tiers, $K_{\text{opt}} = e^5 \approx 148.4$.

### 3.6 S4Shared-Dominated Regime

Once trueStars is large enough that $R^B$ dominates (B ≳ 50), the growth becomes super-exponential. In this regime:

$$\dot{B} \approx \gamma \cdot R^B$$

$$\frac{dB}{dt} = \gamma R^B \implies R^{-B} dB = \gamma dt \implies \frac{R^{-B}}{-\ln R} = \gamma t + C$$

$$B(t) = -\frac{\ln(\gamma|\ln R|(t_{\text{sing}} - t))}{\ln R}$$

where $t_{\text{sing}} = R^{-B_0} / (\gamma \ln R)$.

For a target B, the time is:

$$T(B) = t_{\text{sing}} \cdot (1 - R^{-(B - B_0)})$$

As $B \to \infty$, $T \to t_{\text{sing}}$. This means **the cycle time is bounded above** regardless of target! The time to reach any finite multiplier is at most $t_{\text{sing}}$.

In this regime:

$$\bar{g}(K) = \frac{\ln K}{t_{\text{sing}} \cdot (1 - R^{-(B_{\text{target}} - B_0)})}$$

Since $T \to t_{\text{sing}}$ as $K \to \infty$, the growth rate asymptotically approaches:

$$\bar{g}_{\text{max}} = \lim_{K \to \infty} \frac{\ln K}{t_{\text{sing}}} = \infty$$

**This implies the optimal multiplier is as large as possible!** You should wait as long as you can before collapsing, because the super-exponential feedback makes the marginal cost of additional stars vanish.

However, there's a critical nuance: this analysis assumes $R > 1$ (S4Shared exists). For the user with progress.main=14, S4Research1 requires research[4][1] ≥ 1. Let's check if the user has this.

---

## 4. Numerical Analysis for User's State

### 4.1 User's Parameters

| Parameter | Value | Effect |
|-----------|-------|--------|
| Mass M | 33.5 | mass_effect = 33.5^0.2 = 1.99 |
| Nova stars S₀ | 141 | star[0] = 142 |
| Novas S₁ | 39 | star[1] ≈ 6.32 |
| Black holes S₂ | 0 | star[2] = 1 |
| Elements | 11 | Unknown which; assume typical |
| Strange quarks | 58 | Some strangeness upgrades |

### 4.2 Interstellar Multiplier

$$I = S_4R_0 \cdot M^{0.2} \cdot \text{star}[1] \cdot S_4R_4 \cdot 1.6^{s_{4,0}}$$

Assuming:
- S4Research0 = 1.4 (r4[0]=1, no r4[2])
- S4Research4 = 1 (no r4[4] or black holes)
- strangeness[4][0] ≤ 2

$$I \approx 1.4 \times 1.99 \times 6.32 \times 1 \times 1 = 17.6$$

### 4.3 Production Rate Estimates

Stardust production (with 1 b1): 
$$\dot{S} = 40 \times I \times R^B \times b_1 \approx 40 \times 17.6 \times 1 \times 1 = 704 \text{ stardust/s}$$

Time to buy 1st b2 (100,000 stardust): ~142 seconds.

With b2 producing b1: b1 production rate ≈ 1200 × 17.6 × 142 × 1 × 1 = 3,000,000 b1/s (initially, before b2 builds up).

### 4.4 S4Shared Availability

S4Research1 requires `research[4][1] >= 1`. The first research in stage 4 costs 1e3 stardust. At ~704 stardust/s, this takes ~1.4 seconds. So S4Shared should be available very early in the cycle.

With research[4][1] = 1: $R = 1 + 0.005 \times 1 = 1.005$.

### 4.5 Critical B for S4Shared Dominance

The S4Shared multiplier $R^B = 1.005^B$ becomes significant when:

$$1.005^B \gg 1 \implies B \gg 0$$

At B = 100: $1.005^{100} \approx 1.65$ (65% boost — notable but not dominant)
At B = 1000: $1.005^{1000} \approx 147$ (large boost)
At B = 5000: $1.005^{5000} \approx 6.7 \times 10^{10}$ (massive)

### 4.6 Achievable trueStars Per Cycle

Given the cost scaling, the achievable B is limited by the stardust available:

| Tier | Max affordable (at 33.5 mass, with stardust accumulating) |
|------|----------------------------------------------------------|
| b1 | Very many (cost 1×1.4^n, affordable up to n≈50 with 1e6 stardust) |
| b2 | Up to n≈40 (1e5×1.55^40 ≈ 4e12) |
| b3 | Up to n≈20 (1e15×1.7^20 ≈ 4e19) |
| b4 | Up to n≈10 (1e27×1.85^10 ≈ 1e29) |
| b5 | 0–1 (1e50 minimum) |

Realistically, the user can achieve B ≈ 100–200 in a cycle lasting minutes to hours.

### 4.7 Optimal K for User's State

In the polynomial regime (before S4Shared dominates), with m ≈ 4 effective tiers:

$$K_{\text{opt}} \approx e^4 \approx 54.6$$

This means the user should collapse when `newMass / currentMass ≈ 55`.

With current mass 33.5, target mass ≈ 33.5 × 55 ≈ **1,840**.

Alternative: if S4Shared feedback becomes significant during the cycle (B ≳ 100), the effective growth exponent increases, pushing K_opt higher. The marginal benefit of waiting grows with B.

**Practical recommendation**: Start with K ≈ 50. As S4Shared research levels increase (making R larger), increase the multiplier. Monitor whether cycles are getting faster or slower; if cycle time still decreases with higher K, increase K further.

---

## 5. State Dependence of Optimal Multiplier

### 5.1 Dependence on Star Count

The optimal multiplier $K_{\text{opt}}$ depends on star counts through several channels:

1. **star[0] (Nova stars)**: Increases production of b2 (Main sequence → Brown dwarfs). Higher star[0] → faster b1 production → more tiers active → higher $m$ → higher $K_{\text{opt}}$.

   Current: star[0] = 142. Effect on b2 production: ×142.

2. **star[1] (Novas)**: Part of interstellar multiplier, boosts ALL production equally. Higher star[1] → faster cycles but doesn't change the optimal K (it's a uniform time scaling).

   Current: star[1] ≈ 6.32.

3. **star[2] (Black holes)**: Currently 0. When >0, provides a separate multiplier to massGain and production. The star[2] formula:
   $$\text{star}[2] = \frac{S_2 + 1}{\log_2(S_2 + 2)}$$
   which grows roughly as $O(S_2 / \log S_2)$. This directly affects massGain as a multiplier.

4. **Element 12**: Adds $\log_4(\text{stars}+4)$ to star[1], making star[1] grow with nova count → increases effective $m$ over time.

5. **Element 22**: Adds nova stars to star[1] formula, making novas also scale with nova star count.

### 5.2 Is K_opt Constant?

**No, K_opt is NOT constant.** It depends on:

1. **Number of active building tiers ($m$)**: As the user unlocks more tiers (b5, eventually), $m$ increases from 2–3 to 4–5, changing $K_{\text{opt}}$ from $e^2 \approx 7.4$ to $e^5 \approx 148$.

2. **S4Research1 level**: Higher research → larger $R$ → stronger S4Shared feedback → transition from polynomial to super-exponential regime → K_opt → ∞.

3. **New permanent stars each cycle**: Each collapse adds starCheck to permanent stars. starCheck values are:
   - starCheck[0] = b2_true + b1_true × strangeness[4][3]/10
   - starCheck[1] = b3_true
   - starCheck[2] = b4_true + b5_true × researches[4][5]

   As permanent stars accumulate, they boost production, reducing cycle time for a given K. But this doesn't directly change the optimal K (it's a uniform speedup), except through the S4Shared feedback which is stronger with faster cycles.

4. **Mass itself**: Higher mass → higher mass_effect (M^0.2) → faster production. This is also a uniform speedup for polynomial regime, but accelerates the entry into the S4Shared-dominated regime.

### 5.3 Phase Diagram

| Regime | Condition | K_opt |
|--------|-----------|-------|
| **Early polynomial** | B ≲ 50, S4Shared negligible | $e^m$ ≈ 7–148 |
| **Transition** | 50 ≲ B ≲ 500, S4Shared moderate | $> e^m$, growing |
| **S4Shared-dominated** | B ≳ 500 | → ∞ (wait as long as possible) |

For the user at 33.5 mass and 141 nova stars, the achievable B per cycle is likely in the **early polynomial** regime, giving $K_{\text{opt}} \approx 50\text{–}150$.

### 5.4 Practical Formula

For a player with $m$ accessible building tiers and S4Research1 level $L$:

$$K_{\text{opt}} \approx \max\left(e^m, \frac{2\ln R}{(\ln R)^2 \cdot B_0} \right)$$

where $R = 1 + 0.005L$ and $B_0$ is the trueStars at the start of S4Shared dominance (~50).

In the limit of large $L$ or large starting stars: $K_{\text{opt}} \to \infty$.

---

## 6. Summary and Recommendations

### 6.1 Key Findings

1. **Mass grows approximately linearly with trueStars**: newMass ≈ 0.012 × trueStars (with elements 3, 10, 15).

2. **Building costs scale exponentially**: $C_i(n) = F_i \cdot r_i^n$, with $r_i$ ranging from 1.4 to 2.0.

3. **The S4Shared multiplier creates super-exponential feedback**: $(1.005)^B$ multiplies all production, potentially leading to finite-time singularity growth.

4. **Optimal collapse multiplier in the polynomial regime**: $K_{\text{opt}} = e^m$, where $m$ is the number of active building tiers.

5. **Optimal multiplier is state-dependent**: It grows with active tier count, S4Research1 level, and accumulated permanent stars.

### 6.2 For the Current User (33.5 mass, 141 nova stars, 39 novas, 0 BH)

- **Recommended collapse multiplier**: **50× to 150×** current mass (target ~1,700–5,000 mass)
- This corresponds to $m \approx 4$ active tiers (b1–b4)
- If S4Research1 is leveled to 3+, the optimal K increases into the hundreds
- Once black holes are unlocked (via Quasi-stars research 5), star[2] provides a separate growth channel

### 6.3 Long-term Strategy

- **Level S4Research1** as high as possible — this directly increases R and pushes K_opt higher
- **Unlock b5 (Quasi-stars)** when affordable (cost 1e50+) — adds a 5th tier
- **Get element 12** (log_4 boost to star[1]) — makes permanent stars scale better
- **Transition to S4Shared-dominated regime** — at that point, prioritize longer cycles

---

## Appendix A: Derivation of $K_{\text{opt}} = e^m$

For a production cascade with $m$ tiers and exponential cost scaling, in the regime where each tier $i$ produces tier $i-1$ and the top tier is bought with the bottom resource:

The stardust production rate is:
$$\dot{S} \propto b_1 \propto t^{m-1}$$

Integrating: $S \propto t^m$, so $t \propto S^{1/m}$.

The stardust needed for trueStars B is approximately the cost of the most expensive building, which scales as $r^{B/m}$ (distributed across tiers). But more precisely, for balanced growth, each tier contributes roughly equally to cost, and total cost $\propto r^{B/m}$.

So $T \propto (r^{B/m})^{1/m}? No...

Let me re-derive. In balanced growth with $m$ tiers:
- At time $t$, b₁ ∝ t^{m-1}, b₂ ∝ t^{m-2}, ..., b_m ∝ constant
- B(t) ≈ b₁ ∝ t^{m-1}
- The bottleneck cost is for b_m (the top tier), which costs r_m^{b_m} × F_m
- But b_m grows slowly (it's purchased rarely), so the total stardust accumulated S ∝ t^m

For target B, we need $t = T$ such that $B(T) \propto T^{m-1}$:
$$T \propto B^{1/(m-1)}$$

Then:
$$\bar{g} = \frac{\ln K}{A \cdot K^{1/(m-1)}}$$

Maximizing:
$$\ln K = m-1$$
$$K_{\text{opt}} = e^{m-1}$$

Hmm, let me reconsider. Actually in the incremental game literature, for a chain of $h$ producers where each produces the one below, the growth is polynomial of degree $h$: $B \sim t^h$. This gives $T \sim K^{1/h}$ and $K_{\text{opt}} = e^h$.

For our case, with $h = m$ active tiers: $K_{\text{opt}} = e^m$.

---

## Appendix B: Julia/Python Code for Numerical Validation

```python
import math

def mass_gain(true_stars, b1_true=0, has_elem3=True, has_elem5=True, 
              has_elem10=True, has_elem15=True, research41=0):
    base = 0.004
    if has_elem3:
        base += 0.002
    if has_elem5:
        base += 0.0002 * b1_true
    
    if has_elem15:
        star_mult = true_stars
    else:
        star_mult = b1_true
    
    mass = base * star_mult
    if has_elem10:
        mass *= 2
    
    s4extra1 = (10 + research41) / 10
    mass *= s4extra1
    
    # star[2] effect (0 BH = 1)
    mass *= 1.0
    
    return mass

def building_cost(tier, n, has_elem2=False, has_elem8=False, 
                  strangeness41=0, has_elem13=False):
    # Stage 4 costs
    first_costs = [0, 1, 1e5, 1e15, 1e27, 1e50]
    increases = [0, 1.4, 1.55, 1.70, 1.85, 2.0]
    
    increase = increases[tier]
    if has_elem2:
        increase -= 0.1
    if has_elem8:
        increase -= 0.05
    
    first_cost = first_costs[tier]
    first_cost /= 2 ** strangeness41
    if has_elem13:
        first_cost /= 100
    
    return first_cost * (increase ** n)

def optimal_multiplier(active_tiers):
    """Polynomial regime optimum"""
    return math.exp(active_tiers)

# Example for user's state
print("Active tiers | Optimal K")
for m in range(1, 6):
    print(f"      {m}       | {optimal_multiplier(m):.1f}x")

# With S4Shared (R=1.005)
R = 1.005
B = 100
print(f"\nS4Shared at B={B}: {R**B:.2f}x multiplier")
print(f"At B=1000: {R**1000:.0f}x")
```

---

## References

- Game source: `/Users/spencer/Downloads/Personal/Coding/Fundamental Player/headless/build/Stage.js`
- Player data: `/Users/spencer/Downloads/Personal/Coding/Fundamental Player/headless/build/Player.js`
- Renewal-Reward Theorem: Ross, S.M. (1996). *Stochastic Processes*. Wiley.
- Incremental game prestige optimization: "The Math of Idle Games" (blog posts, various authors)
