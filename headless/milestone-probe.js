// Milestone-attempt validation probe — the tool behind v1.17.0's milestone
// completion engine (Fundamental.user.js `milestoneAttempts`). Replays a real
// save and measures, per policy variant, which non-vacuum milestone tiers get
// earned (with stage-time stamps), which windows fail and how close they got
// (peak/need feasibility ratio), and what the policy costs in quark throughput.
//
// The variants encode the design questions the shipped CONFIG answers:
//   baseline            — no milestone logic: proves NO tier ever advances alone
//   attempt-full        — suppress discharge/vaporize for the whole window: fails
//                         utterly (production never ramps; s1 peak 1e-159% of need)
//   attempt-ramp50/30   — suppress only after 50%/30% of the window: earns tiers
//   attempt-nostarhold  — proves collapse suppression HURTS the s5 star milestone
//                         (97% of target with normal collapses vs 3% suppressed)
//   ship                — the shipped policy: ramp 0.3 + retry backoff + 12-min
//                         stall release. 36 simH from the 03.07.2026 save:
//                         +19 tiers (5 milestones maxed) AND >2x baseline quarks.
//
// Usage: node milestone-probe.js [variant] [--simHours=36] [--seconds=900]
//        [--save=<path>]  (defaults to the newest save in Resources/saves/)
const path = require("path");
const fs = require("fs");
const E = require("./engine.js");
const { player, global, Stage, U } = E;
const SP = require("./build/Special");
const Check = require("./build/Check");

const STEP = 250;
const SAVES_DIR = path.join(__dirname, "..", "Resources", "saves");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};
const SIM_CAP_MS = Number(flag("simHours", 36)) * 3600 * 1000;
const WALL_CAP = Number(flag("seconds", 900)) * 1000;
const variantArg = args.find((a) => !a.startsWith("--"));

