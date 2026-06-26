// Fresh-save mass-multiplier validation sweep
// Validates optimal mass multiplier against a FRESH game (not user's developed save)
const E = require("./engine.js");
const { player, global, Stage, U, num } = E;
const P = require("./build/Player");
const Main = require("./build/Main");
const STEP = 250;
const SWEEP_DURATION_MS = 600 * 1000; // 600s sim time per multiplier

function snapshot() {
  return {
    stage: player.stage.current,
    active: player.stage.active,
    mass: num(player.collapse?.mass || 0),
    stars: [...(player.collapse?.stars || [0,0,0])],
    totalStars: (player.collapse?.stars || [0,0,0]).reduce((a,b)=>a+b,0),
    prog: player.progress.main,
    clouds: E.clouds(),
    rank: player.accretion?.rank || 0,
    strange: player.strange[0].total,
    elements: player.collapse?.highest || 0,
  };
}

function saveState() {
  // Deep-clone the player state so we can restore later
  return Main.deepClone(player);
}

function restoreState(saved) {
  P.updatePlayer(Main.deepClone(saved), false);
  global.paused = false;
  player.toggles.confirm = player.toggles.confirm.map(() => "None");
  U.stageUpdate();
}

function totalStars() {
  return (player.collapse?.stars || [0,0,0]).reduce((a,b)=>a+b,0);
}

// Fast-forward to stage 4 using aggressive stage-advance
async function fastForwardToStage4() {
  E.newGame();
  player.toggles.confirm = player.toggles.confirm.map(() => "None");
  
  let sim = 0, lastSR = 0;
  const reached = {};
  const wall0 = Date.now();
  const SIM_CAP = 240 * 3600 * 1000; // 240h sim cap
  const WALL_CAP = 90000; // 90s wall clock
  
  console.log("=== Fast-forwarding to stage 4 ===");
  
  while (sim < SIM_CAP) {
    const cur = player.stage.current;
    
    // Buy everything in all active stages
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s);
      E.buyBuildings(s);
      E.buyUpgrades(s);
      E.buyStrange(s);
      
      if (s === 1) await Stage.dischargeResetUser();
      else if (s === 2) { 
        if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser(); 
      }
      else if (s === 3) await Stage.rankResetUser();
      else if (s === 4) {
        // Buy elements
        for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, 'elements', false);
        // Collapse when we have star checks
        Stage.assignResetInformation.newStars();
        const sc = global.collapseInfo.starCheck;
        if ((sc[0] + sc[1] + sc[2]) >= 1) await Stage.collapseResetUser();
      }
    }
    
    // Advance stage when developed
    if (sim - lastSR >= 5000) {
      lastSR = sim;
      Stage.setActiveStage(cur);
      await Stage.stageResetUser();
    }
    
    U.stageUpdate();
    Stage.timeUpdate(STEP, STEP);
    sim += STEP;
    
    const c = player.stage.current;
    if (!reached[c]) {
      reached[c] = sim;
      console.log(`  stage ${c} @ ${(sim/3600000).toFixed(2)}h sim | prog=${player.progress.main} | clouds=${E.clouds().toExponential(1)} | rank=${player.accretion?.rank} | stars=${totalStars()} | wall=${((Date.now()-wall0)/1000).toFixed(1)}s`);
    }
    
    // Stop when we hit stage 4
    if (c >= 4) {
      console.log(`  Reached stage 4! sim=${(sim/3600000).toFixed(2)}h wall=${((Date.now()-wall0)/1000).toFixed(1)}s`);
      break;
    }
    
    if (Date.now() - wall0 > WALL_CAP) {
      console.log(`  Wall-clock guard @ ${(sim/3600000).toFixed(1)}h sim`);
      break;
    }
  }
  
  return snapshot();
}

