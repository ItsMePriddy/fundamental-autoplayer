// Reusable headless Fundamental engine: fresh game + driver helpers.
require("./_globals");
const Main = require("./build/Main");
const P = require("./build/Player"); const { player, global, effectsCache } = P;
const Stage = require("./build/Stage");
const U = require("./build/Update");
const num = (x) => Number((x && x.toString) ? x.toString() : x);

function newGame() {
    P.prepareVacuum(false);
    P.updatePlayer(Main.deepClone(Main.playerStart), false);
    global.paused = false;
    player.toggles.confirm = player.toggles.confirm.map(() => "None");
    U.stageUpdate(); Stage.setActiveStage(1); U.stageUpdate();
}

const maxA = (s) => global.buildingsInfo.maxActive[s];
function buyBuildings(s){ for (let i = maxA(s) - 1; i >= 1; i--) Stage.buyBuilding(i, s, 0, false); }
function buyUpgrades(s){
    const types = [['upgrades', global.upgradesInfo], ['researches', global.researchesInfo],
                   ['researchesExtra', global.researchesExtraInfo]];
    for (const [ty, info] of types){ const m = info[s].maxActive || 0; for (let i=0;i<m;i++) Stage.buyUpgrades(i, s, ty, false); }
    for (let i=0;i<3;i++) Stage.buyUpgrades(i, s, 'researchesAuto', false);
    for (let i=0;i<(global.ASRInfo.max?.[s]||1);i++) Stage.buyUpgrades(i, s, 'ASR', false);
}
function buyStrange(s){ const m = global.strangenessInfo[s]?.maxActive || 0; for (let i=0;i<m;i++) Stage.buyStrangenessMax(i, s, 'strangeness'); }

// vaporization boost metric (mirrors Update.ts:245)
function vaporBoost(){
    Stage.assignResetInformation.newClouds(); // sets global.vaporizationInfo.get
    const ce = Stage.calculateEffects;
    const rainNow = ce.S2Extra1(player.researchesExtra[2][1]);
    const rainAfter = ce.S2Extra1(player.researchesExtra[2][1], true);
    return (ce.clouds(true) / ce.clouds()) * (rainAfter / rainNow) * (ce.S2Extra2(rainAfter) / ce.S2Extra2(rainNow));
}
const clouds = () => num(player.vaporization.clouds);

// merge boost metric — the exact same expression Update.ts uses to fill
// #mergeBoostTotal (only calls into real reward()/reward1() functions, so it
// can't drift from the game's own math). Only meaningful in vacuum with
// strangeness[5][9]<2 (auto-merge); returns null otherwise, matching the DOM
// (the game hides #mergeBoostTotal in both of those cases).
function mergeBoost(){
    const b5 = player.buildings[5];
    if (!b5 || !b5[3] || player.strangeness[5][9] >= 2 || !player.inflation.vacuum) return null;
    const ce = Stage.calculateEffects;
    const before = ce.reward[0]();
    const after = ce.reward[0](true);
    return (b5[3].true / (global.mergeInfo.galaxies + 1) + 1) * (after / before) * (ce.reward[0](true, ce.reward[1](true)) / after);
}

module.exports = { Main, P, player, global, effectsCache, Stage, U, num, newGame,
    buyBuildings, buyUpgrades, buyStrange, vaporBoost, mergeBoost, clouds, maxA };