function resolveSavePath() {
    const override = flag("save", null);
    if (override) return override;
    const files = fs.readdirSync(SAVES_DIR)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => ({ f, t: fs.statSync(path.join(SAVES_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    if (!files.length) throw new Error(`No save files in ${SAVES_DIR}`);
    return path.join(SAVES_DIR, files[0].f);
}
const SAVE = resolveSavePath();

function loadSave() {
    const b64 = fs.readFileSync(SAVE, "utf8").trim();
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    const origAuto = E.Main.playerStart.toggles.auto;
    const origNormal = E.Main.playerStart.toggles.normal;
    E.Main.playerStart.toggles.auto = Array(json.toggles?.auto?.length || 12).fill(false);
    E.Main.playerStart.toggles.normal = Array(json.toggles?.normal?.length || 8).fill(false);
    E.P.updatePlayer(json, true);
    E.Main.playerStart.toggles.auto = origAuto;
    E.Main.playerStart.toggles.normal = origNormal;
    global.offline.active = false;
    player.toggles.confirm = player.toggles.confirm.map(() => "None");
    // Match the sim policy: no native autos, script drives everything.
    player.toggles.auto = player.toggles.auto.map(() => false);
    player.toggles.normal = player.toggles.normal.map(() => false);
    U.stageUpdate(true, true);
}

const fmtT = (s) => s >= 3600 ? (s / 3600).toFixed(2) + "h" : s >= 60 ? (s / 60).toFixed(1) + "m" : s.toFixed(0) + "s";
const fmtSim = (ms) => fmtT(ms / 1000);

// Pending milestone windows for the CURRENT run. Mirrors the game's own
// noTime logic (Update.js:112): relevant stage set is min(current,4), plus
// stage 5 when current is 4/5 (each s5 index gated on milestones[4][i]>=8).
function pendingList() {
    const cur = Math.min(player.stage.current, 4);
    const stages = cur === 4 ? [4, 5] : [cur];
    const out = [];
    for (const s of stages) {
        const info = global.milestonesInfo[s];
        for (let i = 0; i < info.scaling.length; i++) {
            const lvl = player.milestones[s][i];
            if (lvl >= info.scaling[i].length) continue;
            if (s === 5 && player.milestones[4][i] < 8) continue;
            out.push({ s, i, lvl, limit: info.reward[i], inWindow: player.time.stage <= info.reward[i] });
        }
    }
    return out;
}

const VARIANTS = {
    // no milestone logic at all — reference throughput + confirms nothing advances alone
    baseline: { hold: false, s1: "off", s2: false, s5stars: false },
    // hold stage resets while windows are open, suppress destructive resets for the whole window
    "attempt-full": { hold: true, s1: "full", s2: true, s5stars: true },
    // same but discharge stays allowed until 50% of the tightest open s1 window has elapsed
    "attempt-ramp50": { hold: true, s1: "ramp", rampFrac: 0.5, s2: true, s5stars: true },
    // ramp for both s1 discharge AND s2 vaporize (vaporize early to bank boost, then hold)
    "attempt-ramp30": { hold: true, s1: "ramp", rampFrac: 0.3, s2: "ramp", rampFrac2: 0.3, s5stars: true },
    // isolate the s5[0] collapse suppression: same as ramp50 but collapses run normally
    "attempt-nostarhold": { hold: true, s1: "ramp", rampFrac: 0.5, s2: true, s5stars: false },
    // candidate ship policy: ramp30 for discharge+vaporize, no collapse suppression,
    // retry backoff on failed windows, growth-stall release while suppressed
    ship: { hold: true, s1: "ramp", rampFrac: 0.3, s2: "ramp", rampFrac2: 0.3, s5stars: false,
        backoff: true, stallMs: 720000 },
};

async function runVariant(name, cfg) {
    loadSave();
    player.vaporization.input[1] = 1e6;

    const wall0 = Date.now();
    let sim = 0, lastCollapse = -2000, lastMerge = -2000, lastAdvance = -2000;
    let loops = 0, collapses = 0;
    let lastStage = player.stage.current;
    let loopStartSim = null, loopQuarksSum = 0, loopDurationSum = 0;
    let quarksAtLoopStart = player.strange[0].total;
    const startMilestones = player.milestones.map((m) => m.slice());
    const awards = [];
    const windowTrack = {};
    const backoffState = {};
    let runDead = new Set();
    let lastCur = player.stage.current;
    let prevMilestones = player.milestones.map((m) => m.slice());
    let stoppedBy = "simHours";

    while (true) {
        if (sim >= SIM_CAP_MS) { stoppedBy = "simHours"; break; }
        if (Date.now() - wall0 >= WALL_CAP) { stoppedBy = "wallClock"; break; }
        global.offline.active = false;
        SP.checkProgress();
        const cur = player.stage.current;

        // milestone award diff
        for (let s = 1; s <= 5; s++) for (let i = 0; i < 2; i++) {
            if ((player.milestones[s]?.[i] ?? 0) > (prevMilestones[s]?.[i] ?? 0)) {
                awards.push({ s, i, tier: player.milestones[s][i], sim, stageTime: player.time.stage });
                console.log(`  [${name}] +milestone s${s}[${i}] -> tier ${player.milestones[s][i]} at sim=${fmtSim(sim)} (stage time ${fmtT(player.time.stage)})`);
            }
        }
        prevMilestones = player.milestones.map((m) => m.slice());

        if (cur === 1 && lastStage !== 1) {
            if (loopStartSim !== null) {
                loops++;
                loopDurationSum += sim - loopStartSim;
                loopQuarksSum += player.strange[0].total - quarksAtLoopStart;
            }
            loopStartSim = sim;
            quarksAtLoopStart = player.strange[0].total;
        }
        lastStage = cur;

        const pending = pendingList();
        // Backoff: a tier whose last window failed sits out until its cooldown ends.
        // Cooldown scales with how far the failed attempt got (peak/need ratio) and
        // doubles per consecutive failure (capped).
        if (player.time.stage < lastCur) { runDead = new Set(); } // time.stage dropped -> new run
        lastCur = player.time.stage;
        const attempted = pending.filter((p) => {
            const key = `s${p.s}[${p.i}]t${p.lvl}`;
            if (runDead.has(key)) return false;
            if (!cfg.backoff) return true;
            const bk = backoffState[key];
            return !bk || sim >= bk.nextTryAt;
        });
        const open = attempted.filter((p) => p.inWindow);

        // Track the peak value each open milestone reaches inside its window, and
        // report peak-vs-need when the window closes (feasibility distance).
        for (const p of open) {
            const key = `s${p.s}[${p.i}]t${p.lvl}`;
            const val = E.num(Check.milestoneGetValue(p.i, p.s));
            const need = E.num(global.milestonesInfo[p.s].need[p.i]);
            if (!windowTrack[key]) windowTrack[key] = { peak: 0, need, limit: p.limit, opened: sim, lastImprove: sim };
            const w = windowTrack[key];
            if (Number.isFinite(val) && val > w.peak * 1.02) w.lastImprove = sim;
            if (Number.isFinite(val) && val > w.peak) w.peak = val;
            w.lastSeen = sim;
            // Growth-stall release: no >2% improvement for stallMs while the window
            // is open -> declare this tier dead for the rest of the run (backoff applies
            // when the window-closed report fires).
            if (cfg.stallMs && sim - w.lastImprove > cfg.stallMs) {
                runDead.add(key);
                console.log(`  [${name}] stalled ${key}: peak=${w.peak.toExponential(2)}/${need.toExponential(2)} — releasing for this run`);
            }
        }
        for (const key of Object.keys(windowTrack)) {
            const w = windowTrack[key];
            if (w.lastSeen !== undefined && sim - w.lastSeen > 60000 && !w.reported) {
                w.reported = true;
                const earned = awards.some((a) => key === `s${a.s}[${a.i}]t${a.tier - 1}`);
                if (!w.logged) console.log(`  [${name}] window closed ${key}: peak=${w.peak.toExponential(2)} need=${w.need.toExponential(2)} (${(w.peak / w.need * 100).toPrecision(2)}%) limit=${fmtT(w.limit)}${earned ? ' EARNED' : ''}`);
                if (cfg.backoff && !earned) {
                    const ratio = w.peak / w.need;
                    const prev = backoffState[key];
                    const fails = (prev?.fails || 0) + 1;
                    const base = ratio >= 0.9 ? 1800000 : ratio >= 0.3 ? 3600000 : 10800000;
                    const cool = Math.min(base * Math.pow(2, fails - 1), 21600000);
                    backoffState[key] = { fails, nextTryAt: sim + cool };
                    console.log(`  [${name}] backoff ${key}: ratio=${(ratio * 100).toPrecision(2)}% fail#${fails} cooldown=${fmtT(cool / 1000)}`);
                    // allow re-tracking on the retry
                    delete windowTrack[key];
                }
            }
        }

        // Suppression decisions for this tick
        const s1open = open.filter((p) => p.s === 1);
        let suppressDischarge = false;
        if (s1open.length && cfg.s1 === "full") suppressDischarge = true;
        else if (s1open.length && cfg.s1 === "ramp") {
            const tightest = Math.min(...s1open.map((p) => p.limit));
            suppressDischarge = player.time.stage > (cfg.rampFrac ?? 0.5) * tightest;
        }
        const s2open = open.filter((p) => p.s === 2);
        let suppressVaporize = false;
        if (s2open.length && cfg.s2 === true) suppressVaporize = true;
        else if (s2open.length && cfg.s2 === "ramp") {
            const tightest = Math.min(...s2open.map((p) => p.limit));
            suppressVaporize = player.time.stage > (cfg.rampFrac2 ?? 0.3) * tightest;
        }
        const s5starOpen = cfg.s5stars && open.some((p) => p.s === 5 && p.i === 0);

        for (const s of global.stageInfo.activeAll) {
            Stage.setActiveStage(s);
            E.buyBuildings(s);
            E.buyUpgrades(s);
            E.buyStrange(s);

            if (s === 1) {
                if (!suppressDischarge) await Stage.dischargeResetUser();
            } else if (s === 2) {
                if (!suppressVaporize && E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser();
            } else if (s === 3) {
                await Stage.rankResetUser();
            } else if (s === 4) {
                for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, "elements", false);
                if (!s5starOpen) {
                    Stage.assignResetInformation.newMass();
                    Stage.assignResetInformation.newStars();
                    const nm = global.collapseInfo.newMass;
                    const cm = player.collapse.mass;
                    const sc = global.collapseInfo.starCheck || [0, 0, 0];
                    const pendingStars = sc[0] + sc[1] + sc[2];
                    const elementPending = player.elements.some((v) => v === 0.5);
                    const sinceCollapse = sim - lastCollapse;
                    const massRatio = cm > 0 ? nm / cm : 0;
                    let fire = false;
                    if (pendingStars >= 50 && sinceCollapse >= 30000) fire = true;
                    else if (elementPending && sinceCollapse >= 3000) fire = true;
                    else if (sinceCollapse >= 2000 && cm > 0 && massRatio >= 1.3) fire = true;
                    else if (sinceCollapse >= 300000) fire = true;
                    else if (sinceCollapse >= 120000 && massRatio >= 1.3) fire = true;
                    if (fire) { await Stage.collapseResetUser(); collapses++; lastCollapse = sim; }
                }
            } else if (s === 5) {
                if (!player.inflation.vacuum) {
                    if (sim - lastMerge >= 2000) { lastMerge = sim; await Stage.mergeResetUser(); }
                }
            }
        }

        if (sim - lastAdvance >= 2000) {
            const holdForMilestones = cfg.hold && open.length > 0;
            if (!holdForMilestones) {
                Stage.setActiveStage(cur);
                await Stage.stageResetUser();
            }
            lastAdvance = sim;
        }

        U.stageUpdate();
        Stage.timeUpdate(STEP, STEP);
        sim += STEP;
    }

    const endMilestones = player.milestones.map((m) => m.slice());
    return {
        name, stoppedBy, simH: sim / 3600000,
        loops,
        quarksPerSimH: loops ? (loopQuarksSum / (sim / 3600000)) : (player.strange[0].total) / (sim / 3600000),
        quarksTotal: player.strange[0].total,
        collapses,
        milestonesBefore: startMilestones, milestonesAfter: endMilestones,
        awards,
    };
}

(async () => {
    const names = variantArg ? [variantArg] : Object.keys(VARIANTS);
    const results = [];
    for (const n of names) {
        console.log(`\n=== ${n} ===`);
        const r = await runVariant(n, VARIANTS[n]);
        results.push(r);
        console.log(`  done: ${r.simH.toFixed(1)} simH (${r.stoppedBy}), loops=${r.loops}, collapses=${r.collapses}, quarksTotal=${r.quarksTotal.toFixed(1)}`);
        console.log(`  milestones: ${JSON.stringify(r.milestonesBefore.slice(1))} -> ${JSON.stringify(r.milestonesAfter.slice(1))}`);
    }
    console.log("\n=== summary ===");
    for (const r of results) {
        const gained = r.awards.length;
        console.log(`${r.name.padEnd(16)} simH=${r.simH.toFixed(1).padStart(5)} tiers+${String(gained).padStart(2)} quarksTotal=${r.quarksTotal.toFixed(0).padStart(8)} loops=${r.loops}`);
    }
})();