// Run a single multiplier test: set multiplier, run for duration, measure stars/sec
async function testMultiplier(multiplier, durationMs) {
  // Set the mass multiplier
  player.collapse.input[0] = multiplier;
  player.collapse.input[1] = 0; // No wait - fire immediately when threshold met
  
  const startStars = totalStars();
  const startMass = num(player.collapse?.mass || 0);
  let sim = 0;
  let collapses = 0;
  
  while (sim < durationMs) {
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s);
      E.buyBuildings(s);
      E.buyUpgrades(s);
      E.buyStrange(s);
      
      if (s === 1) await Stage.dischargeResetUser();
      else if (s === 2) { 
        if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser(); 
      }
      else if (s === 3) await Stage.rankResetUser();
      else if (s === 4) {
        for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, 'elements', false);
        const before = totalStars();
        await Stage.collapseResetUser();
        if (totalStars() > before) collapses++;
      }
    }
    
    U.stageUpdate();
    Stage.timeUpdate(STEP, STEP);
    sim += STEP;
  }
  
  const endStars = totalStars();
  const endMass = num(player.collapse?.mass || 0);
  const starsGained = endStars - startStars;
  const starsPerSec = starsGained / (durationMs / 1000);
  
  return {
    multiplier,
    startStars,
    endStars,
    starsGained,
    starsPerSec,
    startMass,
    endMass,
    collapses,
    simSec: durationMs / 1000,
  };
}

// Run a full sweep of multipliers at the current game state
async function runSweep(baseState, label) {
  console.log(`\n=== Mass Multiplier Sweep: ${label} ===`);
  console.log(`Baseline: stars=${totalStars()} mass=${num(player.collapse?.mass||0).toExponential(2)} stage=${player.stage.current}`);
  
  const multipliers = [];
  for (let m = 1.2; m <= 5.05; m += 0.2) {
    multipliers.push(Math.round(m * 10) / 10);
  }
  
  const results = [];
  const wall0 = Date.now();
  
  for (const mult of multipliers) {
    // Restore base state for each test
    restoreState(baseState);
    
    const r = await testMultiplier(mult, SWEEP_DURATION_MS);
    results.push(r);
    
    const wallElapsed = ((Date.now() - wall0) / 1000).toFixed(1);
    console.log(`  mult=${r.multiplier.toFixed(1)} | stars/sec=${r.starsPerSec.toFixed(4)} | gained=${r.starsGained} | collapses=${r.collapses} | mass=${r.endMass.toExponential(2)} | wall=${wallElapsed}s`);
  }
  
  // Find best
  const best = results.reduce((a, b) => b.starsPerSec > a.starsPerSec ? b : a, results[0]);
  console.log(`\n  BEST: multiplier=${best.multiplier.toFixed(1)} stars/sec=${best.starsPerSec.toFixed(4)}`);
  
  return { label, baseline: snapshot(), results, best };
}

// Accumulate stars by running collapses at the optimal multiplier
async function accumulateStars(targetStars, optimalMultiplier) {
  player.collapse.input[0] = optimalMultiplier;
  player.collapse.input[1] = 0;
  
  const startStars = totalStars();
  let sim = 0;
  const SIM_CAP = 120 * 3600 * 1000; // 120h sim cap
  const wall0 = Date.now();
  
  console.log(`\n  Accumulating stars: ${startStars} -> target ${targetStars} (mult=${optimalMultiplier})`);
  
  while (totalStars() < targetStars && sim < SIM_CAP) {
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s);
      E.buyBuildings(s);
      E.buyUpgrades(s);
      E.buyStrange(s);
      
      if (s === 1) await Stage.dischargeResetUser();
      else if (s === 2) { 
        if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser(); 
      }
      else if (s === 3) await Stage.rankResetUser();
      else if (s === 4) {
        for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, 'elements', false);
        await Stage.collapseResetUser();
      }
    }
    
    U.stageUpdate();
    Stage.timeUpdate(STEP, STEP);
    sim += STEP;
    
    if (Date.now() - wall0 > 60000) {
      console.log(`  Accumulate wall guard @ ${totalStars()} stars`);
      break;
    }
  }
  
  console.log(`  Accumulated to ${totalStars()} stars in ${(sim/3600000).toFixed(1)}h sim`);
  return totalStars();
}

