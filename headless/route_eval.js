// Seeded route evaluator for Fundamental autoplay policies.
// Usage:
//   node headless/route_eval.js "/path/to/Fundamental save.txt" --hours=72 --target=stage5

const fs = require("fs");
const E = require("./engine.js");
const Check = require("./build/Check");
const SP = require("./build/Special");

const { P, player, global, Stage, U, num } = E;

const savePath = process.argv[2] || "/Users/spencer/Downloads/Fundamental, 25.06.2026 14-15-26, Submerged.txt";
const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const CAP_HOURS = Number(arg("hours", "72"));
const TARGET = arg("target", "stage5");
const DT = Number(arg("dt", "1000"));
const LOG_EVERY_HOURS = Number(arg("log", "12"));

function loadSave() {
  const raw = fs.readFileSync(savePath, "utf8").trim();
  const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  P.updatePlayer(obj, true);
  global.paused = false;
  global.offline.active = false;
  player.toggles.confirm = player.toggles.confirm.map(() => "None");
  player.toggles.normal[0] = true;
  player.toggles.normal[2] = false;
  for (let i = 0; i < player.toggles.auto.length; i++) player.toggles.auto[i] = true;
  U.stageUpdate();
  SP.checkProgress();
}

function refresh() {
  U.stageUpdate();
  global.offline.active = false;
  SP.checkProgress();
}

function buyAllLocal(stage) {
  Stage.setActiveStage(stage);
  E.buyBuildings(stage);
  E.buyUpgrades(stage);
}

function buyStrangeOne(stage, index) {
  if (!global.strangenessInfo[stage] || !Check.checkUpgrade(index, stage, "strangeness")) return false;
  const before = player.strangeness[stage][index];
  Stage.buyStrangenessMax(index, stage, "strangeness");
  return player.strangeness[stage][index] > before;
}

function buyStrangenessDefault() {
  for (let s = 1; s <= 6; s++) E.buyStrange(s);
}

function buyStrangenessTargetFirst() {
  // Mirrors the userscript intent: hold the shared quark pool for high-ROI stage 4 automation.
  buyStrangeOne(5, 2); // later global quark multiplier, once unlocked
  if (player.strangeness[4][6] < global.strangenessInfo[4].max[6]) {
    buyStrangeOne(4, 6); // Elements no longer require Collapse
    return;
  }
  buyStrangeOne(5, 3); // Intergalactic collapse-immunity, once unlocked
  const cur = player.stage.current;
  for (let i = 0; i < 12; i++) buyStrangeOne(cur, i);
  for (let s = 6; s >= 1; s--) {
    if (s === cur) continue;
    for (let i = 0; i < 12; i++) buyStrangeOne(s, i);
  }
}

function buyStrangenessStage4AutomationFirst() {
  // A comparison route: buy cheap Interstellar auto-structures first, then element activation.
  buyStrangeOne(4, 5);
  if (player.strangeness[4][6] < global.strangenessInfo[4].max[6]) {
    buyStrangeOne(4, 6);
    return;
  }
  buyStrangenessTargetFirst();
}

function vaporBoost() {
  return E.vaporBoost();
}

function collapseBoost() {
  Stage.assignResetInformation.newMass();
  Stage.assignResetInformation.newStars();
  const ce = Stage.calculateEffects;
  const starProd = global.buildingsInfo.producing[4];
  const massBoost = (ce.mass(true) / ce.mass()) *
    (ce.S4Research4(true) / ce.S4Research4()) *
    ((1 + (ce.S5Upgrade2(true) - ce.S5Upgrade2()) / E.effectsCache.galaxyBase) ** (player.buildings[5][3].true * 2));
  const restProd = Number(starProd[1]) + Number(starProd[3]) + Number(starProd[4]) + Number(starProd[5]);
  const remnantBoost = restProd > 0
    ? (Number(starProd[2]) * (ce.star[0](true) / E.effectsCache.star[0]) + restProd) / (restProd + Number(starProd[2]))
    : 1;
  return massBoost * remnantBoost * (ce.star[1](true) / E.effectsCache.star[1]) * (ce.star[2](true) / E.effectsCache.star[2]);
}

const policies = {
  default: {
    label: "default cost-order strangeness + eager collapse",
    strangeness: buyStrangenessDefault,
    collapseMode: "eager",
  },
  target: {
    label: "target strange7Stage4 + userscript collapse",
    strangeness: buyStrangenessTargetFirst,
    collapseMode: "timed",
  },
  autoFirst: {
    label: "stage4 auto-structures before element target",
    strangeness: buyStrangenessStage4AutomationFirst,
    collapseMode: "timed",
  },
};

