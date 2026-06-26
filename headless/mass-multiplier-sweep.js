// Mass multiplier sweep for collapse timing
// Tests multipliers from 1.2x to 5.0x with various anti-hang timers
const fs = require("fs");
const E = require("./engine.js");
const { player, global, Stage, U, num } = E;
const SP = require("./build/Special");

const STEP = 250; // ms per tick
const SIM_DURATION = 600 * 1000; // 600s sim time
const WALL_CAP = 90 * 1000; // 90s wall time per test
const MIN_GAP = 2000; // 2s min gap between collapse attempts

// Save file path (note: actual file has 17-05-58, not 15-12-06 as user stated)
const SAVE_PATH = "/Users/spencer/Downloads/Personal/Coding/Fundamental Player/Resources/Fundamental, 26.06.2026 17-05-58, Interstellar.txt";

function loadSave() {
    const b64 = fs.readFileSync(SAVE_PATH, "utf8").trim();
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    E.P.updatePlayer(json, true);
    global.offline.active = false;
    player.toggles.confirm = player.toggles.confirm.map(() => "None");
    U.stageUpdate(true, true);
}

// Disable auto-resets so we control collapse timing
function disableAutos() {
    const t = player.toggles;
    t.auto = t.auto.map(() => false);
    // Keep buildings auto on for progress
    for (let s = 1; s <= 6; s++) {
        if (t.buildings[s]) t.buildings[s] = t.buildings[s].map(() => true);
    }
    t.confirm = t.confirm.map(() => "None");
}

async function runTest(multiplier, antiHangSec) {
    loadSave();
    disableAutos();
    
    let sim = 0;
    let lastCollapse = -MIN_GAP; // allow immediate first collapse
    let collapses = 0;
    let starsBefore = [0, 0, 0];
    let starsGained = [0, 0, 0];
    let massGained = 0;
    const wall0 = Date.now();
    
    // Record initial stars
    starsBefore = [...player.collapse.stars];
    
    while (sim < SIM_DURATION) {
        // Check wall time
        if (Date.now() - wall0 > WALL_CAP) {
            break;
        }
        
        // Always clear offline flag and check progress
        global.offline.active = false;
        SP.checkProgress();
        
        // Buy everything for all active stages
        for (const s of global.stageInfo.activeAll) {
            Stage.setActiveStage(s);
            E.buyBuildings(s);
            E.buyUpgrades(s);
            E.buyStrange(s);
            
            // Handle earlier-stage resets
            if (s === 1) await Stage.dischargeResetUser();
            else if (s === 2) {
                if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser();
            }
            else if (s === 3) await Stage.rankResetUser();
        }
        
        // Collapse logic for stage 4
        Stage.setActiveStage(4);
        
        // Ensure collapse upgrade is bought
        if (player.upgrades[4][0] !== 1) {
            E.buyUpgrades(4);
        }
        
        // Check if collapse is possible
        const timeSinceLastCollapse = sim - lastCollapse;
        const canAttempt = timeSinceLastCollapse >= MIN_GAP;
        
        // Compute new mass
        Stage.assignResetInformation.newMass();
        const newMass = global.collapseInfo.newMass;
        const currentMass = player.collapse.mass;
        
        // Trigger collapse when newMass >= currentMass * multiplier (with min gap)
        const antiHangMs = antiHangSec * 1000;
        let shouldCollapse = false;
        if (canAttempt && newMass > 0 && currentMass > 0) {
            if (newMass >= currentMass * multiplier) {
                shouldCollapse = true;
            }
        }
        // Anti-hang: if multiplier condition not met but timer elapsed, force collapse
        if (!shouldCollapse && canAttempt && timeSinceLastCollapse >= antiHangMs) {
            shouldCollapse = true;
        }
        
        if (shouldCollapse) {
            const sBefore = [...player.collapse.stars];
            const mBefore = player.collapse.mass;
            
            await Stage.collapseResetUser();
            
            const sAfter = player.collapse.stars;
            const mAfter = player.collapse.mass;
            
            // Track gains
            for (let i = 0; i < 3; i++) {
                const gained = sAfter[i] - sBefore[i];
                if (gained > 0) starsGained[i] += gained;
            }
            const massDelta = mAfter - mBefore;
            if (massDelta > 0) massGained += massDelta;
            
            collapses++;
            lastCollapse = sim;
        }
        
        // Stage reset check (advance stages)
        if (sim - lastCollapse >= 5000) {
            const cur = player.stage.current;
            Stage.setActiveStage(cur);
            await Stage.stageResetUser();
        }
        
        U.stageUpdate();
        Stage.timeUpdate(STEP, STEP);
        sim += STEP;
    }
    
    // Final tally
    const totalStars = starsGained[0] + starsGained[1] + starsGained[2];
    const simSec = sim / 1000;
    const starsPerSec = simSec > 0 ? totalStars / simSec : 0;
    const wallSec = (Date.now() - wall0) / 1000;
    
    return {
        multiplier,
        antiHangSec,
        collapses,
        starsGained,
        totalStars,
        massGained: massGained.toExponential ? massGained.toExponential(2) : massGained.toFixed(2),
        starsPerSec: starsPerSec.toFixed(6),
        simSec: simSec.toFixed(1),
        wallSec: wallSec.toFixed(1),
        finalStars: [...player.collapse.stars],
        finalMass: player.collapse.mass,
    };
}

