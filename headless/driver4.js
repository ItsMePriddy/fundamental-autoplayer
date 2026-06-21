const E = require("./engine.js");
const { player, global, Stage, U } = E;
const STEP = 250;
// develop a stage to its key progress milestone before allowing advancement
function developed(s){
  if (s===1) return true;                                   // stage1 reset auto-gated by requirement
  if (s===2) return E.clouds() > 1e4;                       // clouds>1e4 progress milestone
  if (s===3) return player.accretion.rank >= global.accretionInfo.maxRank; // max rank
  return true;
}
(async () => {
  E.newGame(); player.toggles.confirm = player.toggles.confirm.map(()=>"None");
  let sim=0,lastSR=0; const reached={1:0}; const wall0=Date.now(); const CAP=240*3600*1000;
  while (sim < CAP) {
    const cur = player.stage.current;
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s);
      if (s===1) await Stage.dischargeResetUser();
      else if (s===2){ if (E.vaporBoost()>=2.25) await Stage.vaporizationResetUser(); }
      else if (s===3) await Stage.rankResetUser();
    }
    // advance only when current stage developed (and not more often than 5s)
    if (sim-lastSR>=5000 && developed(cur)) { lastSR=sim; Stage.setActiveStage(cur); await Stage.stageResetUser(); }
    U.stageUpdate(); Stage.timeUpdate(STEP,STEP); sim+=STEP;
    const c=player.stage.current;
    if(!reached[c]){reached[c]=sim;console.log(`stage ${c} @ ${(sim/3600000).toFixed(2)}h | prog=${player.progress.main} clouds=${E.clouds().toExponential(1)} rank=${player.accretion?.rank} strange=${player.strange[0].total}`);}
    if(Date.now()-wall0>90000){console.log("guard @",(sim/3600000).toFixed(1),"h");break;}
  }
  console.log(`FINAL stage=${player.stage.current} prog=${player.progress.main} clouds=${E.clouds().toExponential(2)} rank=${player.accretion?.rank} strange=${player.strange[0].total} simH=${(sim/3600000).toFixed(0)}`);
})().catch(e=>console.error("ERR",e.message));
