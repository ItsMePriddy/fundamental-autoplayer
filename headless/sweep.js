const E = require("./engine.js");
const { player, global, Stage, U } = E;
const STEP = 250;
async function toSubmerged(){ E.newGame(); let sim=0,lastSR=0;
  while(player.stage.current<2 && sim<3*3600*1000){ for(const s of global.stageInfo.activeAll){Stage.setActiveStage(s);E.buyBuildings(s);E.buyUpgrades(s);E.buyStrange(s);if(s===1)await Stage.dischargeResetUser();}
    if(sim-lastSR>=2000){lastSR=sim;await Stage.stageResetUser();} U.stageUpdate();Stage.timeUpdate(STEP,STEP);sim+=STEP;} }
// time (sim seconds) to reach target clouds at fixed boost threshold
async function timeTo(boost, target, capMs){ await toSubmerged(); let sim=0,vaps=0;
  while(E.clouds()<target && sim<capMs){ for(const s of global.stageInfo.activeAll){Stage.setActiveStage(s);E.buyBuildings(s);E.buyUpgrades(s);E.buyStrange(s);if(s===1)await Stage.dischargeResetUser();}
    Stage.setActiveStage(2); if(E.vaporBoost()>=boost){await Stage.vaporizationResetUser();vaps++;} U.stageUpdate();Stage.timeUpdate(STEP,STEP);sim+=STEP; }
  return { reached:E.clouds()>=target, sec:+(sim/1000).toFixed(0), vaps, clouds:E.clouds().toExponential(2) }; }
(async()=>{
  const TARGET=100, CAP=8*3600*1000;
  console.log(`time to ${TARGET} clouds (lower=faster), cap ${CAP/3600000}h\n`);
  let best=null;
  for(const b of [2,2.25,2.5,2.75,3,3.5,4]){ const r=await timeTo(b,TARGET,CAP);
    console.log(`boost ${String(b).padEnd(5)} -> ${r.reached? (r.sec+'s').padEnd(8):'DNF     '} | vaps=${r.vaps} | clouds=${r.clouds}`);
    if(r.reached && (!best||r.sec<best.sec)) best={b,sec:r.sec}; }
  console.log(`\nFASTEST: boost ${best.b} (${best.sec}s)`);
})().catch(e=>console.error("ERR",e.message));