async function main() {
  const resultsFile = "/Users/spencer/Downloads/Personal/Coding/Fundamental Player/Resources/fresh-save-validation.txt";
  const output = [];
  
  function log(msg) {
    console.log(msg);
    output.push(msg);
  }
  
  log("Fresh-Save Mass Multiplier Validation");
  log("=====================================");
  log(`Start: ${new Date().toISOString()}`);
  log("");
  
  // Phase 1: Fast-forward to stage 4
  const wallStart = Date.now();
  log("Phase 1: Fast-forward to stage 4");
  const s4State = await fastForwardToStage4();
  log(`  Final: stage=${s4State.stage} stars=${s4State.totalStars} mass=${s4State.mass.toExponential(2)}`);
  log("");
  
  // Save the stage-4 base state for sweeps
  const baseState = saveState();
  log(`Saved base state: stars=${totalStars()} mass=${num(player.collapse?.mass||0).toExponential(2)}`);
  log("");
  
  // Phase 2: Run sweep at baseline star count
  log("Phase 2: Baseline sweep (fresh stage 4)");
  const sweep1 = await runSweep(baseState, "Baseline (~0 stars)");
  log("");
  
  // Phase 3: Accumulate ~5 collapses worth of stars and sweep again
  const optMult1 = sweep1.best.multiplier;
  log(`Phase 3: Accumulate stars using optimal multiplier ${optMult1.toFixed(1)}`);
  
  // First, run a few collapses to accumulate some stars
  restoreState(baseState);
  await accumulateStars(5, optMult1);
  const state5Stars = saveState();
  log(`State after ~5 stars: actual=${totalStars()}`);
  
  const sweep2 = await runSweep(state5Stars, `After ~${totalStars()} stars`);
  log("");
  
  // Phase 4: Accumulate more stars (~15 total) and sweep again
  const optMult2 = sweep2.best.multiplier;
  log(`Phase 4: Accumulate more stars using optimal multiplier ${optMult2.toFixed(1)}`);
  
  restoreState(state5Stars);
  await accumulateStars(15, optMult2);
  const state15Stars = saveState();
  log(`State after ~15 stars: actual=${totalStars()}`);
  
  const sweep3 = await runSweep(state15Stars, `After ~${totalStars()} stars`);
  log("");
  
  // Summary
  const wallTotal = ((Date.now() - wallStart) / 1000).toFixed(1);
  log("=====================================");
  log("SUMMARY");
  log("=====================================");
  log(`Total wall time: ${wallTotal}s`);
  log("");
  
  for (const sweep of [sweep1, sweep2, sweep3]) {
    log(`--- ${sweep.label} ---`);
    log(`  Baseline stars: ${sweep.baseline.totalStars}  mass: ${sweep.baseline.mass.toExponential(2)}`);
    log(`  Optimal multiplier: ${sweep.best.multiplier.toFixed(1)}  stars/sec: ${sweep.best.starsPerSec.toFixed(4)}`);
    log(`  All results (mult -> stars/sec):`);
    for (const r of sweep.results) {
      log(`    ${r.multiplier.toFixed(1)} -> ${r.starsPerSec.toFixed(4)} stars/sec (gained=${r.starsGained}, collapses=${r.collapses})`);
    }
    log("");
  }
  
  // Write results to file
  const fs = require("fs");
  fs.writeFileSync(resultsFile, output.join("\n"), "utf8");
  console.log(`\nResults written to ${resultsFile}`);
}

main().catch(e => {
  console.error("FATAL:", e.message, e.stack?.split("\n").slice(0,3).join("\n"));
  process.exitCode = 1;
});
