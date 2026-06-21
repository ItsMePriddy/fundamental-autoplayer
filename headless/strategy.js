// Reusable play strategy for the headless engine. Develop-then-advance; autos OFF so
// only our gated stageResetUser advances stages.
const E = require("./engine.js");
const { player, global, Stage } = E;
const num = E.num;

const CFG = { vapBoost: 2.25, collapseEveryMs: 30000, mergeEveryMs: 30000, advanceMs: 5000 };

function developed(s) {
  if (s === 1) return true;                                   // stage-1 reset gated internally
  if (s === 2) return E.clouds() > 1e4;                       // progress milestone
  if (s === 3) return player.accretion.rank >= (global.accretionInfo.maxRank || 4);
  if (s === 4) return num(player.collapse?.stars?.[0]) >= 1;  // first star
  return true;                                                // s5+: advance when possible
}

function makeStepper() {
  let last = { collapse: 0, merge: 0, advance: 0 };
  return async function step(sim) {
    const cur = player.stage.current;
    for (const s of global.stageInfo.activeAll) {
      Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s);
      if (s === 1) await Stage.dischargeResetUser();
      else if (s === 2) { if (E.vaporBoost() >= CFG.vapBoost) await Stage.vaporizationResetUser(); }
      else if (s === 3) await Stage.rankResetUser();
      else if (s === 4) { for (let e=1;e<=36;e++) Stage.buyUpgrades(e,4,'elements',false); Stage.assignResetInformation.newStars(); const sc=global.collapseInfo.starCheck; if ((sc[0]+sc[1]+sc[2])>=1) await Stage.collapseResetUser(); }
      else if (s === 5) { if (sim - last.merge >= CFG.mergeEveryMs) { last.merge = sim; await Stage.mergeResetUser?.(); } }
    }
    if (sim - last.advance >= CFG.advanceMs && developed(cur)) {
      last.advance = sim; Stage.setActiveStage(cur); await Stage.stageResetUser();
    }
    E.U.stageUpdate(); Stage.timeUpdate(250, 250);
  };
}
module.exports = { CFG, developed, makeStepper };
