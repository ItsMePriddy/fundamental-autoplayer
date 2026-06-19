const E = require("./engine.js");
const { player, global, Stage, U } = E;
const STEP = 250;

async function toSubmerged() {
    E.newGame(); let sim = 0, lastSR = 0;
    while (player.stage.current < 2 && sim < 3*3600*1000) {
        for (const s of global.stageInfo.activeAll) { Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s); if (s===1) await Stage.dischargeResetUser(); }
        if (sim - lastSR >= 2000) { lastSR = sim; await Stage.stageResetUser(); }
        U.stageUpdate(); Stage.timeUpdate(STEP, STEP); sim += STEP;
    }
    return sim;
}
// Fixed-duration Submerged run; returns clouds accumulated (higher=faster progress).
async function measure(policy, durMs) {
    await toSubmerged();
    let sim = 0, vaps = 0, vapLast = 0, peak = 0, sumElapsed = 0;
    while (sim < durMs) {
        for (const s of global.stageInfo.activeAll) { Stage.setActiveStage(s); E.buyBuildings(s); E.buyUpgrades(s); E.buyStrange(s); if (s===1) await Stage.dischargeResetUser(); }
        Stage.setActiveStage(2);
        const boost = E.vaporBoost();
        let fire = false;
        if (policy.mode === 'fixed') fire = boost >= policy.boost;
        else { const el = (sim - vapLast)/1000; if (boost >= 1.05 && el >= 0.5) { const sc = Math.log(boost)/el; if (sc > peak) peak = sc; else if (sc <= peak*(1-(policy.drop||0.05))) fire = true; } }
        if (fire) { await Stage.vaporizationResetUser(); vaps++; sumElapsed += (sim-vapLast)/1000; vapLast = sim; peak = 0; }
        U.stageUpdate(); Stage.timeUpdate(STEP, STEP); sim += STEP;
    }
    return { clouds: E.clouds(), vaps, avgCycle: vaps? +(sumElapsed/vaps).toFixed(1):0 };
}
(async () => {
    const DUR = 2*3600*1000; // 2h submerged
    const policies = [
        {name:'fixed 1.5',mode:'fixed',boost:1.5},{name:'fixed 2',mode:'fixed',boost:2},
        {name:'fixed 3',mode:'fixed',boost:3},{name:'fixed 5',mode:'fixed',boost:5},
        {name:'fixed 10',mode:'fixed',boost:10},{name:'fixed 30',mode:'fixed',boost:30},
        {name:'adaptive .05',mode:'adaptive',drop:0.05},{name:'adaptive .02',mode:'adaptive',drop:0.02},
    ];
    console.log(`Submerged ${DUR/3600000}h fixed-duration | metric: clouds accumulated (higher=faster)\n`);
    let best=null;
    for (const p of policies) {
        const r = await measure(p, DUR);
        const line = `${p.name.padEnd(14)} -> clouds=${r.clouds.toExponential(3)} | vaporizations=${r.vaps} | avgCycle=${r.avgCycle}s`;
        console.log(line);
        if (!best || r.clouds > best.c) best = { n:p.name, c:r.clouds };
    }
    console.log(`\nBEST: ${best.n} (${best.c.toExponential(3)} clouds)`);
})().catch(e => console.error("ERR", e.message, e.stack.split("\n").slice(0,3).join("\n")));