function targetReached() {
  if (TARGET === "stage5") return player.stage.current >= 5 || player.elements[26] >= 1;
  if (TARGET === "universe") return player.verses[0].total >= 1 || player.progress.main >= 19;
  if (TARGET === "quarks") return player.strange[0].total > 50;
  return player.stage.current >= 5;
}

function developedForStageReset(stage) {
  if (stage === 1) return true;
  if (stage === 2) return E.clouds() > 1e4;
  if (stage === 3) return player.accretion.rank >= (global.accretionInfo.maxRank || 4);
  if (stage === 4) return player.stage.current >= 5 || player.elements[26] >= 1;
  return true;
}

async function runPolicy(name, policy) {
  loadSave();
  let sim = 0;
  let lastAdvance = 0;
  let lastCollapse = 0;
  let lastMerge = 0;
  let lastLog = -Infinity;
  const start = snapshot();
  const wall = Date.now();

  while (sim < CAP_HOURS * 3600e3 && Date.now() - wall < 120000) {
    for (const stage of [...global.stageInfo.activeAll]) {
      buyAllLocal(stage);
      policy.strangeness();

      if (stage === 1) {
        await Stage.dischargeResetUser();
      } else if (stage === 2) {
        if (vaporBoost() >= 2.25) await Stage.vaporizationResetUser();
      } else if (stage === 3) {
        await Stage.rankResetUser();
      } else if (stage === 4) {
        for (let e = 1; e <= 36; e++) Stage.buyUpgrades(e, 4, "elements", false);
        if (policy.collapseMode === "eager") {
          await Stage.collapseResetUser();
        } else {
          const pendingElement = player.elements.some((v, i) => i > 0 && v === 0.5);
          const boost = collapseBoost();
          const elapsed = sim - lastCollapse;
          if ((pendingElement && elapsed >= 3000) ||
              boost >= 2.5 ||
              (elapsed >= 90000 && boost >= 1.3)) {
            const before = player.collapse.mass;
            await Stage.collapseResetUser();
            if (player.collapse.mass !== before || !pendingElement) lastCollapse = sim;
          }
        }
      } else if (stage === 5) {
        if (sim - lastMerge >= 120000) {
          lastMerge = sim;
          await Stage.mergeResetUser?.();
        }
        Stage.buyVerse(true);
      }
    }

    if (sim - lastAdvance >= 5000 && developedForStageReset(player.stage.current)) {
      lastAdvance = sim;
      Stage.setActiveStage(player.stage.current);
      await Stage.stageResetUser();
    }

    Stage.buyVerse(true);
    Stage.timeUpdate(DT, DT);
    sim += DT;
    refresh();

    if (LOG_EVERY_HOURS > 0 && (sim - lastLog >= LOG_EVERY_HOURS * 3600e3 || targetReached())) {
      lastLog = sim;
      const s = snapshot();
      console.log(`${name} t=${(sim / 3600000).toFixed(2)}h stage=${s.stage}/${s.active} prog=${s.progress} resets=${s.resets} q=${s.q} s4=${s.s4} s5=${s.s5} el=${s.element} mass=${s.mass} verse=${s.verses}`);
    }
    if (targetReached()) break;
  }

  const end = snapshot();
  return {
    policy: name,
    label: policy.label,
    target: TARGET,
    hit: targetReached(),
    simHours: +(sim / 3600000).toFixed(3),
    start,
    end,
  };
}

function snapshot() {
  return {
    stage: player.stage.current,
    active: player.stage.active,
    progress: player.progress.main,
    resets: player.stage.resets,
    q: +player.strange[0].current.toFixed(3),
    totalQ: +player.strange[0].total.toFixed(3),
    s4: JSON.stringify(player.strangeness[4]),
    s5: JSON.stringify(player.strangeness[5]),
    element: player.collapse.highest,
    mass: num(player.collapse.mass).toExponential(2),
    stars: JSON.stringify(player.collapse.stars),
    verses: player.verses[0].total,
  };
}

(async () => {
  const names = Object.keys(policies);
  const results = [];
  console.log(`save=${savePath}`);
  console.log(`target=${TARGET} cap=${CAP_HOURS}h dt=${DT}ms logEvery=${LOG_EVERY_HOURS}h`);
  for (const name of names) results.push(await runPolicy(name, policies[name]));
  console.log("\nSUMMARY");
  for (const r of results) {
    console.log(`${r.policy.padEnd(10)} hit=${String(r.hit).padEnd(5)} sim=${String(r.simHours).padStart(8)}h stage=${r.end.stage} prog=${r.end.progress} resets=${r.end.resets} q=${r.end.q}/${r.end.totalQ} el=${r.end.element} s4=${r.end.s4}`);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
