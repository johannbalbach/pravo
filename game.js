(() => {
  "use strict";

  /** @typedef {'select'|'ballistics'|'firing'|'impact'|'result'|'victory'} GamePhase */

  /**
   * @typedef {Object} TargetModel
   * @property {number} id
   * @property {string} type
   * @property {string} name
   * @property {string} brief
   * @property {number} baseDist
   * @property {number} x
   * @property {boolean} moving
   * @property {number} speed
   * @property {number} hp
   * @property {boolean} isDestroyed
   * @property {string} visualPreset
   * @property {number} idlePhase
   */

  /**
   * @typedef {Object} ProjectileState
   * @property {boolean} active
   * @property {number} mx
   * @property {number} my
   * @property {number} vx
   * @property {number} vy
   * @property {number} age
   * @property {number} targetId
   * @property {number} distAtFire
   * @property {number} aimX
   * @property {{mx:number,my:number}[]} trail
   */

  /**
   * @typedef {Object} EffectState
   * @property {number} mx
   * @property {number} age
   * @property {number} life
   * @property {number} power
   * @property {boolean} hit
   */

  /**
   * @typedef {Object} GameState
   * @property {GamePhase} phase
   * @property {number} ammo
   * @property {number} score
   * @property {number|null} selectedTargetId
   * @property {boolean} firing
   * @property {number} cameraScale
   * @property {number} cameraShake
   * @property {number} cameraFocusDist
   * @property {number} targetFocusDist
   * @property {number} elapsed
   * @property {number} ballisticsTicker
   * @property {number} impactX
   * @property {string} statusText
   * @property {'ok'|'warn'|'bad'} statusTone
   * @property {TargetModel[]} targets
   * @property {ProjectileState|null} projectile
   * @property {EffectState[]} effects
   */

  const G = 9.81;
  const MUZZLE_VELOCITY = 930 * 0.995;
  const WIND = 2;
  const WIND_ACCEL = -WIND * 0.015;
  const MAX_LOG_ITEMS = 84;
  const FUEL_SEGS = 24;

  const PHASE_LABELS = {
    select: "ВЫБОР ЦЕЛИ",
    ballistics: "РАСЧЁТ",
    firing: "ВЫСТРЕЛ",
    impact: "ПОРАЖЕНИЕ",
    result: "РЕЗУЛЬТАТ",
    victory: "МИССИЯ ЗАВЕРШЕНА",
  };

  const VEHICLE_PRESETS = {
    apc: { body: 48, height: 15, turretW: 16, turretH: 8, barrel: 16, wheelCount: 5 },
    hq: { body: 52, height: 16, turretW: 20, turretH: 10, barrel: 10, wheelCount: 4 },
    sam: { body: 50, height: 16, turretW: 18, turretH: 10, barrel: 20, wheelCount: 5 },
  };

  const TARGET_DEFS = [
    {
      id: 0,
      type: "apc",
      name: "ЦЕЛЬ A — БРОНЕКОЛОННА",
      brief: "Подвижная · 20 км · 20 км/ч",
      dist: 20000,
      moving: true,
      speed: 20000 / 3600,
      visualPreset: "apc",
    },
    {
      id: 1,
      type: "hq",
      name: "ЦЕЛЬ B — КОМАНДНЫЙ ПУНКТ",
      brief: "Неподвижная · 50 км",
      dist: 50000,
      moving: false,
      speed: 0,
      visualPreset: "hq",
    },
    {
      id: 2,
      type: "sam",
      name: "ЦЕЛЬ C — ЗРК ПУСКОВАЯ",
      brief: "Неподвижная · 30 км",
      dist: 30000,
      moving: false,
      speed: 0,
      visualPreset: "sam",
    },
  ];

  const els = {
    canvas: document.getElementById("scene"),
    sceneShell: document.getElementById("scene-shell"),
    phaseBadge: document.getElementById("phase-badge"),
    ammo: document.getElementById("ammo"),
    status: document.getElementById("status"),
    score: document.getElementById("score"),
    ballistics: document.getElementById("ballistics"),
    targetsList: document.getElementById("targets-list"),
    fireBtn: document.getElementById("fire-btn"),
    restartBtn: document.getElementById("restart-btn"),
    victory: document.getElementById("victory"),
    victoryScore: document.getElementById("victory-score"),
    log: document.getElementById("event-log"),
    overlayTarget: document.getElementById("overlay-target"),
    overlayDistance: document.getElementById("overlay-distance"),
    overlayTime: document.getElementById("overlay-time"),
    impactFlash: document.getElementById("impact-flash"),
    hud: document.getElementById("hud"),
    hudToggle: document.getElementById("hud-toggle"),
    hudBackdrop: document.getElementById("hud-backdrop"),
    fuelSegments: document.getElementById("fuel-segments"),
    fuelPct: document.getElementById("fuel-pct"),
    fuelTof: document.getElementById("fuel-tof"),
  };

  const ctx = els.canvas.getContext("2d");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobileMedia = window.matchMedia("(max-width: 960px)");

  const state = {
    phase: "select",
    ammo: 6,
    score: 0,
    selectedTargetId: null,
    firing: false,
    cameraScale: 1,
    cameraShake: 0,
    cameraFocusDist: 24000,
    targetFocusDist: 24000,
    elapsed: 0,
    ballisticsTicker: 0,
    impactX: 20000,
    statusText: "ГОТОВО",
    statusTone: "ok",
    targets: [],
    projectile: null,
    effects: [],
    fuelPct: 0,
    fuelTof: 0,
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let rafId = 0;
  let prevTs = 0;
  let isMobileSheetOpen = false;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function formatClock(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(safe / 60)).padStart(2, "0");
    const ss = String(safe % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function initFuelBar() {
    els.fuelSegments.innerHTML = "";
    for (let i = 0; i < FUEL_SEGS; i++) {
      const seg = document.createElement("div");
      seg.className = "fuel-seg";
      els.fuelSegments.appendChild(seg);
    }
    updateFuelBar(0, 0);
  }

  function updateFuelBar(pct, remainingSec) {
    state.fuelPct = Math.max(0, Math.min(1, pct));
    const lit = Math.round(state.fuelPct * FUEL_SEGS);
    const segs = els.fuelSegments.querySelectorAll(".fuel-seg");
    segs.forEach((seg, i) => {
      const on = i < lit;
      let cls = "fuel-seg";
      if (on) {
        if (i < FUEL_SEGS * 0.25) cls += " lit crit";
        else if (i < FUEL_SEGS * 0.55) cls += " lit low";
        else cls += " lit";
      }
      seg.className = cls;
    });

    if (pct <= 0) {
      els.fuelPct.textContent = "—";
      els.fuelPct.className = "fuel-pct";
      els.fuelTof.textContent = "TOF —";
    } else {
      const pctRound = Math.round(pct * 100);
      els.fuelPct.textContent = `${pctRound}%`;
      els.fuelPct.className =
        pctRound <= 25
          ? "fuel-pct crit"
          : pctRound <= 55
            ? "fuel-pct low"
            : "fuel-pct";
      els.fuelTof.textContent =
        remainingSec > 0 ? `TOF ${remainingSec.toFixed(1)}с` : "TOF —";
    }
  }

  function gaussian(mean, stdDev) {
    const u1 = Math.max(1e-7, Math.random());
    const u2 = Math.random();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    const z0 = mag * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdDev + mean;
  }

  function getTarget(id) {
    return state.targets.find((target) => target.id === id) || null;
  }

  function getAliveTargets() {
    return state.targets.filter((target) => !target.isDestroyed);
  }

  function launchAngle(dist) {
    const s = (dist * G) / (MUZZLE_VELOCITY * MUZZLE_VELOCITY);
    if (s >= 1) {
      return Math.PI / 4;
    }
    return Math.asin(s) * 0.5;
  }

  function timeOfFlight(dist) {
    const angle = launchAngle(dist);
    return dist / (MUZZLE_VELOCITY * Math.cos(angle));
  }

  function maxHeight(dist) {
    const angle = launchAngle(dist);
    const vy = MUZZLE_VELOCITY * Math.sin(angle);
    return (vy * vy) / (2 * G);
  }

  function windDrift(dist) {
    return WIND * timeOfFlight(dist);
  }

  function currentFocusTarget() {
    if (state.phase === "impact") {
      return state.impactX;
    }

    if (state.projectile && state.projectile.active) {
      const cinematicLead = clamp(state.projectile.vx * 1.7, 4200, 9000);
      return state.projectile.mx + cinematicLead;
    }

    const selected = getTarget(state.selectedTargetId);
    if (selected && !selected.isDestroyed) {
      return selected.x;
    }

    const nextAlive = getAliveTargets()[0];
    return nextAlive ? nextAlive.x : 26000;
  }

  function transitionTo(phase) {
    if (state.phase === phase) {
      return;
    }
    state.phase = phase;
    els.phaseBadge.textContent = PHASE_LABELS[phase];

    if (window.gsap && !prefersReducedMotion) {
      gsap.fromTo(
        els.phaseBadge,
        { y: -4, opacity: 0.4, scale: 0.985 },
        { y: 0, opacity: 1, scale: 1, duration: 0.24, ease: "power2.out" },
      );
    }

    syncFireButton();
  }

  function setStatus(text, tone) {
    state.statusText = text;
    state.statusTone = tone;
    els.status.textContent = text;
    els.status.className = "";
    els.status.classList.add(`tone-${tone}`);
  }

  function log(message, tone = "info") {
    const item = document.createElement("p");
    item.className = `log-item ${tone}`;
    const now = new Date();
    item.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")} ${message}`;
    els.log.appendChild(item);
    while (els.log.childElementCount > MAX_LOG_ITEMS) {
      els.log.removeChild(els.log.firstElementChild);
    }
    els.log.scrollTop = els.log.scrollHeight;
  }

  function syncHUD() {
    els.ammo.textContent = String(state.ammo);
    els.score.textContent = String(state.score);
    els.phaseBadge.textContent = PHASE_LABELS[state.phase];
    if (els.overlayTime) {
      els.overlayTime.textContent = formatClock(state.elapsed);
    }

    const selected = getTarget(state.selectedTargetId);
    if (selected) {
      els.overlayTarget.textContent = selected.name.replace(" — ", " · ");
      els.overlayDistance.textContent = `${(selected.x / 1000).toFixed(1)} км`;
    } else {
      els.overlayTarget.textContent = "Ожидание выбора";
      els.overlayDistance.textContent = "-- км";
    }
  }

  function buildBallistics(target) {
    if (!target || state.phase === "victory") {
      els.ballistics.innerHTML = `<p class="placeholder">Выберите цель для расчёта траектории.</p>`;
      return;
    }

    const dist = target.x;
    const tof = timeOfFlight(dist);
    const angleDeg = (launchAngle(dist) * 180) / Math.PI;
    const lead = target.moving ? target.speed * tof : 0;

    const rows = [
      ["Дист.", `${(dist / 1000).toFixed(1)} км`],
      ["Угол", `${angleDeg.toFixed(1)}°`],
      ["TOF", `${tof.toFixed(1)} с`],
      ["Макс. H", `${(maxHeight(dist) / 1000).toFixed(1)} км`],
      ["Снос ветра", `${windDrift(dist).toFixed(0)} м ←`],
    ];

    if (lead > 0) {
      rows.push(["Упреждение", `${lead.toFixed(0)} м`]);
    }

    els.ballistics.innerHTML = rows
      .map(
        ([key, value]) =>
          `<div class="b-row"><span>${key}</span><strong>${value}</strong></div>`,
      )
      .join("");
  }

  function syncFireButton() {
    const target = getTarget(state.selectedTargetId);
    const canFire =
      state.phase === "ballistics" &&
      !state.firing &&
      state.ammo > 0 &&
      target &&
      !target.isDestroyed;

    els.fireBtn.disabled = !canFire;
  }

  function renderTargetsList() {
    els.targetsList.innerHTML = "";

    state.targets.forEach((target) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "target-row";

      if (target.isDestroyed) {
        btn.classList.add("done");
      }

      if (target.id === state.selectedTargetId) {
        btn.classList.add("sel");
      }

      btn.innerHTML = `<span class="t-name">${target.name}</span><span class="t-info">${target.brief}</span>`;
      btn.disabled = target.isDestroyed;

      btn.addEventListener("click", () => {
        selectTarget(target.id, btn);
      });

      els.targetsList.appendChild(btn);
    });
  }

  function selectTarget(id, rowEl) {
    if (state.phase === "firing" || state.phase === "impact" || state.phase === "victory") {
      return;
    }

    const target = getTarget(id);
    if (!target || target.isDestroyed) {
      return;
    }

    state.selectedTargetId = id;
    state.targetFocusDist = target.x;
    transitionTo("ballistics");
    setStatus("НАВЕДЕНИЕ", "ok");

    buildBallistics(target);
    renderTargetsList();
    syncHUD();
    syncFireButton();

    if (window.gsap && rowEl && !prefersReducedMotion) {
      gsap.fromTo(
        rowEl,
        { x: -6, opacity: 0.45 },
        { x: 0, opacity: 1, duration: 0.2, ease: "power2.out" },
      );
    }

    log(`[РАСЧЁТ] ${target.name.split("—")[0].trim()} выбрана.`, "info");
  }

  function getHitProfile(target, distAtFire) {
    const movingPenalty = target.moving ? 0.18 : 0;
    const distPenalty = clamp((distAtFire - 22000) / 60000, 0, 0.16);
    const baseChance = target.moving ? 0.74 : 0.88;
    const chance = clamp(baseChance - movingPenalty * 0.4 - distPenalty, 0.45, 0.92);
    const cep = target.moving ? 90 : 48;
    const threshold = target.moving ? 95 : 68;

    return { chance, cep, threshold };
  }

  function fireAt(targetId) {
    if (state.phase !== "ballistics" || state.firing || state.ammo <= 0) {
      return;
    }

    const target = getTarget(targetId);
    if (!target || target.isDestroyed) {
      return;
    }

    state.firing = true;
    state.ammo -= 1;

    const dist = target.x;
    const tof = timeOfFlight(dist);
    const angle = launchAngle(dist);
    const lead = target.moving ? target.speed * tof : 0;
    const aimX = target.moving ? Math.max(3200, dist - lead) : dist;

    state.projectile = {
      active: true,
      mx: 0,
      my: 0,
      vx: MUZZLE_VELOCITY * Math.cos(angle),
      vy: MUZZLE_VELOCITY * Math.sin(angle),
      age: 0,
      targetId,
      distAtFire: dist,
      aimX,
      trail: [],
    };

    transitionTo("firing");
    setStatus("ВЫСТРЕЛ", "warn");
    syncHUD();
    syncFireButton();

    updateFuelBar(1, timeOfFlight(dist));

    log(
      `[ОГОНЬ] Выстрел по ${target.name.split("—")[0].trim()}. Упреждение ${lead.toFixed(0)} м.`,
      "warn",
    );

    if (mobileMedia.matches) {
      setSheetOpen(false);
    }
  }

  function finishShot(result) {
    state.firing = false;
    state.projectile = null;
    updateFuelBar(0, 0);

    if (result.isHit) {
      result.target.isDestroyed = true;
      result.target.hp = 0;
      const points = result.target.moving ? 300 : 200;
      state.score += points;
      setStatus("ПОПАДАНИЕ", "ok");
      log(`[ПОПАДАНИЕ] ${result.target.name.split("—")[0].trim()} уничтожена. +${points} очков`, "hit");
    } else {
      setStatus("ПРОМАХ", "bad");
      log(`[ПРОМАХ] Отклонение ${result.missDistance.toFixed(0)} м.`, "miss");
      if (!result.target.isDestroyed) {
        result.target.x = result.target.baseDist;
      }
    }

    state.selectedTargetId = null;
    transitionTo("result");
    buildBallistics(null);
    renderTargetsList();
    syncHUD();
    syncFireButton();

    const alive = getAliveTargets();
    if (alive.length === 0) {
      window.setTimeout(() => {
        transitionTo("victory");
        setStatus("ЗАДАЧА ВЫПОЛНЕНА", "ok");
        showVictory();
      }, prefersReducedMotion ? 80 : 460);
      return;
    }

    if (state.ammo <= 0) {
      log("[ВНИМАНИЕ] Боекомплект исчерпан. Перезапустите миссию.", "warn");
      setStatus("БК ИСЧЕРПАН", "warn");
      return;
    }

    window.setTimeout(() => {
      if (state.phase === "result") {
        transitionTo("select");
        setStatus("ГОТОВО", "ok");
        syncHUD();
      }
    }, prefersReducedMotion ? 80 : 520);
  }

  function animateImpact(result) {
    const runDone = () => {
      finishShot(result);
    };

    if (prefersReducedMotion || !window.gsap) {
      state.cameraScale = 1.22;
      state.cameraShake = 5;
      state.cameraScale = 1;
      runDone();
      return;
    }

    gsap.killTweensOf(state);
    gsap.killTweensOf(els.impactFlash);

    const tl = gsap.timeline({ onComplete: runDone });

    tl.to(
      state,
      {
        cameraScale: result.isHit ? 1.42 : 1.28,
        duration: 0.22,
        ease: "power2.out",
      },
      0,
    )
      .to(
        state,
        {
          cameraScale: 1,
          duration: 0.62,
          ease: "expo.out",
        },
        0.08,
      )
      .fromTo(
        els.impactFlash,
        { opacity: 0 },
        {
          opacity: result.isHit ? 0.48 : 0.34,
          duration: 0.1,
          yoyo: true,
          repeat: 1,
          ease: "sine.out",
        },
        0,
      )
      .to(
        state,
        {
          cameraShake: result.isHit ? 8 : 5,
          duration: 0.08,
          yoyo: true,
          repeat: 3,
          ease: "sine.inOut",
        },
        0,
      );
  }

  function resolveImpact(projectile) {
    const target = getTarget(projectile.targetId);
    if (!target) {
      return;
    }

    state.impactX = projectile.mx;
    transitionTo("impact");

    const profile = getHitProfile(target, projectile.distAtFire);
    const dynamicError = projectile.mx - target.x;
    const scatter = gaussian(0, profile.cep * 0.72);
    const missDistance = Math.abs(dynamicError + scatter);
    const chanceRoll = Math.random();
    const isHit = missDistance <= profile.threshold && chanceRoll <= profile.chance;

    state.effects.push({
      mx: projectile.mx,
      age: 0,
      life: resultEffectLifetime(isHit),
      power: isHit ? 1 : 0.7,
      hit: isHit,
    });

    const result = { isHit, target, missDistance };
    animateImpact(result);
  }

  function resultEffectLifetime(isHit) {
    return isHit ? 1.2 : 0.9;
  }

  function updateMovingTargets(dt) {
    state.targets.forEach((target) => {
      if (!target.moving || target.isDestroyed) {
        return;
      }

      if (state.firing) {
        target.x = Math.max(3400, target.x - target.speed * dt);
      } else {
        const idleOscillation = Math.sin(state.elapsed * 0.35 + target.idlePhase) * 180;
        target.x = target.baseDist + idleOscillation;
      }
    });
  }

  function updateProjectile(dt) {
    const projectile = state.projectile;
    if (!projectile || !projectile.active) {
      return;
    }

    const prevMx = projectile.mx;
    const prevMy = projectile.my;

    projectile.age += dt;
    projectile.vy -= G * dt;
    projectile.vx += WIND_ACCEL * dt;

    projectile.mx += projectile.vx * dt;
    projectile.my += projectile.vy * dt;

    if (projectile.my < 0) {
      projectile.my = 0;
    }

    const dx = projectile.mx - prevMx;
    const dy = projectile.my - prevMy;
    const segmentLength = Math.hypot(dx, dy);
    const subSteps = Math.max(1, Math.min(4, Math.ceil(segmentLength / 170)));

    for (let i = 1; i <= subSteps; i += 1) {
      const t = i / subSteps;
      projectile.trail.push({
        mx: prevMx + dx * t,
        my: prevMy + dy * t,
      });
    }

    if (projectile.trail.length > 84) {
      projectile.trail.shift();
    }

    if (projectile.my <= 0 && projectile.age > 0.2) {
      projectile.active = false;
      updateFuelBar(0, 0);
      resolveImpact(projectile);
    }
  }

  function updateEffects(dt) {
    state.effects = state.effects.filter((effect) => effect.age <= effect.life);
    state.effects.forEach((effect) => {
      effect.age += dt;
    });
  }

  function update(dt) {
    state.elapsed += dt;
    state.ballisticsTicker += dt;
    if (els.overlayTime) {
      els.overlayTime.textContent = formatClock(state.elapsed);
    }

    const focusDist = currentFocusTarget();
    state.targetFocusDist = clamp(focusDist, 8000, 62000);
    const followSpeed = state.projectile && state.projectile.active ? 5.4 : 3.3;
    const smoothing = 1 - Math.exp(-dt * followSpeed);
    state.cameraFocusDist = lerp(state.cameraFocusDist, state.targetFocusDist, smoothing);
    state.cameraShake = Math.max(0, state.cameraShake - dt * 18);

    updateMovingTargets(dt);
    updateProjectile(dt);
    updateEffects(dt);

    if (state.projectile && state.projectile.active) {
      const tgt = getTarget(state.projectile.targetId);
      const totalTof = tgt ? timeOfFlight(state.projectile.distAtFire) : 1;
      const remaining = Math.max(0, totalTof - state.projectile.age);
      const pct = remaining / totalTof;
      updateFuelBar(pct, remaining);
    }

    if (state.phase === "ballistics" && state.ballisticsTicker > 0.22) {
      state.ballisticsTicker = 0;
      buildBallistics(getTarget(state.selectedTargetId));
      syncHUD();
    }
  }

  function getCamera() {
    const worldWidth = clamp((state.cameraFocusDist * 1.28) / state.cameraScale, 15000, 76000);
    const worldHeight = worldWidth * (height / Math.max(1, width)) * 0.92;

    const shakeX = (Math.random() * 2 - 1) * state.cameraShake;
    const shakeY = (Math.random() * 2 - 1) * state.cameraShake * 0.55;

    return {
      worldWidth,
      worldHeight,
      leftPad: width * 0.07,
      usableWidth: width * 0.87,
      groundY: height * 0.74 + shakeY,
      shakeX,
      shakeY,
    };
  }

  function sx(mx, camera) {
    return camera.leftPad + (mx / camera.worldWidth) * camera.usableWidth + camera.shakeX;
  }

  function sy(my, camera) {
    return camera.groundY - (my / camera.worldHeight) * (height * 0.66) + camera.shakeY;
  }

  function drawSky(camera) {
    const gradient = ctx.createLinearGradient(0, 0, 0, camera.groundY);
    gradient.addColorStop(0, "#07182a");
    gradient.addColorStop(1, "#0a2036");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, camera.groundY);

    ctx.strokeStyle = "rgba(69, 214, 255, 0.1)";
    ctx.lineWidth = 1;

    const step = width / 10;
    for (let i = 1; i <= 9; i += 1) {
      const x = i * step + camera.shakeX * 0.25;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, camera.groundY);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(69, 214, 255, 0.08)";
    for (let y = 38; y < camera.groundY; y += 38) {
      ctx.beginPath();
      ctx.moveTo(0, y + camera.shakeY * 0.2);
      ctx.lineTo(width, y + camera.shakeY * 0.2);
      ctx.stroke();
    }
  }

  function drawTerrain(camera) {
    ctx.fillStyle = "#0a1725";
    ctx.fillRect(0, camera.groundY, width, height - camera.groundY);

    ctx.strokeStyle = "rgba(69, 214, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, camera.groundY);
    ctx.lineTo(width, camera.groundY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(69, 214, 255, 0.12)";
    for (let i = 1; i <= 4; i += 1) {
      const y = camera.groundY + ((height - camera.groundY) * i) / 5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  function drawRangeMarkers(camera) {
    ctx.font = '11px "JetBrains Mono"';
    ctx.fillStyle = "rgba(152, 193, 223, 0.76)";
    ctx.strokeStyle = "rgba(69, 214, 255, 0.22)";
    ctx.setLineDash([5, 8]);

    [10000, 20000, 30000, 40000, 50000, 60000].forEach((distance) => {
      if (distance > camera.worldWidth) {
        return;
      }
      const x = sx(distance, camera);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, camera.groundY);
      ctx.stroke();
      ctx.fillText(`${(distance / 1000).toFixed(0)}км`, x + 4, camera.groundY - 10);
    });

    ctx.setLineDash([]);
  }

  function drawGun(camera) {
    const x = sx(0, camera);
    const y = camera.groundY;
    const selected = getTarget(state.selectedTargetId);
    const cannonAngle = selected ? -launchAngle(selected.x) : -Math.PI / 8;

    ctx.save();
    ctx.translate(x, y);

    ctx.strokeStyle = "#45d6ff";
    ctx.fillStyle = "rgba(69, 214, 255, 0.1)";
    ctx.lineWidth = 1.4;

    ctx.beginPath();
    ctx.rect(-18, -8, 36, 8);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(-15, -16, 30, 8);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(-9, -22, 17, 6);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-9, -16);
    ctx.lineTo(8, -16);
    ctx.stroke();

    // Pivot is moved to the front edge of the turret so the barrel is physically attached.
    ctx.save();
    ctx.translate(8, -19);
    ctx.rotate(cannonAngle);
    ctx.beginPath();
    ctx.rect(0, -1.8, 39, 3.6);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(35, -3.4, 6, 6.8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    ctx.font = '10px "JetBrains Mono"';
    ctx.fillStyle = "rgba(186, 227, 244, 0.9)";
    ctx.fillText("2С35", x - 14, y + 18);
  }

  function drawVehicleSilhouette(target, camera) {
    const preset = VEHICLE_PRESETS[target.visualPreset] || VEHICLE_PRESETS.apc;
    const x = sx(target.x, camera);
    const y = camera.groundY;

    const isSelected = target.id === state.selectedTargetId;
    const alpha = target.isDestroyed ? 0.35 : 1;
    const line = isSelected ? "#45d6ff" : "#7bc2e8";
    const fill = isSelected ? "rgba(69, 214, 255, 0.18)" : "rgba(123, 194, 232, 0.1)";

    if (target.isDestroyed) {
      ctx.fillStyle = "rgba(90, 40, 24, 0.5)";
      ctx.beginPath();
      ctx.ellipse(x, y, 24, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = line;
    ctx.fillStyle = fill;
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.rect(x - preset.body / 2, y - preset.height, preset.body, preset.height - 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.rect(x - preset.turretW / 2, y - preset.height - preset.turretH, preset.turretW, preset.turretH);
    ctx.fill();
    ctx.stroke();

    const barrelDir = target.moving ? -1 : -0.35;
    ctx.beginPath();
    ctx.moveTo(x - 2, y - preset.height - preset.turretH / 2);
    ctx.lineTo(x + barrelDir * preset.barrel, y - preset.height - preset.turretH / 2);
    ctx.stroke();

    const wheelOffset = preset.body / (preset.wheelCount + 1);
    for (let i = 1; i <= preset.wheelCount; i += 1) {
      const wx = x - preset.body / 2 + wheelOffset * i;
      ctx.beginPath();
      ctx.arc(wx, y - 2, 2.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (isSelected) {
      const pulse = 17 + Math.sin(state.elapsed * 4.6) * 2;
      ctx.strokeStyle = "rgba(69, 214, 255, 0.6)";
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.arc(x, y - 10, pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.font = '10px "JetBrains Mono"';
    ctx.fillStyle = "rgba(188, 218, 238, 0.95)";
    ctx.fillText(target.name.split("—")[0].trim(), x - 33, y - 42);

    ctx.fillStyle = "rgba(152, 193, 223, 0.74)";
    ctx.fillText(`${(target.x / 1000).toFixed(1)}км`, x - 22, y - 28);

    ctx.restore();
  }

  function drawProjectile(camera) {
    const projectile = state.projectile;
    if (!projectile || !projectile.active) {
      return;
    }

    if (projectile.trail.length > 2) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < projectile.trail.length; i += 1) {
        const p0 = projectile.trail[i - 1];
        const p1 = projectile.trail[i];
        const t = i / (projectile.trail.length - 1);
        const alpha = Math.pow(t, 2.1) * 0.56;
        const widthSeg = 0.4 + t * 3.8;
        const x0 = sx(p0.mx, camera);
        const y0 = sy(p0.my, camera);
        const x1 = sx(p1.mx, camera);
        const y1 = sy(p1.my, camera);

        ctx.strokeStyle = `rgba(182, 233, 255, ${alpha})`;
        ctx.lineWidth = widthSeg;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.restore();
    }

    const x = sx(projectile.mx, camera);
    const y = sy(projectile.my, camera);
    const angle = Math.atan2(-projectile.vy, projectile.vx);
    const flame = 5.5 + Math.sin(state.elapsed * 44 + projectile.age * 20) * 1.35;

    ctx.fillStyle = "rgba(255, 214, 146, 0.24)";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.fillStyle = "rgba(255, 170, 98, 0.42)";
    ctx.beginPath();
    ctx.moveTo(-6.5, 0);
    ctx.lineTo(-10 - flame, -1.3);
    ctx.lineTo(-10 - flame * 0.9, 1.3);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(255, 234, 195, 0.97)";
    ctx.strokeStyle = "rgba(255, 246, 218, 0.86)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(7.4, 0);
    ctx.lineTo(2.2, -2.2);
    ctx.lineTo(-6.6, -1.6);
    ctx.lineTo(-6.6, 1.6);
    ctx.lineTo(2.2, 2.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 252, 245, 0.95)";
    ctx.beginPath();
    ctx.arc(3, 0, 0.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawEffects(camera) {
    state.effects.forEach((effect) => {
      const progress = clamp(effect.age / effect.life, 0, 1);
      const x = sx(effect.mx, camera);
      const y = camera.groundY;

      const radius = (18 + progress * 52) * effect.power;
      const alpha = 1 - progress;

      ctx.fillStyle = effect.hit
        ? `rgba(255, ${Math.round(170 + progress * 50)}, 90, ${alpha * 0.35})`
        : `rgba(255, 130, 95, ${alpha * 0.22})`;
      ctx.beginPath();
      ctx.arc(x, y - radius * 0.24, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = effect.hit
        ? `rgba(255, 230, 160, ${alpha * 0.85})`
        : `rgba(255, 165, 140, ${alpha * 0.72})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.1, Math.PI, 0);
      ctx.stroke();
    });
  }

  function drawHUDTelemetry() {
    const projectile = state.projectile;
    if (!projectile || !projectile.active) {
      return;
    }

    const telemetry = `H: ${Math.round(projectile.my)}м · D: ${(projectile.mx / 1000).toFixed(1)}км · T: ${formatClock(state.elapsed)}`;
    ctx.fillStyle = "rgba(217, 237, 250, 0.84)";
    ctx.font = '12px "JetBrains Mono"';
    ctx.fillText(telemetry, width * 0.38, 26);
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const camera = getCamera();

    drawSky(camera);
    drawTerrain(camera);
    drawRangeMarkers(camera);
    state.targets.forEach((target) => drawVehicleSilhouette(target, camera));
    drawGun(camera);
    drawProjectile(camera);
    drawEffects(camera);
    drawHUDTelemetry(camera);
  }

  function resizeCanvas() {
    const rect = els.sceneShell.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);

    els.canvas.width = Math.round(width * dpr);
    els.canvas.height = Math.round(height * dpr);
    els.canvas.style.width = `${width}px`;
    els.canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function setSheetOpen(next) {
    if (!mobileMedia.matches) {
      next = false;
    }

    isMobileSheetOpen = next;
    els.hud.classList.toggle("open", isMobileSheetOpen);
    els.hudBackdrop.hidden = !isMobileSheetOpen;
    els.hudBackdrop.classList.toggle("on", isMobileSheetOpen);
    els.hudToggle.setAttribute("aria-expanded", String(isMobileSheetOpen));

    if (window.gsap && !prefersReducedMotion) {
      gsap.to(els.hud, {
        y: 0,
        duration: 0.24,
        ease: "power2.out",
        overwrite: true,
      });
    }
  }

  function resetMission() {
    state.phase = "select";
    state.ammo = 6;
    state.score = 0;
    state.selectedTargetId = null;
    state.firing = false;
    state.cameraScale = 1;
    state.cameraShake = 0;
    state.cameraFocusDist = 24000;
    state.targetFocusDist = 24000;
    state.elapsed = 0;
    state.ballisticsTicker = 0;
    state.impactX = 24000;
    state.statusText = "ГОТОВО";
    state.statusTone = "ok";
    state.projectile = null;
    state.effects = [];

    state.targets = TARGET_DEFS.map((def) => ({
      id: def.id,
      type: def.type,
      name: def.name,
      brief: def.brief,
      baseDist: def.dist,
      x: def.dist,
      moving: def.moving,
      speed: def.speed,
      hp: 1,
      isDestroyed: false,
      visualPreset: def.visualPreset,
      idlePhase: rand(-Math.PI, Math.PI),
    }));

    setStatus("ГОТОВО", "ok");
    transitionTo("select");
    buildBallistics(null);
    renderTargetsList();
    syncHUD();
    syncFireButton();
    initFuelBar();

    els.victory.classList.remove("on");
    els.victoryScore.textContent = "0";
    els.log.innerHTML = "";

    log("[МИССИЯ] Выберите цель и выполните огневую задачу.", "info");
    log("[УСЛОВИЯ] Ветер 2 м/с влево, влажность 70%, режим side-view.", "info");
  }

  function showVictory() {
    els.victoryScore.textContent = String(state.score);
    els.victory.classList.add("on");

    if (window.gsap && !prefersReducedMotion) {
      gsap.fromTo(
        els.victory,
        { opacity: 0 },
        { opacity: 1, duration: 0.26, ease: "power2.out" },
      );
    }
  }

  function frame(ts) {
    const dt = clamp((ts - (prevTs || ts)) / 1000, 0, 0.05);
    prevTs = ts;

    update(dt);
    render();

    rafId = requestAnimationFrame(frame);
  }

  function bindEvents() {
    els.fireBtn.addEventListener("click", () => {
      if (state.selectedTargetId !== null) {
        fireAt(state.selectedTargetId);
      }
    });

    els.restartBtn.addEventListener("click", () => {
      resetMission();
      if (mobileMedia.matches) {
        setSheetOpen(false);
      }
    });

    els.hudToggle.addEventListener("click", () => {
      setSheetOpen(!isMobileSheetOpen);
    });

    els.hudBackdrop.addEventListener("click", () => {
      setSheetOpen(false);
    });

    mobileMedia.addEventListener("change", () => {
      if (!mobileMedia.matches) {
        setSheetOpen(false);
      }
      resizeCanvas();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "f" && !els.fireBtn.disabled) {
        fireAt(state.selectedTargetId);
      }

      if (event.key.toLowerCase() === "r") {
        resetMission();
      }

      if (event.key === "Escape" && mobileMedia.matches) {
        setSheetOpen(false);
      }
    });

    const observer = new ResizeObserver(() => {
      resizeCanvas();
    });
    observer.observe(els.sceneShell);

    window.addEventListener("beforeunload", () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    });
  }

  function boot() {
    bindEvents();
    resetMission();
    resizeCanvas();
    rafId = requestAnimationFrame(frame);
  }

  boot();
})();
