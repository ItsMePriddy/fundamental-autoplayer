const E = require("./engine.js");
const { player, global, Stage, U } = E;
const STEP = 250;
(async () => {
  E.newGame();
  let sim = 0, lastSR = 0; const reached = {1:0}; const wall0 = Date.now();
  const CAP = 72*3600*1000; // 72h sim
  while (sim < CAP) {
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s);
      if (s===1) await Stage.dischargeResetUser();
      else if (s===2) { if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser(); }
      else if (s===3) await Stage.rankResetUser();
    }
    if (sim - lastSR >= 2000) { lastSR = sim; await Stage.stageResetUser(); }
    U.stageUpdate(); Stage.timeUpdate(STEP, STEP); sim += STEP;
    const c = player.stage.current;
    if (!reached[c]) { reached[c] = sim; console.log(`stage ${c} @ ${(sim/3600000).toFixed(2)}h | progress.main=${player.progress.main} | clouds=${E.clouds().toExponential(1)}`); }
    if (Date.now() - wall0 > 120000) { console.log("walltime guard @ sim", (sim/3600000).toFixed(1), "h"); break; }
  }
  console.log(`FINAL: stage.current=${player.stage.current} progress.main=${player.progress.main} clouds=${E.clouds().toExponential(2)} strangeTotal=${player.strange[0].total} | wall=${((Date.now()-wall0)/1000).toFixed(1)}s`);
})().catch(e => console.error("ERR", e.message));
