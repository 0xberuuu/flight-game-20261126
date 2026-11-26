// Sky Courier — Ring Run
// An original offline flight game. Plain Canvas 2D, no assets, no network.
// Fly through 8 rings over a valley, then land on the runway.
// Controls: Arrows or mouse steer, W/S throttle, P pause, R restart, M mute.
(function () {
  'use strict';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 1280, H = 720, CX = W / 2, CY = H / 2;
  var FOCAL = 760; // projection focal length (px)

  // ---------- deterministic RNG ----------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(20261126);

  // ---------- world ----------
  var KT2FT = 1.68781; // knots -> ft/s
  var RUNWAY = { z0: 9800, z1: 10600, halfW: 35, x: 0 };
  var RINGS = [
    { x: -260, y: 650, z: 1400 }, { x: 180, y: 820, z: 2450 },
    { x: 420, y: 560, z: 3500 }, { x: -120, y: 950, z: 4550 },
    { x: 300, y: 700, z: 5600 }, { x: -380, y: 860, z: 6650 },
    { x: 120, y: 620, z: 7700 }, { x: 0, y: 520, z: 8750 }
  ];
  var RING_R = 95;

  // ridge phases for the two distant mountain layers
  var ridge1 = [], ridge2 = [];
  for (var i = 0; i < 8; i++) { ridge1.push(rng() * 6.283); ridge2.push(rng() * 6.283); }
  // clouds: fixed world positions
  var clouds = [];
  for (var c = 0; c < 26; c++) {
    clouds.push({
      x: (rng() * 2 - 1) * 5200, y: 1500 + rng() * 1300,
      z: 300 + rng() * 11500, s: 90 + rng() * 170, a: 0.5 + rng() * 0.4
    });
  }
  // field patch colours
  var FIELD_COLORS = ['#5d8a3c', '#6f9a44', '#4f7d33', '#8aa34b', '#a8a05a', '#7c9c46', '#557f35'];

  function hash2(x, z) {
    var h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return h - Math.floor(h);
  }
  function ridgeHeight(layer, t) {
    var ph = layer === 0 ? ridge1 : ridge2;
    var h = 0;
    h += Math.sin(t * 1.7 + ph[0]) * 0.5 + Math.sin(t * 3.1 + ph[1]) * 0.3
      + Math.sin(t * 5.3 + ph[2]) * 0.2 + Math.sin(t * 9.1 + ph[3]) * 0.12;
    return h;
  }
  // terrain height (ft) at world (x, z). Valley is flat near the runway.
  function terrainHeight(x, z) {
    var dRun = Math.max(Math.abs(x - RUNWAY.x) - 220, 0) + Math.max(RUNWAY.z0 - z, 0) * 0.15 + Math.max(z - RUNWAY.z1, 0) * 0.15;
    var flat = Math.max(0, 1 - dRun / 900);
    var h = 120 + 130 * ridgeHeight(0, x * 0.0011 + z * 0.0004)
      + 60 * Math.sin(x * 0.004 + 1.3) * Math.sin(z * 0.0016 + 0.7);
    h = Math.max(0, h);
    return h * (1 - flat) + 4 * flat;
  }
  function riverX(z) { return 900 * Math.sin(z * 0.00045 + 0.8) - 700; }
  function roadX(z) { return -1100 + 500 * Math.sin(z * 0.0003 + 2.0); }

  // ---------- state ----------
  var state = 'menu'; // menu | fly | paused | crashed | landed
  var frozen = false; // screenshot mode: render, no physics
  var plane = null;
  var ringsHit = 0, score = 0, elapsed = 0;
  var popup = null; // {text, t}
  var warn = '';
  var best = 0;
  var crashReason = '';
  var landBonus = 0, timeBonus = 0;
  var mouse = { x: CX, y: CY, active: false, last: 0 };
  var keys = {};
  var muted = false;
  var propAngle = 0;

  function resetPlane() {
    plane = {
      x: 0, y: 620, z: 0, heading: 0, pitch: 0.04, roll: 0,
      speed: 120, throttle: 0.62, vs: 0
    };
    ringsHit = 0; score = 0; elapsed = 0; popup = null; warn = '';
    crashReason = ''; landBonus = 0; timeBonus = 0;
  }
  resetPlane();

  // ---------- audio (all synthesized, no assets) ----------
  var AC = null, engineOsc = null, engineOsc2 = null, engineGain = null, windGain = null, windSrc = null;
  function initAudio() {
    if (AC || muted) return;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      engineGain = AC.createGain(); engineGain.gain.value = 0;
      var lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      engineOsc = AC.createOscillator(); engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 62;
      engineOsc2 = AC.createOscillator(); engineOsc2.type = 'square'; engineOsc2.frequency.value = 124;
      var g2 = AC.createGain(); g2.gain.value = 0.4;
      engineOsc.connect(lp); engineOsc2.connect(g2); g2.connect(lp);
      lp.connect(engineGain); engineGain.connect(AC.destination);
      engineOsc.start(); engineOsc2.start();
      // wind: looped noise buffer
      var len = AC.sampleRate * 2, buf = AC.createBuffer(1, len, AC.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      windSrc = AC.createBufferSource(); windSrc.buffer = buf; windSrc.loop = true;
      var wf = AC.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 700; wf.Q.value = 0.6;
      windGain = AC.createGain(); windGain.gain.value = 0;
      windSrc.connect(wf); wf.connect(windGain); windGain.connect(AC.destination);
      windSrc.start();
    } catch (e) { AC = null; }
  }
  function beep(freq, dur, type, vol, when) {
    if (!AC || muted) return;
    var t = AC.currentTime + (when || 0);
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function chime() { beep(880, 0.18, 'sine', 0.2); beep(1318, 0.3, 'sine', 0.16, 0.09); }
  function thud() {
    if (!AC || muted) return;
    var len = AC.sampleRate * 0.5, buf = AC.createBuffer(1, len, AC.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var s = AC.createBufferSource(); s.buffer = buf;
    var g = AC.createGain(); g.gain.value = 0.5;
    s.connect(g); g.connect(AC.destination); s.start();
  }
  function updateAudio() {
    if (!AC || muted) return;
    var on = state === 'fly';
    var th = plane.throttle;
    engineGain.gain.value = on ? 0.05 + th * 0.05 : 0;
    if (engineOsc) {
      engineOsc.frequency.value = 52 + th * 55 + plane.speed * 0.08;
      engineOsc2.frequency.value = 104 + th * 110 + plane.speed * 0.16;
    }
    if (windGain) windGain.gain.value = on ? Math.min(0.12, plane.speed * 0.00045) : 0;
  }

  // ---------- projection ----------
  // Project world point to screen. Returns null when behind camera.
  function project(wx, wy, wz) {
    var dx = wx - plane.x, dy = wy - plane.y, dz = wz - plane.z;
    var sH = Math.sin(plane.heading), cH = Math.cos(plane.heading);
    var fwd = dx * sH + dz * cH;
    if (fwd < 8) return null;
    var lat = dx * cH - dz * sH;
    var angX = Math.atan2(lat, fwd);
    var angY = Math.atan2(dy, fwd) - plane.pitch;
    // Points past ~83° off-axis would wrap around the projection (their
    // tangent flips sign past 90°); drop them instead of drawing them
    // mirrored across the screen.
    if (angX > 1.45 || angX < -1.45 || angY > 1.45 || angY < -1.45) return null;
    return {
      x: CX + Math.tan(angX) * FOCAL,
      y: CY - Math.tan(angY) * FOCAL,
      fwd: fwd,
      scale: FOCAL / fwd
    };
  }
  function horizonY() { return CY + Math.tan(plane.pitch) * FOCAL; }

  // ---------- input ----------
  window.addEventListener('keydown', function (e) {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Enter' && state === 'menu') { startFly(); }
    if (e.key.toLowerCase() === 'r' && (state === 'crashed' || state === 'landed')) { startFly(); }
    if (e.key.toLowerCase() === 'p' && (state === 'fly' || state === 'paused')) {
      state = state === 'fly' ? 'paused' : 'fly';
    }
    if (e.key.toLowerCase() === 'm') {
      muted = !muted;
      if (muted && engineGain) engineGain.gain.value = 0;
      if (!muted) initAudio();
    }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(e.key.toLowerCase()) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * (W / r.width);
    mouse.y = (e.clientY - r.top) * (H / r.height);
    mouse.active = true; mouse.last = performance.now();
  });
  canvas.addEventListener('click', function () {
    initAudio();
    if (state === 'menu') startFly();
    else if (state === 'crashed' || state === 'landed') startFly();
  });
  function startFly() {
    initAudio();
    resetPlane();
    state = 'fly';
  }

  // ---------- update ----------
  function update(dt) {
    if (state !== 'fly') return;
    elapsed += dt;
    // throttle
    if (keys['w'] || keys['shift']) plane.throttle = Math.min(1, plane.throttle + dt * 0.55);
    if (keys['s'] || keys['control']) plane.throttle = Math.max(0, plane.throttle - dt * 0.55);
    // pitch / roll from keyboard
    var pitchIn = 0, rollIn = 0;
    if (keys['arrowup']) pitchIn += 1;
    if (keys['arrowdown']) pitchIn -= 1;
    if (keys['arrowleft']) rollIn -= 1;
    if (keys['arrowright']) rollIn += 1;
    if (pitchIn !== 0 || rollIn !== 0) mouse.active = false;
    // mouse steering (recent mouse movement wins when no keys held)
    if (mouse.active && performance.now() - mouse.last < 4000 && pitchIn === 0 && rollIn === 0) {
      var mx = (mouse.x - CX) / CX, my = (mouse.y - CY) / CY;
      rollIn = Math.max(-1, Math.min(1, mx * 1.6));
      pitchIn = Math.max(-1, Math.min(1, -my * 1.2));
    }
    var targetPitch = pitchIn * 0.30;
    var targetRoll = rollIn * 0.85;
    plane.pitch += (targetPitch - plane.pitch) * Math.min(1, dt * 2.4);
    plane.roll += (targetRoll - plane.roll) * Math.min(1, dt * 2.8);
    // gentle turbulence
    plane.roll += Math.sin(elapsed * 1.7) * 0.0012;
    // speed: throttle drives toward target, drag pulls back
    var targetSpeed = 55 + plane.throttle * 205;
    var rate = targetSpeed > plane.speed ? 14 : 20;
    plane.speed += Math.max(-rate * dt, Math.min(rate * dt, targetSpeed - plane.speed));
    // stall: below 72 kt the nose drops and the plane sinks
    var stall = plane.speed < 72;
    if (stall) {
      plane.pitch += (-0.22 - plane.pitch) * Math.min(1, dt * 1.5);
    }
    // turn: bank turns the heading
    plane.heading -= Math.tan(plane.roll) * 0.32 * (0.35 + plane.speed / 260) * dt;
    // motion
    var spd = plane.speed * KT2FT;
    plane.vs = spd * Math.sin(plane.pitch) - (stall ? 26 : 0);
    plane.y += plane.vs * dt;
    plane.z += spd * Math.cos(plane.pitch) * Math.cos(plane.heading) * dt;
    plane.x += spd * Math.sin(plane.heading) * dt;
    plane.x = Math.max(-2600, Math.min(2600, plane.x));
    // warnings
    var gh = terrainHeight(plane.x, plane.z);
    warn = '';
    if (plane.y - gh < 160 && plane.vs < 0) warn = 'PULL UP';
    else if (stall) warn = 'STALL';
    else if (plane.y - gh < 90) warn = 'TOO LOW';
    // rings
    for (var i = ringsHit; i < RINGS.length; i++) {
      var rg = RINGS[i];
      var dz = rg.z - plane.z;
      if (dz < -60) { // flew past it
        popup = { text: 'RING MISSED', t: 0 };
        ringsHit = i + 1;
        continue;
      }
      if (Math.abs(dz) < 55) {
        var ddx = rg.x - plane.x, ddy = rg.y - plane.y;
        if (Math.sqrt(ddx * ddx + ddy * ddy) < RING_R) {
          ringsHit = i + 1;
          score += 100;
          popup = { text: '+100  RING ' + ringsHit + ' / 8', t: 0 };
          chime();
        }
      }
      break;
    }
    // ground / landing
    var overRunway = Math.abs(plane.x - RUNWAY.x) < RUNWAY.halfW + 6
      && plane.z > RUNWAY.z0 && plane.z < RUNWAY.z1;
    if (plane.y <= gh + 6) {
      if (overRunway && ringsHit >= RINGS.length && plane.speed < 150 && plane.vs > -14) {
        land();
      } else if (overRunway && ringsHit >= RINGS.length && plane.vs <= -14) {
        crash('TOO HARD — YOU SLAMMED THE RUNWAY');
      } else if (overRunway && ringsHit < RINGS.length) {
        crash('YOU LANDED EARLY — FLY THE RINGS FIRST');
      } else {
        crash('TERRAIN — YOU HIT THE GROUND');
      }
    }
    if (plane.z > RUNWAY.z1 + 2500) crash('YOU FLEW PAST THE AIRFIELD');
    if (popup) { popup.t += dt; if (popup.t > 1.6) popup = null; }
  }
  function crash(reason) {
    crashReason = reason;
    state = 'crashed';
    thud();
    if (score > best) best = score;
  }
  function land() {
    state = 'landed';
    landBonus = 500;
    timeBonus = Math.max(0, Math.round(600 - elapsed * 2));
    score += landBonus + timeBonus;
    if (score > best) best = score;
    beep(523, 0.2, 'sine', 0.2); beep(659, 0.2, 'sine', 0.2, 0.15); beep(784, 0.45, 'sine', 0.2, 0.3);
  }

  // ---------- drawing ----------
  function drawSky() {
    var hy = horizonY();
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2c4f86');
    g.addColorStop(0.45, '#6f9fd0');
    g.addColorStop(0.62, '#f2c98a');
    g.addColorStop(0.72, '#e8a56b');
    g.addColorStop(1, '#3d5a34');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // sun (low, warm, ahead-left)
    var sunX = CX - 260 - plane.heading * 900;
    var sunY = Math.max(30, hy - 150);
    var sg = ctx.createRadialGradient(sunX, sunY, 6, sunX, sunY, 120);
    sg.addColorStop(0, 'rgba(255,244,200,0.95)');
    sg.addColorStop(0.25, 'rgba(255,214,140,0.75)');
    sg.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(sunX - 130, sunY - 130, 260, 260);
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath(); ctx.arc(sunX, sunY, 26, 0, 6.2832); ctx.fill();
    // distant mountain ridges (parallax by heading)
    drawRidge(1, hy, 90, '#7d8aa8', 0.55);
    drawRidge(0, hy, 46, '#5d6d8f', 0.8);
  }
  function drawRidge(layer, hy, amp, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-4, H);
    var par = plane.heading * (layer === 0 ? 1400 : 700);
    for (var sx = -4; sx <= W + 8; sx += 8) {
      var t = (sx + par) * 0.004;
      var y = hy - (ridgeHeight(layer, t) * 0.5 + 0.5) * amp - amp * 0.15;
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(W + 4, H);
    ctx.closePath();
    ctx.fill();
    // snow caps removed: the ridge silhouette stays clean
    ctx.restore();
  }

  function groundColor(x, z) {
    // runway tarmac
    if (Math.abs(x - RUNWAY.x) < RUNWAY.halfW + 14 && z > RUNWAY.z0 - 60 && z < RUNWAY.z1 + 60) return '#4a4a52';
    // river
    if (Math.abs(x - riverX(z)) < 46) return '#4f8fc4';
    // road
    if (Math.abs(x - roadX(z)) < 9) return '#6e6a63';
    var h = hash2(Math.floor(x / 260), Math.floor(z / 260));
    return FIELD_COLORS[Math.floor(h * FIELD_COLORS.length)];
  }

  function drawGround() {
    var rows = [];
    var z = plane.z + 2600;
    while (z > plane.z + 26) {
      rows.push(z);
      var step = z - plane.z > 1200 ? 170 : (z - plane.z > 500 ? 90 : 42);
      z -= step;
    }
    rows.push(plane.z + 26);
    // draw far to near
    for (var r = 0; r < rows.length - 1; r++) {
      var zFar = rows[r], zNear = rows[r + 1];
      var halfSpan = 1500;
      var cols = 16;
      for (var c = 0; c < cols; c++) {
        var x0 = plane.x - halfSpan + (2 * halfSpan * c) / cols;
        var x1 = plane.x - halfSpan + (2 * halfSpan * (c + 1)) / cols;
        var cxm = (x0 + x1) / 2, czm = (zFar + zNear) / 2;
        var p00 = project(x0, terrainHeight(x0, zFar), zFar);
        var p10 = project(x1, terrainHeight(x1, zFar), zFar);
        var p11 = project(x1, terrainHeight(x1, zNear), zNear);
        var p01 = project(x0, terrainHeight(x0, zNear), zNear);
        if (!p00 || !p10 || !p11 || !p01) continue;
        ctx.fillStyle = groundColor(cxm, czm);
        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y); ctx.lineTo(p10.x, p10.y);
        ctx.lineTo(p11.x, p11.y); ctx.lineTo(p01.x, p01.y);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  function drawRunway() {
    var z0 = RUNWAY.z0, z1 = RUNWAY.z1, hw = RUNWAY.halfW;
    // threshold + edge lights + centerline dashes
    for (var z = z0; z < z1; z += 100) {
      var a = project(-hw, 6, z), b = project(hw, 6, z);
      var c = project(-hw, 6, z + 100), d = project(hw, 6, z + 100);
      if (!a || !b || !c || !d) continue;
      ctx.fillStyle = '#54545e';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.lineTo(c.x, c.y);
      ctx.closePath(); ctx.fill();
      // centerline dash
      if (Math.floor(z / 100) % 2 === 0) {
        var m1 = project(-3, 7, z + 12), m2 = project(3, 7, z + 12);
        var m3 = project(3, 7, z + 62), m4 = project(-3, 7, z + 62);
        if (m1 && m2 && m3 && m4) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.lineTo(m3.x, m3.y); ctx.lineTo(m4.x, m4.y);
          ctx.closePath(); ctx.fill();
        }
      }
      // edge lights
      var e1 = project(-hw - 4, 8, z), e2 = project(hw + 4, 8, z);
      if (e1) { ctx.fillStyle = '#ffd76a'; ctx.beginPath(); ctx.arc(e1.x, e1.y, Math.max(1.5, e1.scale * 2.2), 0, 6.2832); ctx.fill(); }
      if (e2) { ctx.fillStyle = '#ffd76a'; ctx.beginPath(); ctx.arc(e2.x, e2.y, Math.max(1.5, e2.scale * 2.2), 0, 6.2832); ctx.fill(); }
    }
    // threshold bars
    for (var k = -2; k <= 2; k++) {
      var t1 = project(k * 12 - 5, 7, z0 + 8), t2 = project(k * 12 + 5, 7, z0 + 8);
      var t3 = project(k * 12 + 5, 7, z0 + 42), t4 = project(k * 12 - 5, 7, z0 + 42);
      if (t1 && t2 && t3 && t4) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.moveTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(t3.x, t3.y); ctx.lineTo(t4.x, t4.y);
        ctx.closePath(); ctx.fill();
      }
    }
    // runway number "27" near threshold
    var n = project(0, 7, z0 + 130);
    if (n && n.fwd < 2600) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold ' + Math.max(10, n.scale * 26) + 'px Verdana';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('27', n.x, n.y);
      ctx.restore();
    }
    drawAirfieldBuildings();
  }

  function drawAirfieldBuildings() {
    // hangar + tower beside the runway (simple shaded boxes)
    var boxes = [
      { x: -120, z: 10100, w: 90, d: 70, h: 42, top: '#8a94a6', side: '#5d6678' },
      { x: -230, z: 10250, w: 60, d: 55, h: 30, top: '#7a6a55', side: '#54493c' },
      { x: 150, z: 10080, w: 26, d: 26, h: 110, top: '#9fb4cc', side: '#5d7290' }
    ];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var y0 = terrainHeight(b.x, b.z);
      var p = [
        project(b.x - b.w / 2, y0, b.z - b.d / 2), project(b.x + b.w / 2, y0, b.z - b.d / 2),
        project(b.x + b.w / 2, y0, b.z + b.d / 2), project(b.x - b.w / 2, y0, b.z + b.d / 2),
        project(b.x - b.w / 2, y0 + b.h, b.z - b.d / 2), project(b.x + b.w / 2, y0 + b.h, b.z - b.d / 2),
        project(b.x + b.w / 2, y0 + b.h, b.z + b.d / 2), project(b.x - b.w / 2, y0 + b.h, b.z + b.d / 2)
      ];
      var ok = true;
      for (var j = 0; j < 8; j++) if (!p[j]) ok = false;
      if (!ok) continue;
      // top face
      ctx.fillStyle = b.top;
      ctx.beginPath();
      ctx.moveTo(p[4].x, p[4].y); ctx.lineTo(p[5].x, p[5].y); ctx.lineTo(p[6].x, p[6].y); ctx.lineTo(p[7].x, p[7].y);
      ctx.closePath(); ctx.fill();
      // front face
      ctx.fillStyle = b.side;
      ctx.beginPath();
      ctx.moveTo(p[3].x, p[3].y); ctx.lineTo(p[2].x, p[2].y); ctx.lineTo(p[6].x, p[6].y); ctx.lineTo(p[7].x, p[7].y);
      ctx.closePath(); ctx.fill();
    }
    // windsock near threshold
    var w = project(-70, terrainHeight(-70, RUNWAY.z0 + 60), RUNWAY.z0 + 60);
    if (w && w.fwd < 3000) {
      ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = Math.max(1, w.scale * 3);
      ctx.beginPath(); ctx.moveTo(w.x, w.y); ctx.lineTo(w.x, w.y - w.scale * 46); ctx.stroke();
      ctx.fillStyle = '#ff7a3c';
      ctx.beginPath();
      ctx.moveTo(w.x, w.y - w.scale * 46);
      ctx.lineTo(w.x + w.scale * 34, w.y - w.scale * 40);
      ctx.lineTo(w.x, w.y - w.scale * 32);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawClouds() {
    ctx.save();
    for (var i = 0; i < clouds.length; i++) {
      var cl = clouds[i];
      var p = project(cl.x, cl.y, cl.z);
      if (!p || p.fwd < 20 || p.fwd > 6000) continue;
      var s = cl.s * p.scale;
      if (s < 2) continue;
      ctx.globalAlpha = Math.min(0.85, cl.a * Math.min(1, 2400 / p.fwd));
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, s, s * 0.36, 0, 0, 6.2832);
      ctx.ellipse(p.x - s * 0.55, p.y + s * 0.1, s * 0.6, s * 0.26, 0, 0, 6.2832);
      ctx.ellipse(p.x + s * 0.55, p.y + s * 0.08, s * 0.62, s * 0.28, 0, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRings() {
    for (var i = 0; i < RINGS.length; i++) {
      var rg = RINGS[i];
      var p = project(rg.x, rg.y, rg.z);
      if (!p || p.fwd < 12 || p.fwd > 3200) continue;
      var r = RING_R * p.scale;
      if (r < 2) continue;
      var isNext = i === ringsHit;
      var done = i < ringsHit;
      if (done) continue;
      // pylon line from ring bottom to the ground
      var g = project(rg.x, terrainHeight(rg.x, rg.z), rg.z);
      if (g) {
        ctx.strokeStyle = isNext ? 'rgba(255,205,80,0.5)' : 'rgba(120,220,255,0.35)';
        ctx.lineWidth = Math.max(1, r * 0.03);
        ctx.beginPath(); ctx.moveTo(p.x, p.y + r); ctx.lineTo(g.x, g.y); ctx.stroke();
      }
      // glow
      ctx.save();
      ctx.shadowColor = isNext ? '#ffbf2e' : '#37c8ff';
      ctx.shadowBlur = r * 0.35;
      ctx.strokeStyle = isNext ? '#ffc93c' : '#4fd2ff';
      ctx.lineWidth = Math.max(2, r * 0.09);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, r * 0.025);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.stroke();
      // translucent disc
      ctx.fillStyle = isNext ? 'rgba(255,201,60,0.10)' : 'rgba(79,210,255,0.07)';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.2832); ctx.fill();
      ctx.restore();
      // label
      if (isNext) {
        ctx.fillStyle = '#ffe9a8';
        ctx.font = 'bold ' + Math.max(12, r * 0.22) + 'px Verdana';
        ctx.textAlign = 'center';
        ctx.fillText('RING ' + (i + 1), p.x, p.y - r - 12);
      }
    }
  }

  function drawPlaneShadow() {
    var gh = terrainHeight(plane.x, plane.z + 60);
    if (plane.y - gh > 900) return;
    var p = project(plane.x, gh + 4, plane.z + 60);
    if (!p) return;
    var s = Math.max(4, 9000 / p.fwd);
    ctx.save();
    ctx.globalAlpha = Math.max(0.08, 0.3 - (plane.y - gh) / 3000);
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, s * 1.6, s * 0.5, 0, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  // ---------- the aircraft (chase view) ----------
  function drawPlane() {
    var px = CX, py = 596;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(plane.roll * 0.55);
    var bob = Math.sin(performance.now() * 0.004) * 1.5;
    ctx.translate(0, bob);
    // propeller disc (spinning — the prop is at the far nose, seen face-on)
    propAngle += 0.55;
    ctx.save();
    ctx.translate(0, -118);
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = '#dfe6ee';
    ctx.beginPath(); ctx.arc(0, 0, 44, 0, 6.2832); ctx.fill();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#c8d2de'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-Math.sin(propAngle) * 42, -Math.cos(propAngle) * 42);
    ctx.lineTo(Math.sin(propAngle) * 42, Math.cos(propAngle) * 42);
    ctx.moveTo(-Math.cos(propAngle) * 42, Math.sin(propAngle) * 42);
    ctx.lineTo(Math.cos(propAngle) * 42, -Math.sin(propAngle) * 42);
    ctx.stroke();
    ctx.restore();
    // main wings
    var wg = ctx.createLinearGradient(0, -40, 0, 10);
    wg.addColorStop(0, '#f4f7fa'); wg.addColorStop(0.5, '#c3cedb'); wg.addColorStop(1, '#8b98a9');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(-196, -6); ctx.lineTo(-30, -34); ctx.lineTo(30, -34); ctx.lineTo(196, -6);
    ctx.lineTo(176, 12); ctx.lineTo(28, -6); ctx.lineTo(-28, -6); ctx.lineTo(-176, 12);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,55,75,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    // wing tip lights
    ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(-192, 2, 5, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#34d17b'; ctx.beginPath(); ctx.arc(192, 2, 5, 0, 6.2832); ctx.fill();
    // fuselage
    var fg = ctx.createLinearGradient(-26, 0, 26, 0);
    fg.addColorStop(0, '#7e8b9c'); fg.addColorStop(0.35, '#eef2f6'); fg.addColorStop(0.65, '#d7dee7'); fg.addColorStop(1, '#6d7a8a');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-24, 96);
    ctx.quadraticCurveTo(-30, 10, -20, -96);
    ctx.quadraticCurveTo(0, -122, 20, -96);
    ctx.quadraticCurveTo(30, 10, 24, 96);
    ctx.quadraticCurveTo(0, 108, -24, 96);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,55,75,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();
    // cheatline stripe
    ctx.fillStyle = '#e05a2b';
    ctx.fillRect(-25, 18, 50, 7);
    ctx.fillStyle = '#2b6cb0';
    ctx.fillRect(-25, 27, 50, 4);
    // canopy glint
    ctx.fillStyle = 'rgba(140,200,240,0.9)';
    ctx.beginPath(); ctx.ellipse(0, -66, 13, 22, 0, 0, 6.2832); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath(); ctx.ellipse(-4, -72, 4, 10, -0.3, 0, 6.2832); ctx.fill();
    // tail: horizontal stabilizer + vertical fin
    ctx.fillStyle = '#b7c2cf';
    ctx.beginPath();
    ctx.moveTo(-78, 84); ctx.lineTo(-14, 66); ctx.lineTo(14, 66); ctx.lineTo(78, 84);
    ctx.lineTo(66, 96); ctx.lineTo(0, 82); ctx.lineTo(-66, 96);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2b6cb0';
    ctx.beginPath();
    ctx.moveTo(-12, 96); ctx.lineTo(-16, 44); ctx.lineTo(-4, 58); ctx.lineTo(10, 96);
    ctx.closePath(); ctx.fill();
    // registration (above the tail fin so it stays readable)
    ctx.fillStyle = 'rgba(30,45,65,0.8)';
    ctx.font = 'bold 11px Verdana'; ctx.textAlign = 'center';
    ctx.fillText('N-SKY1', 0, 8);
    ctx.restore();
  }

  // ---------- HUD ----------
  function hudBox(x, y, w, h, label, value, unit) {
    ctx.save();
    ctx.fillStyle = 'rgba(8,16,28,0.72)';
    ctx.strokeStyle = 'rgba(120,220,255,0.55)';
    ctx.lineWidth = 1.5;
    roundRect(x, y, w, h, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8fd8ff';
    ctx.font = 'bold 11px Verdana'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x + 10, y + 17);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px "Courier New", monospace';
    ctx.fillText(value, x + 10, y + 46);
    if (unit) {
      ctx.fillStyle = '#8fd8ff';
      ctx.font = 'bold 12px Verdana';
      ctx.fillText(unit, x + w - 34, y + 46);
    }
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fmt(n, pad) {
    var s = String(Math.round(n));
    while (s.length < pad) s = '0' + s;
    return s;
  }
  function drawCompass() {
    var w = 420, x0 = CX - w / 2, y = 76; // below the ALT/SPD/HDG boxes
    ctx.save();
    ctx.fillStyle = 'rgba(8,16,28,0.66)';
    roundRect(x0, y, w, 44, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(120,220,255,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y, w, 44); ctx.clip();
    var hdg = ((plane.heading * 57.2958) % 360 + 360) % 360;
    var pxPerDeg = w / 120;
    for (var d = -60; d <= 60; d += 5) {
      var deg = Math.round((hdg + d) / 5) * 5;
      var off = (deg - hdg) * pxPerDeg;
      var norm = ((deg % 360) + 360) % 360;
      var sx = CX + off;
      var major = norm % 30 === 0;
      ctx.strokeStyle = major ? '#cfeaff' : 'rgba(160,210,240,0.5)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(sx, y + 34); ctx.lineTo(sx, y + (major ? 16 : 24)); ctx.stroke();
      if (major) {
        var lbl = norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : String(norm / 10);
        ctx.fillStyle = '#eaf6ff';
        ctx.font = 'bold 12px Verdana'; ctx.textAlign = 'center';
        ctx.fillText(lbl, sx, y + 13);
      }
    }
    ctx.restore();
    // center marker
    ctx.fillStyle = '#ffc93c';
    ctx.beginPath();
    ctx.moveTo(CX - 7, y + 44); ctx.lineTo(CX + 7, y + 44); ctx.lineTo(CX, y + 34);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function drawAttitude() {
    var x = 92, y = 622, r = 58;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.clip();
    ctx.translate(x, y);
    ctx.rotate(-plane.roll);
    var py = Math.max(-r, Math.min(r, plane.pitch * 220));
    ctx.fillStyle = '#3f8fd2'; ctx.fillRect(-r - 4, -r - 4 + py, 2 * r + 8, r + 4 - py);
    ctx.fillStyle = '#7a5a34'; ctx.fillRect(-r - 4, py, 2 * r + 8, r + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-r - 4, py - 1, 2 * r + 8, 2);
    // pitch ladder
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
    for (var k = -2; k <= 2; k++) {
      if (k === 0) continue;
      var ly = py - k * 18;
      ctx.beginPath(); ctx.moveTo(-16, ly); ctx.lineTo(16, ly); ctx.stroke();
    }
    ctx.restore();
    // bezel + fixed aircraft symbol
    ctx.strokeStyle = '#cfeaff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
    ctx.strokeStyle = '#ffc93c'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 26, y); ctx.lineTo(x - 8, y); ctx.moveTo(x + 8, y); ctx.lineTo(x + 26, y);
    ctx.moveTo(x, y); ctx.lineTo(x, y + 8);
    ctx.stroke();
    ctx.fillStyle = '#cfeaff';
    ctx.font = 'bold 11px Verdana'; ctx.textAlign = 'center';
    ctx.fillText('ATTITUDE', x, y + r + 16);
  }
  function drawThrottle() {
    var x = W - 66, y = 150, h = 220;
    ctx.save();
    ctx.fillStyle = 'rgba(8,16,28,0.66)';
    roundRect(x - 14, y - 26, 52, h + 56, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(120,220,255,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#8fd8ff'; ctx.font = 'bold 11px Verdana'; ctx.textAlign = 'center';
    ctx.fillText('THR', x + 12, y - 10);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(x, y, 24, h, 5); ctx.fill();
    var th = plane.throttle * h;
    var tg = ctx.createLinearGradient(0, y + h, 0, y);
    tg.addColorStop(0, '#2fae5f'); tg.addColorStop(0.7, '#ffc93c'); tg.addColorStop(1, '#ff5a3c');
    ctx.fillStyle = tg;
    roundRect(x, y + h - th, 24, th, 5); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px Verdana';
    ctx.fillText(Math.round(plane.throttle * 100) + '%', x + 12, y + h + 20);
    ctx.restore();
  }
  function drawHUD() {
    var hdg = ((plane.heading * 57.2958) % 360 + 360) % 360;
    var altFt = Math.max(0, plane.y);
    hudBox(16, 16, 168, 58, 'ALTITUDE', fmt(altFt, 4), 'FT');
    hudBox(196, 16, 168, 58, 'SPEED', fmt(plane.speed, 3), 'KT');
    hudBox(376, 16, 150, 58, 'HEADING', fmt(hdg, 3), '°');
    drawCompass();
    drawAttitude();
    drawThrottle();
    // rings + score + timer (top right)
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(8,16,28,0.66)';
    roundRect(W - 246, 16, 230, 58, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(120,220,255,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#8fd8ff'; ctx.font = 'bold 11px Verdana';
    ctx.fillText('RINGS', W - 226, 33);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 26px "Courier New", monospace';
    ctx.fillText(ringsHit + ' / 8', W - 226, 60);
    ctx.fillStyle = '#8fd8ff'; ctx.font = 'bold 11px Verdana';
    ctx.fillText('SCORE', W - 120, 33);
    ctx.fillStyle = '#ffc93c'; ctx.font = 'bold 26px "Courier New", monospace';
    ctx.fillText(String(score), W - 30, 60);
    ctx.fillStyle = '#cfeaff'; ctx.font = 'bold 13px Verdana';
    var mm = Math.floor(elapsed / 60), ss = Math.floor(elapsed % 60);
    ctx.fillText(fmt(mm, 2) + ':' + fmt(ss, 2), W - 30, 92);
    ctx.restore();
    // next ring distance
    if (ringsHit < RINGS.length) {
      var rg = RINGS[ringsHit];
      var dft = Math.max(0, rg.z - plane.z);
      ctx.save();
      ctx.fillStyle = 'rgba(8,16,28,0.6)';
      roundRect(CX - 110, 126, 220, 30, 8); ctx.fill();
      ctx.fillStyle = '#ffe9a8'; ctx.font = 'bold 14px Verdana'; ctx.textAlign = 'center';
      ctx.fillText('NEXT RING ' + (ringsHit + 1) + ' — ' + Math.round(dft) + ' FT', CX, 146);
      ctx.restore();
    } else if (state === 'fly') {
      ctx.save();
      ctx.fillStyle = 'rgba(8,16,28,0.6)';
      roundRect(CX - 150, 126, 300, 30, 8); ctx.fill();
      ctx.fillStyle = '#9dffb0'; ctx.font = 'bold 14px Verdana'; ctx.textAlign = 'center';
      ctx.fillText('ALL RINGS CLEAR — LAND ON RUNWAY 27', CX, 146);
      ctx.restore();
    }
    // flight-path reticle (moves with pitch)
    var rx = CX - plane.heading * 500;
    var ry = CY + Math.tan(plane.pitch) * FOCAL * 0.9;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(rx, ry, 12, 0, 6.2832); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx - 20, ry); ctx.lineTo(rx - 8, ry);
    ctx.moveTo(rx + 8, ry); ctx.lineTo(rx + 20, ry);
    ctx.moveTo(rx, ry - 20); ctx.lineTo(rx, ry - 8);
    ctx.stroke();
    ctx.restore();
    // vertical speed
    ctx.save();
    ctx.fillStyle = 'rgba(8,16,28,0.66)';
    roundRect(16, 88, 168, 30, 8); ctx.fill();
    ctx.fillStyle = '#8fd8ff'; ctx.font = 'bold 12px Verdana'; ctx.textAlign = 'left';
    var vsFpm = Math.round(plane.vs * 60);
    ctx.fillText('VERT ' + (vsFpm >= 0 ? '+' : '') + vsFpm + ' FPM', 26, 108);
    ctx.restore();
    // popup
    if (popup) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - popup.t / 1.6);
      ctx.fillStyle = '#ffc93c';
      ctx.font = 'bold 34px Verdana'; ctx.textAlign = 'center';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
      ctx.fillText(popup.text, CX, 190);
      ctx.restore();
    }
    // warning
    if (warn && state === 'fly') {
      var blink = Math.floor(performance.now() / 280) % 2 === 0;
      if (blink) {
        ctx.save();
        ctx.fillStyle = '#ff3b30';
        ctx.font = 'bold 30px Verdana'; ctx.textAlign = 'center';
        ctx.shadowColor = '#000'; ctx.shadowBlur = 10;
        ctx.fillText('⚠ ' + warn + ' ⚠', CX, 250);
        ctx.restore();
      }
    }
  }

  // ---------- overlays ----------
  function dim() { ctx.fillStyle = 'rgba(6,12,24,0.45)'; ctx.fillRect(0, 0, W, H); }
  function drawMenu() {
    dim();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 64px Verdana';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 16;
    ctx.fillText('SKY COURIER', CX, 210);
    ctx.fillStyle = '#ffc93c';
    ctx.font = 'bold 30px Verdana';
    ctx.fillText('— RING RUN —', CX, 258);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '20px Verdana';
    ctx.fillText('Fly the valley course. Thread all 8 rings, then land on runway 27.', CX, 320);
    ctx.fillText('Low and slow is smooth. Fast and steep is a crater.', CX, 352);
    ctx.fillStyle = '#8fd8ff';
    ctx.font = 'bold 17px Verdana';
    ctx.fillText('ARROWS or MOUSE — steer      W / S — throttle      P — pause      R — restart', CX, 420);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px Verdana';
    var blink = Math.floor(performance.now() / 450) % 2 === 0;
    if (blink) ctx.fillText('PRESS ENTER OR CLICK TO FLY', CX, 500);
    if (best > 0) {
      ctx.fillStyle = '#ffc93c'; ctx.font = 'bold 18px Verdana';
      ctx.fillText('BEST SCORE: ' + best, CX, 548);
    }
    ctx.restore();
  }
  function drawPaused() {
    dim();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.font = 'bold 44px Verdana';
    ctx.fillText('PAUSED', CX, 330);
    ctx.font = '18px Verdana'; ctx.fillStyle = '#cfeaff';
    ctx.fillText('Press P to keep flying', CX, 372);
    ctx.restore();
  }
  function drawCrashed() {
    dim();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5a4e'; ctx.font = 'bold 52px Verdana';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 14;
    ctx.fillText('CRASHED', CX, 300);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.font = '22px Verdana';
    ctx.fillText(crashReason, CX, 348);
    ctx.fillStyle = '#ffc93c'; ctx.font = 'bold 26px Verdana';
    ctx.fillText('SCORE ' + score + '   ·   RINGS ' + ringsHit + ' / 8', CX, 410);
    ctx.fillStyle = '#cfeaff'; ctx.font = '18px Verdana';
    ctx.fillText('Press R to fly again', CX, 462);
    ctx.restore();
  }
  function drawLanded() {
    dim();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9dffb0'; ctx.font = 'bold 48px Verdana';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 14;
    ctx.fillText('TOUCHDOWN!', CX, 280);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.font = '22px Verdana';
    ctx.fillText('All 8 rings cleared and a clean landing on runway 27.', CX, 326);
    ctx.fillStyle = '#ffc93c'; ctx.font = 'bold 24px Verdana';
    ctx.fillText('RINGS 800   +   LANDING 500   +   TIME ' + timeBonus, CX, 386);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 30px Verdana';
    ctx.fillText('TOTAL SCORE  ' + score, CX, 436);
    ctx.fillStyle = '#cfeaff'; ctx.font = '18px Verdana';
    ctx.fillText('Press R to fly the course again', CX, 486);
    ctx.restore();
  }

  // ---------- cockpit frame ----------
  function drawCockpitFrame() {
    ctx.save();
    var g = ctx.createLinearGradient(0, 0, 0, 46);
    g.addColorStop(0, 'rgba(10,14,22,0.85)'); g.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 46);
    var g2 = ctx.createLinearGradient(0, H, 0, H - 40);
    g2.addColorStop(0, 'rgba(10,14,22,0.85)'); g2.addColorStop(1, 'rgba(10,14,22,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, H - 40, W, 40);
    ctx.strokeStyle = 'rgba(20,26,38,0.9)'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.stroke();
    ctx.restore();
  }

  // ---------- frame ----------
  function render() {
    ctx.save();
    // roll the whole world view (HUD stays level)
    ctx.translate(CX, CY);
    ctx.rotate(plane.roll * 0.22);
    ctx.translate(-CX, -CY);
    drawSky();
    drawGround();
    drawRunway();
    drawClouds();
    drawRings();
    drawPlaneShadow();
    ctx.restore();
    drawPlane();
    drawCockpitFrame();
    drawHUD();
    if (state === 'menu') drawMenu();
    else if (state === 'paused') drawPaused();
    else if (state === 'crashed') drawCrashed();
    else if (state === 'landed') drawLanded();
  }

  // ---------- screenshot staging (?shot=menu|cruise|ring|final) ----------
  var params = new URLSearchParams(window.location.search);
  var shot = params.get('shot');
  if (shot) {
    frozen = true;
    if (shot === 'menu') {
      state = 'menu';
      plane.y = 620; plane.z = 0; plane.speed = 120;
    } else if (shot === 'cruise') {
      resetPlane();
      state = 'fly';
      plane.y = 1150; plane.z = 950; plane.speed = 185; plane.throttle = 0.8;
      plane.pitch = 0.02; plane.heading = 0.02;
    } else if (shot === 'ring') {
      resetPlane();
      state = 'fly';
      plane.x = -240; plane.y = 640; plane.z = 1180; plane.speed = 190; plane.throttle = 0.8;
      plane.pitch = 0.01; plane.heading = -0.02;
    } else if (shot === 'final') {
      resetPlane();
      state = 'fly';
      ringsHit = 8; score = 800;
      plane.x = 6; plane.y = 240; plane.z = 9300; plane.speed = 118; plane.throttle = 0.35;
      plane.pitch = -0.06; plane.heading = 0;
    }
  }

  // ---------- main loop ----------
  function fitCanvas() {
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = Math.floor(W * s) + 'px';
    canvas.style.height = Math.floor(H * s) + 'px';
  }
  window.addEventListener('resize', fitCanvas);
  fitCanvas();

  var last = performance.now();
  function loop(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!frozen) update(dt);
    updateAudio();
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
