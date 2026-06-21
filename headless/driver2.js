const E = require("./engine.js");
const { player, global, Stage, U } = E;
const STEP = 250;
function enableAutos(){
  const t = player.toggles;
  t.auto = t.auto.map(()=>true);
  t.normal = t.normal.map(()=>true);
  for (let s=1;s<=6;s++){ if (t.buildings[s]) t.buildings[s] = t.buildings[s].map(()=>true); }
  if (t.verses) t.verses = t.verses.map(()=>true);
  t.confirm = t.confirm.map(()=>"None");
  // sensible auto thresholds
  player.vaporization.input = [2.25, 1e6];
  player.stage.input = player.stage.input.map((v,i)=> i===0?2:v);
  if (player.collapse) player.collapse.input = 2;
  if (player.merge) player.merge.input = [1, 0];
}
(async () => {
  E.newGame(); enableAutos();
  let sim = 0; const reached = {1:0}; const wall0 = Date.now();
  const CAP = 240*3600*1000;
  while (sim < CAP) {
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s);
      if (s===1) await Stage.dischargeResetUser();
      else if (s===2) { if (E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser(); }
      else if (s===3) await Stage.rankResetUser();
    }
    enableAutos(); // re-assert (resets may rebuild toggle arrays)
    U.stageUpdate(); Stage.timeUpdate(STEP, STEP); sim += STEP;
    const c = player.stage.current;
    if (!reached[c]) { reached[c]=sim; console.log(`stage ${c} @ ${(sim/3600000).toFixed(2)}h | prog=${player.progress.main} clouds=${E.clouds().toExponential(1)} strange=${player.strange[0].total}`); }
    if (Date.now()-wall0 > 90000) { console.log("walltime guard @", (sim/3600000).toFixed(1),"h sim"); break; }
  }
  console.log(`FINAL: stage=${player.stage.current} prog=${player.progress.main} clouds=${E.clouds().toExponential(2)} strange=${player.strange[0].total} rank=${player.accretion?.rank}`);
})().catch(e => console.error("ERR", e.message, e.stack.split("\n").slice(0,3).join("\n")));
