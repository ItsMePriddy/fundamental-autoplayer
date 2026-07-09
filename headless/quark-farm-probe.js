// Compare stage-reset cadence while farming Strange quarks from a real save.
// Uses real compiled game mechanics.  Unlike sweep.js, this stops on a quark
// target so it answers "how fast to 50k?" instead of long-run throughput.
//
// Usage:
//   node quark-farm-probe.js --save=/path/to/export.txt --target=50000

const fs = require('fs');
const E = require('./engine.js');
const { player, global, Stage, U } = E;
const SP = require('./build/Special');

const STEP = 250;
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const value = args.find((arg) => arg.startsWith(`--${name}=`));
    return value ? value.slice(name.length + 3) : fallback;
};
const SAVE = flag('save', null);
const TARGET = Number(flag('target', '50000'));
const MAX_SIM_MS = Number(flag('maxHours', '24')) * 3600000;
const DEFAULT_CADENCES = [2, 8, 15, 30, 45, 60, 90, 120, 180, 300];
const CADENCES = String(flag('cadences', DEFAULT_CADENCES.join(','))).split(',')
    .map(Number).filter(Number.isFinite).map((seconds) => seconds * 1000);

if (!SAVE) throw new Error('Pass --save=/path/to/export.txt');

function loadSave() {
    const encoded = fs.readFileSync(SAVE, 'utf8').trim();
    const json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const origAuto = E.Main.playerStart.toggles.auto;
    const origNormal = E.Main.playerStart.toggles.normal;
    E.Main.playerStart.toggles.auto = Array(json.toggles?.auto?.length || 12).fill(false);
    E.Main.playerStart.toggles.normal = Array(json.toggles?.normal?.length || 8).fill(false);
    E.P.updatePlayer(json, true);
    E.Main.playerStart.toggles.auto = origAuto;
    E.Main.playerStart.toggles.normal = origNormal;
    global.offline.active = false;
    player.toggles.auto = Array(12).fill(false); // Probe owns every reset.
    player.toggles.normal = Array(8).fill(true);
    for (let stage = 1; stage <= 6; stage++) player.toggles.buildings[stage] = Array(6).fill(true);
    player.toggles.confirm = player.toggles.confirm.map(() => 'None');
    U.stageUpdate(true, true);
}

const totalStars = () => player.collapse.stars.reduce((sum, value) => sum + value, 0);

async function run(cadenceMs) {
    loadSave();
    let sim = 0;
    let lastCollapse = -2000;
    let lastMerge = -2000;
    let lastStageReset = 0;
    let resets = 0;
    let collapses = 0;
    let merges = 0;
    let lastStars = totalStars();
    let gainedStars = 0;
    const startQuarks = player.strange[0].current;

    while (sim < MAX_SIM_MS && player.strange[0].current < TARGET) {
        global.offline.active = false;
        SP.checkProgress();
        const current = player.stage.current;
        for (const stage of global.stageInfo.activeAll) {
            Stage.setActiveStage(stage);
            E.buyBuildings(stage);
            E.buyUpgrades(stage);
            E.buyStrange(stage);

            if (stage === 1) await Stage.dischargeResetUser();
            if (stage === 2 && E.vaporBoost() >= 2.25) await Stage.vaporizationResetUser();
            if (stage === 3) await Stage.rankResetUser();
            if (stage === 4) {
                for (let element = 1; element <= 36; element++) Stage.buyUpgrades(element, 4, 'elements', false);
                Stage.assignResetInformation.newMass();
                Stage.assignResetInformation.newStars();
                const pending = global.collapseInfo.starCheck.reduce((sum, value) => sum + value, 0);
                const ratio = player.collapse.mass > 0 ? global.collapseInfo.newMass / player.collapse.mass : 0;
                const since = sim - lastCollapse;
                const elementReady = player.elements.some((value) => value === 0.5);
                if ((pending >= 50 && since >= 30000) ||
                    (elementReady && since >= 3000) ||
                    (since >= 2000 && ratio >= 1.3) ||
                    since >= 300000 ||
                    (since >= 120000 && ratio >= 1.3)) {
                    await Stage.collapseResetUser();
                    lastCollapse = sim;
                    collapses++;
                }
            }
            if (stage === 5 && sim - lastMerge >= 2000) {
                await Stage.mergeResetUser();
                lastMerge = sim;
                merges++;
            }
        }

        // Stage reset is available as soon as the game accepts it.  Cadence is
        // measured from prior reset, matching a userscript that deliberately
        // waits to build galaxies before cashing the quark reward.
        if (sim - lastStageReset >= cadenceMs) {
            Stage.setActiveStage(current);
            const before = player.strange[0].current;
            await Stage.stageResetUser();
            if (player.strange[0].current > before) {
                resets++;
                lastStageReset = sim;
            }
        }

        const stars = totalStars();
        if (stars > lastStars) gainedStars += stars - lastStars;
        lastStars = stars;
        U.stageUpdate();
        Stage.timeUpdate(STEP, STEP);
        sim += STEP;
    }
    return { cadenceMs, sim, resets, collapses, merges, gainedStars, startQuarks, quarks: player.strange[0].current, reached: player.strange[0].current >= TARGET };
}

function formatTime(ms) {
    if (ms >= 3600000) return `${(ms / 3600000).toFixed(2)}h`;
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 1000).toFixed(1)}s`;
}

(async () => {
    const results = [];
    for (const cadenceMs of CADENCES) results.push(await run(cadenceMs));
    results.sort((a, b) => a.sim - b.sim);
    console.log(`Target ${TARGET.toLocaleString('en-US')} unspent quarks from ${results[0].startQuarks.toFixed(2)}`);
    for (const result of results) {
        console.log(`${String(result.cadenceMs / 1000).padStart(3)}s reset wait | ${formatTime(result.sim).padStart(7)} | ${String(result.resets).padStart(4)} resets | ${result.quarks.toFixed(2).padStart(9)} quarks | collapses ${result.collapses} | merges ${result.merges}${result.reached ? '' : ' | target not reached'}`);
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
