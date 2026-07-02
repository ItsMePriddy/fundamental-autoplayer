// Canonical headless validation harness — replays a real save through the
// compiled game logic under candidate stage-timing strategies and reports
// throughput (loops/quarks/stars/collapses/merges per simulated game-hour).
//
// This is the tool to run before shipping any CONFIG change in
// Fundamental.user.js: add or edit a strategy below, run it, and compare
// against "shipped" (today's CONFIG defaults) — only ship a change that wins.
//
// Runs are capped by SIMULATED game-time (--simHours), not wall-clock, so two
// strategies are compared over the same amount of in-game time regardless of
// how expensive either is to compute. --seconds is only a wall-clock safety
// backstop in case a strategy is pathologically slow per tick; check a run's
// "stopped by" field before trusting a comparison where it fired.
//
// Usage:
//   node sweep.js                  # run every strategy, print a comparison table
//   node sweep.js <name>           # run just one strategy (see STRATEGIES below)
//   node sweep.js --save=<path>    # use a specific save instead of the newest
//                                  # one in Resources/saves/
//   node sweep.js --simHours=48    # simulated game-time per strategy (default 48h)
//   node sweep.js --seconds=180    # wall-clock safety backstop (default 180s)

const fs = require("fs");
const path = require("path");
const E = require("./engine.js");
const { player, global, Stage, U } = E;
const SP = require("./build/Special");

const STEP = 250;
const LOOP_HISTORY_CAP = 20; // per-loop detail retained for display; running sums stay exact beyond this
const SAVES_DIR = path.join(__dirname, "..", "Resources", "saves");

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};
const SIM_CAP_MS = Number(flag("simHours", "48")) * 3600 * 1000;
const WALL_CAP = Number(flag("seconds", "180")) * 1000;
const strategyArg = args.find((a) => !a.startsWith("--"));