(async () => {
    const multipliers = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.5, 4.0, 5.0];
    const antiHangTimers = [30, 45, 60, 90];
    
    const results = [];
    
    console.log("=".repeat(80));
    console.log("MASS MULTIPLIER SWEEP - Collapse Timing Analysis");
    console.log("=".repeat(80));
    console.log(`Sim duration: ${SIM_DURATION/1000}s | Wall cap: ${WALL_CAP/1000}s per test`);
    console.log(`Anti-hang timers: ${antiHangTimers.join('s, ')}s`);
    console.log("");
    
    for (const mult of multipliers) {
        for (const ah of antiHangTimers) {
            const label = `${mult}x / ${ah}s anti-hang`;
            process.stdout.write(`Testing ${label}... `);
            
            try {
                const r = await runTest(mult, ah);
                results.push(r);
                console.log(`${r.collapses} collapses, ${r.totalStars} stars, ${r.starsPerSec} stars/s (wall: ${r.wallSec}s)`);
            } catch (e) {
                console.log(`ERROR: ${e.message}`);
                results.push({
                    multiplier: mult,
                    antiHangSec: ah,
                    collapses: 0,
                    starsGained: [0, 0, 0],
                    totalStars: 0,
                    massGained: "0",
                    starsPerSec: "0.000000",
                    simSec: "0.0",
                    wallSec: "0.0",
                    error: e.message,
                });
            }
        }
    }
    
    // Sort by stars/second descending
    results.sort((a, b) => parseFloat(b.starsPerSec) - parseFloat(a.starsPerSec));
    
    // Build output table
    let out = "";
    out += "=".repeat(100) + "\n";
    out += "MASS MULTIPLIER SWEEP RESULTS - Ranked by Stars/Second\n";
    out += "=".repeat(100) + "\n\n";
    out += "Simulation: 600s per test, 250ms steps, 90s wall-time cap\n";
    out += "Save: Fundamental, 26.06.2026 17-05-58, Interstellar.txt (Stage 4)\n";
    out += "Collapse triggers when newMass >= currentMass * multiplier (2s min gap)\n";
    out += "Stars = sum of white/brown/black dwarfs\n\n";
    
    out += `${'Rank'.padEnd(5)} ${'Multiplier'.padEnd(11)} ${'Anti-Hang'.padEnd(10)} ${'Collapses'.padEnd(10)} ${'Total Stars'.padEnd(12)} ${'Stars/Sec'.padEnd(14)} ${'Mass Gained'.padEnd(14)} ${'Sim Sec'.padEnd(8)} ${'Wall Sec'.padEnd(8)}\n`;
    out += "-".repeat(100) + "\n";
    
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        out += `${String(i + 1).padEnd(5)} ${String(r.multiplier + 'x').padEnd(11)} ${String(r.antiHangSec + 's').padEnd(10)} ${String(r.collapses).padEnd(10)} ${String(r.totalStars).padEnd(12)} ${String(r.starsPerSec).padEnd(14)} ${String(r.massGained).padEnd(14)} ${String(r.simSec).padEnd(8)} ${String(r.wallSec).padEnd(8)}\n`;
    }
    
    out += "\n" + "-".repeat(100) + "\n";
    
    // Summary by multiplier (best anti-hang for each multiplier)
    out += "\nBEST ANTI-HANG PER MULTIPLIER:\n";
    out += `${'Multiplier'.padEnd(11)} ${'Best AH'.padEnd(10)} ${'Stars/Sec'.padEnd(14)} ${'Collapses'.padEnd(10)}\n`;
    out += "-".repeat(50) + "\n";
    
    for (const mult of multipliers) {
        const best = results
            .filter(r => r.multiplier === mult)
            .sort((a, b) => parseFloat(b.starsPerSec) - parseFloat(a.starsPerSec))[0];
        if (best) {
            out += `${String(mult + 'x').padEnd(11)} ${String(best.antiHangSec + 's').padEnd(10)} ${String(best.starsPerSec).padEnd(14)} ${String(best.collapses).padEnd(10)}\n`;
        }
    }
    
    // Best overall
    out += "\n" + "=".repeat(50) + "\n";
    out += `BEST OVERALL: ${results[0].multiplier}x with ${results[0].antiHangSec}s anti-hang (${results[0].starsPerSec} stars/s, ${results[0].totalStars} total stars)\n`;
    
    // Write results
    const outPath = "/Users/spencer/Downloads/Personal/Coding/Fundamental Player/Resources/mass-multiplier-sweep-results.txt";
    fs.writeFileSync(outPath, out, "utf8");
    
    console.log("\n" + out);
    console.log(`\nResults written to: ${outPath}`);
})().catch(e => {
    console.error("FATAL ERROR:", e.message);
    console.error(e.stack);
    process.exit(1);
});
