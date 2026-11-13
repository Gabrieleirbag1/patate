/*
 * Simulation de balles qui rebondissent et fusionnent (port web de final.py).
 *
 * - Une flasque en verre à fond bombé contient les balles.
 * - La plus petite balle tombe automatiquement par le goulot à intervalle régulier.
 * - Deux balles du même type qui se touchent fusionnent en une plus grosse.
 * - À chaque fusion, le son du niveau est joué (voir audio.js).
 *
 * Physique : Planck.js (Box2D). Le dessin se fait en pixels, la physique en mètres (SCALE).
 *
 * Contrôles : clic/toucher = lâcher une balle, Espace = lâcher, A = spawn auto,
 *             F = vitesse (x1 -> x2 -> ... -> x10 -> x1), R = réinitialiser.
 */
(function () {
  "use strict";

  const { World, Vec2, Circle, Chain } = planck;

  // --------------------------------------------------------------------------
  // CONFIGURATION (mêmes noms et valeurs que final.py)
  // --------------------------------------------------------------------------
  const WIDTH = 800, HEIGHT = 900;
  const GRAVITY = 1200;                 // pixels / s²

  // Un type par ligne : rayon en pixels + couleur de secours.
  // L'ordre = l'ordre d'évolution. Les images, sons et noms viennent du pack choisi.
  const TYPES = [
    { radius: 18,  color: [220, 50, 70] },
    { radius: 26,  color: [240, 100, 90] },
    { radius: 36,  color: [140, 80, 190] },
    { radius: 48,  color: [250, 160, 40] },
    { radius: 62,  color: [120, 200, 70] },
    { radius: 78,  color: [250, 200, 80] },
    { radius: 96,  color: [90, 190, 130] },
    { radius: 118, color: [60, 150, 80] },
  ];

  const SOUND_OF_CREATED_FRUIT = true;  // true : son du fruit CRÉÉ (2 cerises -> son de la fraise)
  const SOUND_ON_SPAWN = true;          // son du fruit lâché, seulement si aucun autre son en cours
  const SPAWNABLE = [0];
  const MERGE_LAST_TYPE = false;
  let AUTO_SPAWN = true;
  const AUTO_SPAWN_LEVEL = 0;
  const AUTO_SPAWN_DELAY = 1.0;
  const RESTART_WHEN_FULL = true;
  const FULL_DELAY = 3.0;

  // Physique.
  // pymunk MULTIPLIE élasticités et frictions des deux objets en contact (0.75 x 0.75),
  // Box2D prend le max des restitutions et la racine du produit des frictions :
  // on donne donc directement les valeurs effectives d'origine à toutes les formes.
  const BALL_ELASTICITY = 0.75, WALL_ELASTICITY = 0.75;
  const FRICTION = 0.6;
  const RESTITUTION = BALL_ELASTICITY * WALL_ELASTICITY;   // 0.5625
  const EFFECTIVE_FRICTION = FRICTION * FRICTION;          // 0.36
  const MERGE_TOLERANCE = 1.5;
  const SUBSTEPS = 5;
  const SPEED_LEVELS = [1, 2, 4, 6, 8, 10];
  const SCALE = 50;                     // pixels par mètre (Box2D aime les objets de 0.1 à 10 m)

  // Flasque
  const FLASK_CX = WIDTH / 2;
  const FLASK_TOP = 40;
  const FLASK_NECK_W = 140;
  const FLASK_NECK_H = 55;
  const FLASK_SHOULDER_H = 85;
  const FLASK_BODY_W = WIDTH - 60;
  const FLASK_BOTTOM = HEIGHT - 28;
  const FLASK_BOTTOM_DEPTH = 0.7;
  const WALL_RADIUS = 8;

  const RES = Math.min(2, Math.max(1, window.devicePixelRatio || 1));   // netteté du rendu

  // --------------------------------------------------------------------------
  // OUTILS
  // --------------------------------------------------------------------------
  const lerp = (a, b, t) => a + (b - a) * t;
  const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const TAU = Math.PI * 2;

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * RES);
    c.height = Math.ceil(h * RES);
    const ctx = c.getContext("2d");
    ctx.scale(RES, RES);
    return [c, ctx];
  }

  /** Décale une polyligne de d pixels vers l'INTÉRIEUR de la flasque (d<0 : vers l'extérieur). */
  function offsetPath(path, d) {
    const n = path.length;
    return path.map(([x, y], i) => {
      const [x0, y0] = path[Math.max(0, i - 1)];
      const [x1, y1] = path[Math.min(n - 1, i + 1)];
      let tx = x1 - x0, ty = y1 - y0;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      return [x + ty * d, y - tx * d];
    });
  }

  function strokePolyline(ctx, pts, color, width) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }

  // --------------------------------------------------------------------------
  // SPRITES (images du pack, ou balle de secours avec un visage)
  // --------------------------------------------------------------------------
  function makeFallback(radius, color) {
    const [c, ctx] = makeCanvas(radius * 2, radius * 2);
    const R = radius;
    ctx.fillStyle = rgba(color);
    ctx.beginPath(); ctx.arc(R, R, R, 0, TAU); ctx.fill();
    ctx.lineWidth = Math.max(2, R / 12);
    ctx.strokeStyle = "#000";
    ctx.beginPath(); ctx.arc(R, R, R - ctx.lineWidth / 2, 0, TAU); ctx.stroke();
    const eye = Math.max(2, R / 7);
    for (const sign of [-1, 1]) {
      const ex = R + sign * R / 3, ey = R - R / 4;
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ex, ey, eye * 2, 0, TAU); ctx.fill();
      ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(ex, ey, eye, 0, TAU); ctx.fill();
    }
    ctx.lineWidth = Math.max(2, R / 14);
    ctx.beginPath(); ctx.ellipse(R, R + R / 4, R / 2, R / 4, 0, 0, Math.PI); ctx.stroke();
    return c;
  }

  /** Image redimensionnée au diamètre. cropCircle : recadrage « cover » + découpe ronde (photos). */
  function makeSprite(img, radius, cropCircle) {
    const d = radius * 2;
    const [c, ctx] = makeCanvas(d, d);
    ctx.imageSmoothingQuality = "high";
    if (cropCircle) {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
      ctx.save();
      ctx.beginPath(); ctx.arc(radius, radius, radius, 0, TAU); ctx.clip();
      ctx.drawImage(img, sx, sy, s, s, 0, 0, d, d);
      ctx.restore();
      ctx.lineWidth = Math.max(2, radius / 14);
      ctx.strokeStyle = INK;
      ctx.beginPath(); ctx.arc(radius, radius, radius - ctx.lineWidth / 2, 0, TAU); ctx.stroke();
    } else {
      ctx.drawImage(img, 0, 0, d, d);        // comme final.py : image étirée au carré
    }
    return c;
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function loadSprites(pack) {
    const images = await Promise.all(pack.levels.map((l) => loadImage(l.image_url)));
    return TYPES.map((t, i) => images[i]
      ? makeSprite(images[i], t.radius, pack.crop_circle)
      : makeFallback(t.radius, t.color));
  }

  // --------------------------------------------------------------------------
  // STYLE « CARNET À DESSIN » : traits de crayon, couleurs de surligneur
  // --------------------------------------------------------------------------
  const INK = "#2c2a35";
  const PAPER = "#fffcf2";
  const PASTELS = ["#ffe066", "#ffa8c9", "#a6e8a6", "#a9d4ff", "#ffc078", "#d4c2ff"];
  const HAND_FONT = '"Gochi Hand", "Patrick Hand", "Comic Sans MS", cursive';

  function tracePath(ctx, pts, close = false) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  }

  /** Trait « au crayon » : plusieurs passages légèrement décalés. */
  function sketchLine(ctx, pts, color, width, jitter = 1, passes = 2) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let p = 0; p < passes; p++) {
      ctx.globalAlpha = p === 0 ? 1 : 0.5;
      tracePath(ctx, pts.map(([x, y]) => [x + rand(-jitter, jitter), y + rand(-jitter, jitter)]));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Petits dessins d'enfant : étoile, cœur, rond, spirale, vague. */
  function makeDoodle(kind, size, color) {
    const pad = 5, S = size + pad * 2;
    const [c, ctx] = makeCanvas(S, S);
    const m = S / 2, r = size / 2;
    const pts = [];
    if (kind === "star") {
      for (let i = 0; i <= 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
        pts.push([m + Math.cos(a) * rr, m + Math.sin(a) * rr]);
      }
    } else if (kind === "heart") {
      for (let i = 0; i <= 40; i++) {
        const t = (i / 40) * TAU;
        const x = 16 * Math.sin(t) ** 3;
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        pts.push([m + (x * r) / 17, m + (y * r) / 17 + r * 0.05]);
      }
    } else if (kind === "dot") {
      const start = rand(0, TAU);
      for (let i = 0; i <= 30; i++) {
        const a = start + (i / 28) * TAU;      // dépasse un peu : on referme comme à la main
        pts.push([m + Math.cos(a) * r * 0.8, m + Math.sin(a) * r * 0.8]);
      }
    } else if (kind === "spiral") {
      for (let i = 0; i <= 60; i++) {
        const a = (i / 60) * TAU * 2.3, rr = (i / 60) * r;
        pts.push([m + Math.cos(a) * rr, m + Math.sin(a) * rr]);
      }
    } else {                                   // vague
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        pts.push([m - r + 2 * r * t, m + Math.sin(t * TAU * 1.5) * r * 0.35]);
      }
    }
    const filled = kind === "star" || kind === "heart" || kind === "dot";
    if (filled) {
      ctx.fillStyle = color;
      tracePath(ctx, pts.map(([x, y]) => [x + 1.5, y + 1.5]), true);   // couleur un peu à côté du trait
      ctx.fill();
    }
    sketchLine(ctx, pts, filled ? INK : color, filled ? 1.8 : 3, 0.5, filled ? 2 : 1);
    return c;
  }

  // --------------------------------------------------------------------------
  // ARRIÈRE-PLAN : feuille quadrillée + petits gribouillis qui flottent
  // (remplace le ciel étoilé de final.py, même rôle : décor animé)
  // --------------------------------------------------------------------------
  class Background {
    constructor() {
      this.t = 0;
      const [base, ctx] = makeCanvas(WIDTH, HEIGHT);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = "rgba(70,130,210,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 15; x < WIDTH; x += 30) { ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); }
      for (let y = 15; y < HEIGHT; y += 30) { ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); }
      ctx.stroke();
      ctx.strokeStyle = "rgba(232,85,100,0.35)";           // marge de cahier
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(36, 0); ctx.lineTo(36, HEIGHT); ctx.stroke();
      this.base = base;

      const kinds = ["star", "star", "heart", "dot", "spiral", "wave"];
      this.doodles = [];
      for (let i = 0; i < 26; i++) {
        const size = randInt(14, 34);
        this.doodles.push({
          sprite: makeDoodle(choice(kinds), size, choice(PASTELS)),
          size: size + 10,
          x: rand(0, WIDTH), y: rand(0, HEIGHT),
          vy: rand(6, 16), sway: rand(6, 18),
          freq: rand(0.3, 0.9), phase: rand(0, TAU),
          tilt: rand(0.1, 0.35),
        });
      }
    }

    update(dt) {
      this.t += dt;
      for (const p of this.doodles) {
        p.y -= p.vy * dt;
        if (p.y < -p.size) {
          p.y = HEIGHT + p.size;
          p.x = rand(0, WIDTH);
        }
      }
    }

    draw(ctx) {
      ctx.drawImage(this.base, 0, 0, WIDTH, HEIGHT);
      ctx.save();
      ctx.globalAlpha = 0.75;
      for (const p of this.doodles) {
        const wave = Math.sin(this.t * p.freq + p.phase);
        ctx.save();
        ctx.translate(p.x + wave * p.sway, p.y);
        ctx.rotate(wave * p.tilt);
        ctx.drawImage(p.sprite, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // FLASQUE (physique + rendu verre)
  // --------------------------------------------------------------------------
  /** Contour de haut-gauche à haut-droit par le fond bombé ; hl = portion qui reçoit le reflet. */
  function buildFlaskPath() {
    const cx = FLASK_CX;
    const neckX = FLASK_NECK_W / 2;
    const bodyX = FLASK_BODY_W / 2;
    const yNeckEnd = FLASK_TOP + FLASK_NECK_H;
    const yShoulderEnd = yNeckEnd + FLASK_SHOULDER_H;

    const arcCy = Math.max(FLASK_BOTTOM - FLASK_BOTTOM_DEPTH * bodyX, yShoulderEnd);
    const ry = FLASK_BOTTOM - arcCy;

    const left = [[cx - neckX, FLASK_TOP], [cx - neckX, yNeckEnd]];
    const n = 18;                       // épaulement : courbe en S
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const s = t * t * (3 - 2 * t);
      left.push([cx - lerp(neckX, bodyX, s), lerp(yNeckEnd, yShoulderEnd, t)]);
    }
    const shoulderEndIdx = left.length - 1;
    if (arcCy > yShoulderEnd) left.push([cx - bodyX, arcCy]);   // corps droit
    const m = 28;                       // fond : de pi (gauche) à pi/2 (point le plus bas)
    for (let i = 1; i <= m; i++) {
      const a = Math.PI - (Math.PI / 2) * i / m;
      left.push([cx + bodyX * Math.cos(a), arcCy + ry * Math.sin(a)]);
    }
    const right = left.slice(0, -1).reverse().map(([x, y]) => [2 * cx - x, y]);
    const path = left.concat(right);
    const hl = [shoulderEndIdx + 1, left.length - 1 - Math.floor(m * 0.40)];
    return { path, hl };
  }

  class Flask {
    constructor(world) {
      const { path, hl } = buildFlaskPath();
      this.path = path;
      this.highlight = hl;
      this.neckInnerHalf = FLASK_NECK_W / 2 - WALL_RADIUS;
      // paroi physique = surface intérieure du verre (les segments pymunk avaient un rayon WALL_RADIUS)
      const inner = offsetPath(path, WALL_RADIUS);
      const ground = world.createBody();
      ground.createFixture(new Chain(inner.map(([x, y]) => Vec2(x / SCALE, y / SCALE)), false), {
        friction: EFFECTIVE_FRICTION, restitution: RESTITUTION,
      });
    }

    /** Couches du verre, dessinées une seule fois (sans coût pendant la simulation). */
    static render(path, hl) {
      // arrière : lavis d'aquarelle bleu dans la flasque (deux couches un peu décalées)
      const [back, bctx] = makeCanvas(WIDTH, HEIGHT);
      bctx.fillStyle = "rgba(169,212,255,0.20)";
      tracePath(bctx, path, true); bctx.fill();
      bctx.fillStyle = "rgba(169,212,255,0.14)";
      tracePath(bctx, offsetPath(path, 14).map(([x, y]) => [x + 3, y + 4]), true); bctx.fill();

      // avant : verre bleuté cerné au crayon, reflets en traits blancs
      const [front, ctx] = makeCanvas(WIDTH, HEIGHT);
      strokePolyline(ctx, path, "rgba(169,212,255,0.6)", WALL_RADIUS * 2);
      sketchLine(ctx, offsetPath(path, WALL_RADIUS), INK, 2.6, 0.8, 2);
      sketchLine(ctx, offsetPath(path, -WALL_RADIUS), INK, 2.6, 0.8, 2);

      // collerette du goulot
      const nx = FLASK_NECK_W / 2;
      const lipW = WALL_RADIUS * 2 + 14;
      for (const x of [FLASK_CX - nx - lipW / 2, FLASK_CX + nx - lipW / 2]) {
        ctx.beginPath(); ctx.roundRect(x, FLASK_TOP - 9, lipW, 14, 7);
        ctx.fillStyle = "#cfe6ff"; ctx.fill();
        ctx.lineWidth = 2.5; ctx.strokeStyle = INK; ctx.stroke();
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.roundRect(x + 1.5, FLASK_TOP - 8, lipW - 1, 13, 7); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // reflets : longue traînée à gauche, plus courte à droite (en pointillés de craie)
      const [i0, i1] = hl;
      const far = offsetPath(path, WALL_RADIUS + 13);
      const leftHl = far.slice(i0, i1);
      const rightHl = [];
      for (let j = i0; j < i0 + Math.floor((i1 - i0) / 2); j++) rightHl.push(far[far.length - 1 - j]);
      ctx.save();
      ctx.setLineDash([26, 12, 6, 12]);
      strokePolyline(ctx, leftHl, "rgba(255,255,255,0.95)", 5);
      strokePolyline(ctx, rightHl, "rgba(255,255,255,0.85)", 4);
      ctx.restore();
      const [sx, sy] = far[Math.max(0, i0 - 7)];      // petit éclat sur l'épaulement
      sketchLine(ctx, [[sx - 6, sy], [sx + 6, sy]], "#fff", 3, 0.3, 1);
      sketchLine(ctx, [[sx, sy - 6], [sx, sy + 6]], "#fff", 3, 0.3, 1);
      return { back, front };
    }
  }

  // --------------------------------------------------------------------------
  // BALLE
  // --------------------------------------------------------------------------
  class Ball {
    constructor(world, level, pos, vel = [0, 0], angle = 0, angularVelocity = 0) {
      this.level = level;
      this.radius = TYPES[level].radius;
      this.body = world.createBody({
        type: "dynamic",
        position: Vec2(pos[0] / SCALE, pos[1] / SCALE),
        linearVelocity: Vec2(vel[0] / SCALE, vel[1] / SCALE),
        angle,
        angularVelocity,
      });
      // densité uniforme -> masse proportionnelle à l'aire, comme final.py
      this.body.createFixture(new Circle(this.radius / SCALE), {
        density: 1, friction: EFFECTIVE_FRICTION, restitution: RESTITUTION,
      });
    }

    get x() { return this.body.getPosition().x * SCALE; }
    get y() { return this.body.getPosition().y * SCALE; }
    get vx() { return this.body.getLinearVelocity().x * SCALE; }
    get vy() { return this.body.getLinearVelocity().y * SCALE; }
    get mass() { return this.body.getMass(); }

    remove(world) { world.destroyBody(this.body); }

    draw(ctx, sprites) {
      const d = this.radius * 2;
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.body.getAngle());    // y vers le bas : angle positif = sens horaire, comme pymunk
      ctx.drawImage(sprites[this.level], -this.radius, -this.radius, d, d);
      ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // SIMULATION
  // --------------------------------------------------------------------------
  class Simulation {
    constructor(voices) {
      this.voices = voices;
      this.sprites = TYPES.map((t) => makeFallback(t.radius, t.color));
      this.background = new Background();
      const { path, hl } = buildFlaskPath();
      this.glass = Flask.render(path, hl);
      this.speedIndex = 0;              // conservé après un reset
      this.reset();
    }

    reset() {
      // allowSleep: false -> une balle posée se réveille toujours quand sa voisine fusionne
      this.world = new World({ gravity: Vec2(0, GRAVITY / SCALE), allowSleep: false });
      this.balls = [];
      this.score = 0;
      this.spawnTimer = 0;
      this.fullTimer = 0;
      this.flask = new Flask(this.world);
    }

    /** Lâche une balle au-dessus du goulot. Retourne false si la place n'est pas libre. */
    spawn(x = null, level = null) {
      if (level === null) level = choice(SPAWNABLE);
      const r = TYPES[level].radius;
      const half = Math.max(0, this.flask.neckInnerHalf - r);
      if (x === null) x = rand(FLASK_CX - half, FLASK_CX + half);
      x = Math.max(FLASK_CX - half, Math.min(FLASK_CX + half, x));
      const y = Math.max(r + 2, FLASK_TOP - r - 2);

      // goulot bouché ? on n'ajoute rien par-dessus une autre balle
      for (const b of this.balls) {
        if (Math.hypot(b.x - x, b.y - y) - b.radius <= r + 2) return false;
      }
      this.balls.push(new Ball(this.world, level, [x, y], [0, 0], rand(0, TAU), rand(-3, 3)));
      if (SOUND_ON_SPAWN) this.voices.play(level, false);   // ne coupe jamais une fusion
      return true;
    }

    /** Détecte les balles du même type en contact et les fusionne. */
    mergePass() {
      const toRemove = new Set();
      const toAdd = [];
      const n = this.balls.length;
      const last = TYPES.length - 1;
      for (let i = 0; i < n; i++) {
        if (toRemove.has(i)) continue;
        const a = this.balls[i];
        for (let j = i + 1; j < n; j++) {
          const b = this.balls[j];
          if (toRemove.has(j) || a.level !== b.level) continue;
          if (!MERGE_LAST_TYPE && a.level === last) continue;
          const ax = a.x, ay = a.y, bx = b.x, by = b.y;
          if (Math.hypot(ax - bx, ay - by) <= a.radius + b.radius + MERGE_TOLERANCE) {
            toRemove.add(i); toRemove.add(j);
            const ma = a.mass, mb = b.mass, total = ma + mb;
            // le nouveau est au barycentre, avec la quantité de mouvement conservée
            const pos = [(ax * ma + bx * mb) / total, (ay * ma + by * mb) / total];
            const vel = [(a.vx * ma + b.vx * mb) / total, (a.vy * ma + b.vy * mb) / total];
            const angVel = (a.body.getAngularVelocity() + b.body.getAngularVelocity()) / 2;
            const angle = a.body.getAngle();
            if (a.level + 1 < TYPES.length) toAdd.push([a.level + 1, pos, vel, angle, angVel]);
            const soundLevel = SOUND_OF_CREATED_FRUIT ? a.level + 1 : a.level;
            if (soundLevel < TYPES.length) this.voices.play(soundLevel);
            this.score += (a.level + 1) * 10;
            break;
          }
        }
      }
      if (toRemove.size) {
        [...toRemove].sort((p, q) => q - p).forEach((idx) => {
          this.balls[idx].remove(this.world);
          this.balls.splice(idx, 1);
        });
        for (const [level, pos, vel, angle, angVel] of toAdd) {
          this.balls.push(new Ball(this.world, level, pos, vel, angle, angVel));
        }
      }
    }

    /** Supprime les balles éjectées hors de l'écran. */
    cleanup() {
      this.balls = this.balls.filter((b) => {
        const out = b.y > HEIGHT + 300 || b.x < -300 || b.x > WIDTH + 300;
        if (out) b.remove(this.world);
        return !out;
      });
    }

    get speed() { return SPEED_LEVELS[this.speedIndex]; }

    cycleSpeed() { this.speedIndex = (this.speedIndex + 1) % SPEED_LEVELS.length; }

    update(dt) {
      // Vitesse x N : on rejoue N fois le même pas de temps (au lieu d'agrandir dt),
      // donc la physique reste aussi stable qu'à vitesse normale.
      for (let k = 0; k < this.speed; k++) {
        for (let s = 0; s < SUBSTEPS; s++) this.world.step(dt / SUBSTEPS, 10, 4);
        this.mergePass();
        this.cleanup();
      }
      this.background.update(dt);
      const simDt = dt * this.speed;

      if (AUTO_SPAWN) {
        this.spawnTimer += simDt;
        if (this.spawnTimer >= AUTO_SPAWN_DELAY && this.spawn(null, AUTO_SPAWN_LEVEL)) {
          this.spawnTimer = 0;
        }
      }

      // flasque pleine : une balle reste immobile dans la zone du goulot -> on recommence
      if (RESTART_WHEN_FULL) {
        const fillY = FLASK_TOP + FLASK_NECK_H;
        const clogged = this.balls.some((b) => b.y < fillY && Math.hypot(b.vx, b.vy) < 60);
        this.fullTimer = clogged ? this.fullTimer + simDt : 0;
        if (this.fullTimer >= FULL_DELAY) this.reset();
      }
    }

    draw(ctx) {
      this.background.draw(ctx);
      ctx.drawImage(this.glass.back, 0, 0, WIDTH, HEIGHT);
      for (const ball of this.balls) ball.draw(ctx, this.sprites);
      ctx.drawImage(this.glass.front, 0, 0, WIDTH, HEIGHT);

      ctx.textBaseline = "middle";
      const label = (text, y, size, marker) => {
        ctx.font = `${size}px ${HAND_FONT}`;
        const w = ctx.measureText(text).width;
        ctx.save();
        ctx.fillStyle = marker;                  // coup de surligneur légèrement penché
        ctx.translate(16, y);
        ctx.rotate(-0.02);
        ctx.fillRect(-4, -size * 0.12, w + 12, size * 0.5);
        ctx.restore();
        ctx.fillStyle = INK;
        ctx.fillText(text, 18, y);
      };
      label(`Score : ${this.score}`, 30, 34, "rgba(255,224,102,0.85)");
      if (this.speed > 1) label(`Vitesse x${this.speed}`, 66, 26, "rgba(255,168,201,0.85)");
    }
  }

  // --------------------------------------------------------------------------
  // PAGE : canvas, contrôles, choix du pack
  // --------------------------------------------------------------------------
  const PACK_KEY = "patate.pack";

  function storedPack() {
    try { return localStorage.getItem(PACK_KEY); } catch (_) { return null; }
  }

  function storePack(id) {
    try { localStorage.setItem(PACK_KEY, id); } catch (_) { /* navigation privée */ }
  }

  function main() {
    const canvas = document.getElementById("game");
    canvas.width = WIDTH * RES;
    canvas.height = HEIGHT * RES;
    const ctx = canvas.getContext("2d");
    ctx.scale(RES, RES);

    const voices = new window.PatateVoices();
    const sim = new Simulation(voices);
    const ui = {
      overlay: document.getElementById("start"),
      select: document.getElementById("pack"),
      auto: document.getElementById("btn-auto"),
      sound: document.getElementById("btn-sound"),
      speed: document.getElementById("speed"),
    };
    // boutons de vitesse x1 x2 x4 ... (la touche F les fait défiler, comme final.py)
    const speedButtons = SPEED_LEVELS.map((level, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `x${level}`;
      b.addEventListener("click", () => { sim.speedIndex = i; refreshButtons(); });
      ui.speed.appendChild(b);
      return b;
    });
    let currentPack = null;
    let running = false;

    function refreshButtons() {
      ui.auto.setAttribute("aria-checked", String(AUTO_SPAWN));
      ui.sound.setAttribute("aria-checked", String(!voices.muted));
      speedButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === sim.speedIndex)));
    }

    async function usePack(id) {
      let pack;
      try {
        const res = await fetch(`/api/packs/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(res.status);
        pack = await res.json();
      } catch (_) {
        if (id !== "fruits") return usePack("fruits");
        return;
      }
      currentPack = pack;
      storePack(pack.id);
      ui.select.value = pack.id;
      sim.sprites = await loadSprites(pack);
      await voices.load(pack.levels.map((l) => l.sound_url));
    }

    async function initPacks() {
      const wanted = new URLSearchParams(location.search).get("pack") || storedPack() || "fruits";
      try {
        const packs = await (await fetch("/api/packs")).json();
        ui.select.innerHTML = "";
        for (const p of packs) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.private ? `🔒 ${p.name}` : p.name;
          ui.select.appendChild(opt);
        }
        await usePack(packs.some((p) => p.id === wanted) ? wanted : "fruits");
      } catch (err) {
        console.warn("Packs indisponibles, balles de secours", err);
      }
    }

    function toLogical(evt) {
      const rect = canvas.getBoundingClientRect();
      return [(evt.clientX - rect.left) * WIDTH / rect.width, (evt.clientY - rect.top) * HEIGHT / rect.height];
    }

    function start() {
      if (running) return;
      voices.unlock();
      if (currentPack) voices.load(currentPack.levels.map((l) => l.sound_url));
      ui.overlay.hidden = true;
      running = true;
      let last = performance.now();
      const frame = (now) => {
        const dt = Math.min((now - last) / 1000, 1 / 30);   // évite les gros sauts si l'onglet rame
        last = now;
        if (dt > 0) sim.update(dt);
        sim.draw(ctx);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    ui.overlay.addEventListener("click", start);
    canvas.addEventListener("pointerdown", (evt) => {
      if (!running) return start();
      if (evt.button !== 0) return;
      sim.spawn(toLogical(evt)[0]);
    });
    document.getElementById("btn-drop").addEventListener("click", () => running ? sim.spawn() : start());
    ui.auto.addEventListener("click", () => { AUTO_SPAWN = !AUTO_SPAWN; refreshButtons(); });
    document.getElementById("btn-reset").addEventListener("click", () => sim.reset());
    ui.sound.addEventListener("click", () => { voices.muted = !voices.muted; voices.stop(); refreshButtons(); });
    ui.select.addEventListener("change", () => { ui.select.blur(); usePack(ui.select.value); });

    window.addEventListener("keydown", (evt) => {
      // un bouton ou la liste ont le focus : leur propre comportement clavier s'applique
      if (evt.target.closest && evt.target.closest("button, select, input, a")) return;
      if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
      const key = evt.key.toLowerCase();
      if (key === " " || key === "enter") {
        evt.preventDefault();
        running ? sim.spawn() : start();
      } else if (key === "a") {
        AUTO_SPAWN = !AUTO_SPAWN;
      } else if (key === "f") {
        sim.cycleSpeed();
      } else if (key === "r") {
        sim.reset();
      } else {
        return;
      }
      refreshButtons();
    });

    // après un clic de souris sur un bouton, on rend le focus à la page pour garder les raccourcis
    // clavier (un bouton activé au clavier garde son focus)
    document.querySelectorAll(".launcher button").forEach((b) => b.addEventListener("click", (evt) => {
      if (evt.detail > 0) b.blur();
    }));
    refreshButtons();
    sim.draw(ctx);                      // image fixe derrière l'écran de démarrage
    initPacks().then(() => { if (!running) sim.draw(ctx); });
    if (document.fonts) {                // l'écriture à la main du score, dès que la police est là
      document.fonts.load(`34px ${HAND_FONT}`).then(() => { if (!running) sim.draw(ctx); }).catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", main);
})();