function resolveSavePath() {
    const override = flag("save", null);
    if (override) return override;
    const files = fs.readdirSync(SAVES_DIR)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => ({ f, t: fs.statSync(path.join(SAVES_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    if (!files.length) throw new Error(`No save files in ${SAVES_DIR} — export one from the game or pass --save=<path>`);
    return path.join(SAVES_DIR, files[0].f);
}

// ── built-in strategies (field names match Fundamental.user.js CONFIG) ────
// Star-trigger knobs (the userscript's priority-1 "stars ready" collapse):
//   starMinBatch    — only fire the star trigger once the PENDING remnant sum
//                     reaches this count (default 1 = shipped immediate-fire)
//   starMinGapMs    — min gap for the star trigger (default 2000 = shipped)
//   starTriggerOff  — disable the star trigger entirely (mass/element/fallbacks only)
const STRATEGIES = {
    auto: { label: "Game's own automation only (no scripted timing)", useAutos: true },
    shipped: { label: "Shipped defaults — Fundamental.user.js CONFIG (star batch >=50 @ 30s since v1.14)",
        vapBoost: 2.25, collapseMult: 1.3, starMinBatch: 50, starMinGapMs: 30000,
        mergeBoost: 2.0, mergeMinBoost: 1.2, mergeMaxWaitMs: 120000 },
    "star-immediate": { label: "Pre-v1.14 behavior — star trigger fires on ANY pending remnant (2s gap)",
        vapBoost: 2.25, collapseMult: 1.3, starMinBatch: 1, starMinGapMs: 2000,
        mergeBoost: 2.0, mergeMinBoost: 1.2, mergeMaxWaitMs: 120000 },
    "star-off": { label: "No star trigger — mass ROI 1.3x + element/fallbacks only",
        vapBoost: 2.25, collapseMult: 1.3, starTriggerOff: true,
        mergeBoost: 2.0, mergeMinBoost: 1.2, mergeMaxWaitMs: 120000 },
    "collapse-1.1x": { label: "Aggressive collapse (1.1x) + low vaporize boost",
        vapBoost: 2.0, collapseMult: 1.1, starMinBatch: 50, starMinGapMs: 30000,
        mergeBoost: 1.5, mergeMinBoost: 1.1, mergeMaxWaitMs: 60000 },
    "collapse-1.5x": { label: "Relaxed collapse (1.5x)",
        vapBoost: 2.25, collapseMult: 1.5, starMinBatch: 50, starMinGapMs: 30000,
        mergeBoost: 2.0, mergeMinBoost: 1.2, mergeMaxWaitMs: 120000 },
    "collapse-2.0x": { label: "Conservative collapse (2.0x) + higher merge bar",
        vapBoost: 2.25, collapseMult: 2.0, starMinBatch: 50, starMinGapMs: 30000,
        mergeBoost: 3.0, mergeMinBoost: 1.5, mergeMaxWaitMs: 180000 },
};

// ── helpers ────────────────────────────────────────────────────────────────
function loadSave(savePath) {
    const b64 = fs.readFileSync(savePath, "utf8").trim();
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    // The headless build's Main.playerStart ships with empty toggle arrays;
    // size them from the save before updatePlayer() merges defaults in, or
    // missing slots silently read as "off" instead of matching the save.
    const origAuto = E.Main.playerStart.toggles.auto;
    const origNormal = E.Main.playerStart.toggles.normal;
    E.Main.playerStart.toggles.auto = Array(json.toggles?.auto?.length || 12).fill(false);
    E.Main.playerStart.toggles.normal = Array(json.toggles?.normal?.length || 8).fill(false);
    E.P.updatePlayer(json, true);
    E.Main.playerStart.toggles.auto = origAuto;
    E.Main.playerStart.toggles.normal = origNormal;
    global.offline.active = false;
    player.toggles.confirm = player.toggles.confirm.map(() => "None");
    U.stageUpdate(true, true);
}

function enableAllAutos() {
    const t = player.toggles;
    t.auto = Array(12).fill(true);
    t.normal = Array(8).fill(true);
    for (let s = 1; s <= 6; s++) t.buildings[s] = Array(6).fill(true);
    t.verses = Array(2).fill(true);
    t.confirm = t.confirm.map(() => "None");
}

function disableAutos() {
    const t = player.toggles;
    t.auto = Array(12).fill(false);
    t.normal = Array(8).fill(false);
    for (let s = 1; s <= 6; s++) t.buildings[s] = Array(6).fill(true); // buildings still auto-buy
    t.verses = Array(2).fill(false);
    t.confirm = t.confirm.map(() => "None");
}

const fmtNum = (n) => (n == null || isNaN(n)) ? "N/A" : (n < 1e4 ? n.toFixed(2) : n.toExponential(2));
const fmtTime = (ms) => ms >= 3600000 ? (ms / 3600000).toFixed(2) + "h" : ms >= 60000 ? (ms / 60000).toFixed(1) + "m" : (ms / 1000).toFixed(1) + "s";
const totalStars = () => player.collapse.stars[0] + player.collapse.stars[1] + player.collapse.stars[2];

// ── single strategy run ──────────────────────────────────────────────────
async function runSim(name, cfg, savePath) {
    loadSave(savePath);
    if (cfg.useAutos) enableAllAutos(); else disableAutos();
    if (cfg.vapBoost !== undefined) player.vaporization.input[0] = cfg.vapBoost;
    player.vaporization.input[1] = 1e6;

    const wall0 = Date.now();
    let sim = 0, lastCollapse = -2000, lastMerge = -2000, lastAdvance = -2000;
    let loops = 0, merges = 0, collapses = 0;
    const firstReached = {};       // first time EVER each stage is seen this run (for timeTo5 only)
    let lastStage = player.stage.current;
    let loopStartSim = null;       // null until stage 1 has been seen at least once
    let loopReached = {};          // stage-entry times WITHIN the current loop only
    let lastLoopSd = {};           // stage durations from the most recently COMPLETED loop
    let loopData = [];             // last LOOP_HISTORY_CAP loops only (display) — see sums below
    let loopDurationSum = 0, loopQuarksSum = 0; // running totals over ALL loops, uncapped
    let quarksTotal = player.strange[0].total;
    let starGainAccum = 0, starSimTimeIn4 = 0;             // resets each loop (feeds loopData.stars)
    let starGainAccumTotal = 0, starSimTimeIn4Total = 0;   // NEVER resets (feeds the reported rate)
    let prevStarRef = totalStars();
    let timeTo5 = null;
    let stoppedBy = "simHours";
    const warnings = [];
    let prevQuarksTotal = player.strange[0].total;
    let prevUniverses = player.verses?.[0]?.total || 0;

    firstReached[lastStage] = 0;

    while (true) {
        if (sim >= SIM_CAP_MS) { stoppedBy = "simHours"; break; }
        if (Date.now() - wall0 >= WALL_CAP) { stoppedBy = "wallClock"; break; }
        global.offline.active = false;
        SP.checkProgress();
        const cur = player.stage.current;
        if (cur < 1 || cur > 6) throw new Error(`invariant violated: stage.current=${cur} out of range [1,6] at sim=${fmtTime(sim)}`);

        // Quark total can legitimately drop when a Universe is created (it gets
        // rebased to `current` — see build/Reset.js) - only flag a drop that
        // ISN'T coincident with a Universe being created, since that would be
        // an unexplained loss rather than expected bookkeeping.
        const curUniverses = player.verses?.[0]?.total || 0;
        if (player.strange[0].total < prevQuarksTotal - 1e-9 && curUniverses <= prevUniverses && warnings.length < 10) {
            warnings.push(`quarks total dropped (${prevQuarksTotal.toFixed(3)} -> ${player.strange[0].total.toFixed(3)}) at sim=${fmtTime(sim)} with no Universe created`);
        }
        prevQuarksTotal = player.strange[0].total;
        prevUniverses = curUniverses;

        if (firstReached[cur] === undefined) {
            firstReached[cur] = sim;
            if (cur === 5 && timeTo5 === null) timeTo5 = sim;
        }
        // Loop boundary = a genuine transition INTO stage 1 (edge-triggered, not a
        // "have we ever seen this stage" cache — a save can start mid-game past
        // stage 1, and a naive "seen before" check only fires once for the whole run).
        if (cur === 1 && lastStage !== 1) {
            if (loopStartSim !== null) {
                // The stretch we just finished was a full 1->..->1 cycle - record it.
                // (The very first entry into stage 1 from a mid-game save is a partial
                // tail-end, not a fair loop, so it's intentionally not recorded here.)
                const sd = {};
                for (const s of [1, 2, 3, 4, 5]) {
                    if (loopReached[s] !== undefined && loopReached[s + 1] !== undefined) sd[s] = loopReached[s + 1] - loopReached[s];
                }
                lastLoopSd = sd;
                loops++;
                const dur = sim - loopStartSim;
                const qThisLoop = player.strange[0].total - quarksTotal;
                quarksTotal = player.strange[0].total;
                loopDurationSum += dur;
                loopQuarksSum += qThisLoop;
                // Cap retained per-loop detail — a long sim-hours run can complete
                // thousands of loops, and keeping all of them was a real contributor
                // to the OOM crash seen when Phase 0 first ran at 48 sim-hours x 5
                // strategies in one process. Running sums above stay exact regardless.
                loopData.push({ loop: loops, duration: dur, quarks: qThisLoop, stars: starGainAccum });
                if (loopData.length > LOOP_HISTORY_CAP) loopData.shift();
                starGainAccum = 0; starSimTimeIn4 = 0;
            }
            loopStartSim = sim;
            loopReached = {};
        }
        if (loopReached[cur] === undefined) loopReached[cur] = sim;
        lastStage = cur;
        // Stars/sec denominator = time SPENT in stage 4, accrued every stage-4
        // tick. A prior version accrued only on ticks where stars increased,
        // inflating the reported rate to nonsense (hundreds of stars/sec).
        if (cur === 4) { starSimTimeIn4 += STEP; starSimTimeIn4Total += STEP; }

        for (const s of global.stageInfo.activeAll) {
            Stage.setActiveStage(s);
            E.buyBuildings(s);
            E.buyUpgrades(s);
            E.buyStrange(s);

            if (s === 1) {
                await Stage.dischargeResetUser();
            } else if (s === 2) {
                if (E.vaporBoost() >= (cfg.vapBoost ?? 2.25)) await Stage.vaporizationResetUser();
            } else if (s === 3) {
                await Stage.rankResetUser();
            } else if (s === 4) {
                for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, "elements", false);
                if (!cfg.useAutos && cfg.collapseMult !== undefined) {
                    // Mirrors collapseStep()'s priority cascade in Fundamental.user.js,
                    // MINUS the "#collapseBoostTotal >= collapseBoost" secondary trigger:
                    // that stat is computed via the game's custom Limit (bignum) class
                    // with chained operations, and transcribing it risked a subtle error
                    // I couldn't fully verify — left out rather than guessed. It's
                    // documented as a catch-all for cases the star trigger misses, so
                    // omitting it is a known, disclosed gap, not a silent one. Without
                    // the OTHER fallbacks below, a wide sweep over collapseMult locks up
                    // completely above ~2.5x (confirmed: identical flat 6.87 qks/simH,
                    // 0 loops, for every value 3x-150x) since nothing ever rescues a
                    // target ratio the sim will never reach.
                    Stage.assignResetInformation.newMass();
                    Stage.assignResetInformation.newStars();
                    const nm = global.collapseInfo.newMass;
                    const cm = player.collapse.mass;
                    const sc = global.collapseInfo.starCheck || [0, 0, 0];
                    const pendingStars = sc[0] + sc[1] + sc[2];
                    const starBatch = cfg.starMinBatch ?? 1;
                    const starGapMs = cfg.starMinGapMs ?? 2000;
                    const starReady = !cfg.starTriggerOff && pendingStars >= starBatch;
                    const elementPending = player.elements.some((v) => v === 0.5);
                    const sinceCollapse = sim - lastCollapse;
                    const massRatio = cm > 0 ? nm / cm : 0;
                    const antihangMass = cfg.collapseAntihangMassMin ?? 1.3;
                    const antihangMs = cfg.collapseMaxWaitMs ?? 120000;
                    const hardStallMs = cfg.collapseHardStallMs ?? 300000;

                    let fire = false;
                    if (starReady && sinceCollapse >= starGapMs) fire = true;                              // 1. stars ready (batch/gap-gated)
                    else if (elementPending && sinceCollapse >= 3000) fire = true;                          // 2. element pending
                    else if (sinceCollapse >= 2000 && cm > 0 && massRatio >= cfg.collapseMult) fire = true;  // 3. primary mass ROI
                    else if (sinceCollapse >= hardStallMs) fire = true;                                     // 5. hard stall (unconditional)
                    else if (sinceCollapse >= antihangMs && massRatio >= antihangMass) fire = true;          // 6. anti-hang

                    if (fire) {
                        await Stage.collapseResetUser();
                        collapses++;
                        lastCollapse = sim;
                    }
                }
                // Single source of truth for star gains, whichever of the branches
                // above caused them (scripted collapse or the game's own auto-
                // collapse) — a prior version ALSO added the scripted collapse's
                // gain explicitly here, double-counting it against this same check.
                const curStars = totalStars();
                if (curStars > prevStarRef) {
                    starGainAccum += curStars - prevStarRef;
                    starGainAccumTotal += curStars - prevStarRef;
                }
                prevStarRef = curStars;
            } else if (s === 5 && !cfg.useAutos) {
                if (!player.inflation.vacuum) {
                    // Pre-vacuum: the first merge is a one-time, boost-independent
                    // transition once >=22 galaxies are held (game-enforced
                    // internally) — #mergeBoostTotal doesn't exist yet.
                    if (sim - lastMerge >= 2000) { lastMerge = sim; await Stage.mergeResetUser(); }
                } else if (cfg.mergeBoost !== undefined) {
                    const boost = E.mergeBoost();
                    if (boost != null) {
                        const elapsed = sim - lastMerge;
                        if (boost >= cfg.mergeBoost || (elapsed >= cfg.mergeMaxWaitMs && boost >= cfg.mergeMinBoost)) {
                            await Stage.mergeResetUser();
                            merges++;
                            lastMerge = sim;
                        }
                    }
                }
            }
        }

        if (sim - lastAdvance >= 2000) {
            Stage.setActiveStage(cur);
            await Stage.stageResetUser();
            lastAdvance = sim;
        }

        U.stageUpdate();
        Stage.timeUpdate(STEP, STEP);
        sim += STEP;
    }

    // Self-consistency checks — a future edit to the loop-tracking logic above
    // should fail loudly here instead of silently shipping a wrong "optimum"
    // (exactly how the old loop-counting bug went unnoticed for so long).
    // loopData is capped (see LOOP_HISTORY_CAP), so check it against the cap and
    // against the uncapped running counters instead of expecting loops===length.
    if (loopData.length > LOOP_HISTORY_CAP) {
        throw new Error(`invariant violated: loopData.length=${loopData.length} exceeds LOOP_HISTORY_CAP=${LOOP_HISTORY_CAP}`);
    }
    if (loops < loopData.length) {
        throw new Error(`invariant violated: loops=${loops} is fewer than retained loopData.length=${loopData.length}`);
    }
    if (loopDurationSum > sim + STEP) {
        throw new Error(`invariant violated: sum of loop durations (${loopDurationSum}) exceeds total sim time (${sim})`);
    }

    const avgQ = loops ? loopQuarksSum / loops : 0;
    const avgLoopD = loops ? loopDurationSum / loops : 0;
    // Whole-run average, NOT the reset-each-loop starGainAccum — that only holds
    // whatever partial stretch happened since the last completed loop boundary,
    // which is 0 whenever a run happens to stop outside stage 4.
    const starsPerSec = starSimTimeIn4Total > 0 ? starGainAccumTotal / (starSimTimeIn4Total / 1000) : 0;

    return {
        name, label: cfg.label, wallMs: Date.now() - wall0, simMs: sim, stoppedBy, warnings,
        loops, merges, collapses, timeTo5, avgLoopD, avgQ, starsPerSec,
        quarksTotal: player.strange[0].total,
        quarksPerSimHour: sim > 0 ? player.strange[0].total / (sim / 3600000) : 0,
        finalStars: [...player.collapse.stars],
        finalMass: player.collapse.mass,
        finalStage: player.stage.current,
        finalGalaxies: player.buildings?.[5]?.[3]?.true || 0,
        sd: lastLoopSd, loopData, loopDataTruncated: loops > loopData.length,
    };
}

// ── reporting ────────────────────────────────────────────────────────────
function printDetail(r) {
    console.log(`\n─── ${r.name}: ${r.label} ───`);
    console.log(`  Wall ${fmtTime(r.wallMs)} | Sim ${fmtTime(r.simMs)} (stopped by: ${r.stoppedBy}) | Loops ${r.loops} | Merges ${r.merges} | Collapses ${r.collapses}`);
    console.log(`  Time to Stage 5: ${r.timeTo5 !== null ? fmtTime(r.timeTo5) : "not reached"}`);
    console.log(`  Quarks/sim-hour: ${fmtNum(r.quarksPerSimHour)} | Avg loop: ${fmtTime(r.avgLoopD)} | Quarks/loop: ${fmtNum(r.avgQ)} | Stars/sec (stage 4): ${r.starsPerSec.toFixed(3)}`);
    console.log(`  Final: stage ${r.finalStage} | stars=[${r.finalStars}] | mass=${fmtNum(r.finalMass)} | quarks=${fmtNum(r.quarksTotal)} | galaxies=${r.finalGalaxies}`);
    if (r.stoppedBy === "wallClock") {
        console.log(`  ⚠ hit the wall-clock backstop before reaching the --simHours target — this run has LESS sim-time than the others and isn't a fair comparison.`);
    }
    if (r.warnings.length) {
        console.log(`  ⚠ ${r.warnings.length} anomaly warning(s):`);
        for (const w of r.warnings) console.log(`    - ${w}`);
    }
    if (r.loopData.length) {
        console.log(r.loopDataTruncated ? `  Last ${r.loopData.length} of ${r.loops} loops:` : "  Loops:");
        for (const ld of r.loopData) console.log(`    L${ld.loop}: ${fmtTime(ld.duration)} | +${fmtNum(ld.quarks)} quarks | +${ld.stars.toFixed(0)} stars`);
    }
    if (Object.keys(r.sd).length) {
        console.log("  Last completed loop — stage durations:");
        for (const s of [1, 2, 3, 4, 5]) if (r.sd[s]) console.log(`    S${s}: ${fmtTime(r.sd[s])}`);
    }
}

function printComparison(results, savePath) {
    console.log("\n" + "=".repeat(100));
    console.log(`COMPARISON — save: ${path.basename(savePath)} | target ${SIM_CAP_MS / 3600000}h sim-time per strategy (wall backstop ${WALL_CAP / 1000}s)`);
    console.log("=".repeat(100));
    const header = `${"Strategy".padEnd(16)} ${"Stopped".padEnd(9)} ${"Loops".padStart(6)} ${"Merges".padStart(7)} ${"Stars/s".padStart(9)} ${"Qks/simH".padStart(10)} ${"Loop dur".padStart(9)} ${"To S5".padStart(8)}`;
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of results) {
        console.log(`${r.name.padEnd(16)} ${r.stoppedBy.padEnd(9)} ${String(r.loops).padStart(6)} ${String(r.merges).padStart(7)} ${r.starsPerSec.toFixed(3).padStart(9)} ${fmtNum(r.quarksPerSimHour).padStart(10)} ${fmtTime(r.avgLoopD).padStart(9)} ${(r.timeTo5 !== null ? fmtTime(r.timeTo5) : "N/A").padStart(8)}`);
    }
    if (results.some((r) => r.stoppedBy === "wallClock")) {
        console.log(`\n⚠ one or more strategies hit the wall-clock backstop — their sim-time is short of the others; raise --seconds before trusting this comparison.`);
    }
    const totalWarnings = results.reduce((a, r) => a + r.warnings.length, 0);
    if (totalWarnings) console.log(`⚠ ${totalWarnings} anomaly warning(s) logged — see per-strategy detail above.`);
    const shipped = results.find((r) => r.name === "shipped");
    if (shipped) {
        const better = results.filter((r) => r.name !== "shipped" && r.quarksPerSimHour > shipped.quarksPerSimHour);
        console.log("");
        console.log(better.length
            ? `⚠ ${better.map((r) => r.name).join(", ")} beat "shipped" on quarks/sim-hour — investigate before assuming the shipped CONFIG is still optimal.`
            : `✓ "shipped" was not beaten on quarks/sim-hour by any other strategy this run.`);
    }
}

// ── main ─────────────────────────────────────────────────────────────────
// Single-strategy runs execute directly in this process. Multi-strategy runs
// spawn one FRESH child process per strategy instead of looping in-process —
// running all 5 built-in strategies in one process at 48 simHours each OOM'd
// (confirmed: it died on the 5th, after accumulating through the first 4).
// Each child gets its own heap that the OS fully reclaims on exit, so peak
// memory is bounded to a single strategy's run regardless of how many
// strategies or how long each one simulates.
const RESULT_MARKER = "__RESULT_JSON__";

// Ad-hoc numeric overrides for grid sweeps (e.g. grid-sweep.js), so a wide
// parameter search doesn't need a named STRATEGIES entry per grid point.
// Unspecified fields fall back to the shipped defaults, so e.g. sweeping only
// --collapseMult still runs with a sane, fixed vapBoost/merge configuration.
const ADHOC_FIELDS = ["collapseMult", "vapBoost", "mergeBoost", "mergeMinBoost", "mergeMaxWaitMs", "starMinBatch", "starMinGapMs"];
function adhocCfgFromFlags() {
    const present = ADHOC_FIELDS.filter((f) => flag(f, null) !== null);
    if (!present.length) return null;
    const cfg = { ...STRATEGIES.shipped };
    for (const f of present) cfg[f] = Number(flag(f, null));
    cfg.label = `Ad-hoc: ${present.map((f) => `${f}=${cfg[f]}`).join(" ")}`;
    return cfg;
}

async function runOne(name, cfg, savePath) {
    console.log(`\nRunning "${name}" (${cfg.label})...`);
    const r = await runSim(name, cfg, savePath);
    printDetail(r);
    if (flag("json", null) !== null) {
        console.log(RESULT_MARKER);
        console.log(JSON.stringify(r));
    }
    return r;
}

(async () => {
    const savePath = resolveSavePath();

    const adhoc = adhocCfgFromFlags();
    if (strategyArg) {
        if (!STRATEGIES[strategyArg]) {
            console.error(`Unknown strategy "${strategyArg}". Available: ${Object.keys(STRATEGIES).join(", ")}`);
            process.exit(1);
        }
        await runOne(strategyArg, STRATEGIES[strategyArg], savePath);
        return;
    }
    if (adhoc) {
        await runOne("adhoc", adhoc, savePath);
        return;
    }

    const { execFileSync } = require("child_process");
    const results = [];
    for (const name of Object.keys(STRATEGIES)) {
        const childArgs = [
            __filename, name, `--save=${savePath}`,
            `--simHours=${SIM_CAP_MS / 3600000}`, `--seconds=${WALL_CAP / 1000}`, "--json=1",
        ];
        let out;
        try {
            out = execFileSync(process.execPath, childArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
        } catch (e) {
            // Surface the child's own output — "Command failed" alone hides
            // invariant-violation messages and stack traces from the child.
            if (e.stdout) process.stdout.write(String(e.stdout).slice(-4000));
            if (e.stderr) process.stderr.write(String(e.stderr).slice(-4000));
            throw new Error(`strategy "${name}" child process failed (exit ${e.status ?? "?"}) — its output is above`);
        }
        const [detail, jsonPart] = out.split(RESULT_MARKER);
        process.stdout.write(detail);
        if (!jsonPart) throw new Error(`child process for "${name}" exited without reporting a result`);
        results.push(JSON.parse(jsonPart));
    }
    printComparison(results, savePath);
})().catch((e) => {
    console.error("FATAL:", e.message);
    console.error(e.stack);
    process.exit(1);
});
