const E = require("./engine.js");
const { player, global } = E;
const { makeStepper } = require("./strategy.js");
const SP = require("./build/Special");
(async () => {
  E.newGame(); player.toggles.confirm = player.toggles.confirm.map(() => "None");
  const step = makeStepper();
  let sim = 0; const reached = {}; let lastCur = 1, stallSince = 0, stallReported = -1;
  const wall0 = Date.now(); const CAP = 480 * 3600 * 1000;
  const snap = () => `clouds=${E.clouds().toExponential(1)} mass=${E.num(player.collapse?.mass||0).toExponential(1)} rank=${player.accretion?.rank} stars=${player.collapse?.stars?.[0]||0} merges=${player.merge?.resets||0} strange=${player.strange[0].total}`;
  while (sim < CAP) {
    await step(sim); global.offline.active=false; SP.checkProgress(); sim += 250;
    if (!global.__p && sim>=3*3600*1000){ global.__p=1; console.log("PROBE@3h cur="+player.stage.current+" active="+JSON.stringify(global.stageInfo.activeAll)+" boost="+E.vaporBoost().toFixed(3)+" b2="+player.buildings[2].map(b=>E.num(b.current).toExponential(1)).join(",")); }
    const c = player.stage.current;
    if (!reached[c]) { reached[c] = sim; console.log(`stage ${c} @ ${(sim/3600000).toFixed(2)}h prog=${player.progress.main} active=${JSON.stringify(global.stageInfo.activeAll)} | ${snap()}`); }
    if (c !== lastCur) { lastCur = c; stallSince = sim; }
    else if (sim - stallSince >= 24*3600*1000 && stallReported !== c) { stallReported = c; console.log(`STALL at stage ${c} (24h no advance) prog=${player.progress.main} | ${snap()} | developed=${require("./strategy.js").developed(c)}`); }
    if (Date.now() - wall0 > 100000) { console.log(`WALLGUARD @ ${(sim/3600000).toFixed(1)}h`); break; }
  }
  console.log(`FINAL stage=${player.stage.current} prog=${player.progress.main} simH=${(sim/3600000).toFixed(0)} | ${snap()}`);
})().catch(e => console.error("ERR", e.message));
