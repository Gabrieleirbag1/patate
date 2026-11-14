/*
 * Simulation de balles qui rebondissent et fusionnent (port web de final.py).
 *
 * - Une flasque en verre à fond bombé contient les balles.
 * - La plus petite balle tombe automatiquement par le goulot à intervalle régulier.
 * - Deux balles du même type qui se touchent fusionnent en une plus grosse.
 * - À chaque fusion, le son du niveau est joué (voir audio.js).
 * - Une image PNG transparente garde sa silhouette : elle est dessinée telle quelle et
 *   rebondit selon sa forme (enveloppe convexe des pixels opaques), pas selon un cercle.
 * - Effet « slime » : les patates s'écrasent sous les chocs, s'affaissent un peu au repos
 *   et se tordent quand elles tournent (déformation visuelle, la forme physique reste rigide).
 *
 * Physique : Planck.js (Box2D). Le dessin se fait en pixels, la physique en mètres (SCALE).
 *
 * Contrôles : clic/toucher = lâcher une balle, Espace = lâcher, A = spawn auto,
 *             F = vitesse (x1 -> x2 -> ... -> x10 -> x1), R = réinitialiser.
 */
(function () {
  "use strict";

  const { World, Vec2, Circle, Polygon, Chain } = planck;

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
  const RESTITUTION = BALL_ELASTICITY * WALL_ELASTICITY;   // 0.5625 (rebond de final.py)
  const EFFECTIVE_FRICTION = FRICTION * FRICTION;          // 0.36

  // Slime : rebond plus mou et un peu plus collant que final.py (remettre RESTITUTION et
  // EFFECTIVE_FRICTION ici pour retrouver le comportement d'origine).
  const SLIME_RESTITUTION = 0.35;
  const SLIME_FRICTION = 0.45;

  // Déformation visuelle « slime » (ressorts amortis, en fraction de la taille)
  const JELLY = {
    maxSquash: 0.14,       // écrasement maximal (14 %)
    maxTwist: 0.16,        // torsion maximale (cisaillement)
    sag: 0.035,            // affaissement au repos, sous son propre poids
    impact: 0.0012,        // vitesse d'écrasement par px/s de choc (grosse chute ≈ 10 %)
    twist: 0.22,           // vitesse de torsion par rad/s de changement de rotation
    squashFreq: 15,        // rad/s : vitesse du « boing »
    squashDamping: 0.22,
    twistFreq: 11,
    twistDamping: 0.18,
  };

  // Lecture de la transparence des images
  const ALPHA_SOLID = 160;        // pixel considéré comme plein (évite les halos doux)
  const MIN_TRANSPARENT = 0.08;   // au moins 8 % de pixels transparents -> silhouette du PNG
  const MAX_HULL_VERTICES = 12;   // limite de Planck pour un polygone
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

  const circleShape = (r) => ({ type: "circle", r, bound: r });

  /** Enveloppe convexe (chaîne monotone d'Andrew), sens horaire à l'écran. */
  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  /** Réduit un polygone convexe à `max` sommets en retirant ceux qui comptent le moins (Visvalingam). */
  function simplifyPolygon(poly, max) {
    const pts = poly.slice();
    const area = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    while (pts.length > max) {
      let best = 0, bestArea = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = area(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]);
        if (a < bestArea) { bestArea = a; best = i; }
      }
      pts.splice(best, 1);
    }
    return pts;
  }

  const polygonArea = (poly) => Math.abs(poly.reduce((acc, [x, y], i) => {
    const [x2, y2] = poly[(i + 1) % poly.length];
    return acc + x * y2 - x2 * y;
  }, 0)) / 2;

  /** Min (érosion) ou max (dilatation) sur un carré de côté 2k+1, en deux passes séparées. */
  function morph(mask, w, h, k, grow) {
    const pass = (src, horizontal) => {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = grow ? 0 : 1;
          for (let d = -k; d <= k; d++) {
            const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
            const inside = xx >= 0 && yy >= 0 && xx < w && yy < h;
            const m = inside ? src[yy * w + xx] : 0;
            v = grow ? (v | m) : (v & m);
          }
          out[y * w + x] = v;
        }
      }
      return out;
    };
    return pass(pass(mask, true), false);
  }

  const morphOpen = (mask, w, h, k) => morph(morph(mask, w, h, k, false), w, h, k, true);

  /** Lit la transparence d'une image (réduite à 128 px) : part de pixels transparents,
   *  cadre des pixels opaques et enveloppe convexe de leur contour. null si illisible. */
  function analyzeImage(img) {
    const k = 128 / Math.max(img.naturalWidth, img.naturalHeight, 1);
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    let data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (_) {
      return null;                         // image d'une autre origine : on garde un cercle
    }
    const full = new Uint8Array(w * h);
    let clear = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * 4 + 3];
        if (a < 128) clear++;
        if (a < ALPHA_SOLID) continue;
        full[y * w + x] = 1;
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;               // image entièrement transparente

    // Forme physique : on retire d'abord les détails fins (tige, feuille, mèche de cheveux)
    // par une « ouverture » (érosion puis dilatation), pour ne pas rebondir sur une tige.
    let core = morphOpen(full, w, h, 8);
    if (!core.some((v) => v)) core = full;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && core[y * w + x] === 1;
    const edge = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (solid(x, y) && (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1))) {
          edge.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
        }
      }
    }
    return {
      transparent: clear / (w * h) > MIN_TRANSPARENT,
      k,
      box: { x0, y0, x1: x1 + 1, y1: y1 + 1 },
      hull: convexHull(edge),
    };
  }

  /** PNG transparent : image recadrée sur ses pixels opaques, proportions gardées, tenant
   *  dans le carré du niveau ; forme physique = enveloppe convexe (au plus 12 sommets). */
  function makeCutout(img, info, radius) {
    const d = radius * 2;
    const { x0, y0, x1, y1 } = info.box;
    const bw = x1 - x0, bh = y1 - y0;
    const scale = d / Math.max(bw, bh);        // pixels écran par pixel d'analyse
    const dw = bw * scale, dh = bh * scale;
    const [c, ctx] = makeCanvas(d, d);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x0 / info.k, y0 / info.k, bw / info.k, bh / info.k, radius - dw / 2, radius - dh / 2, dw, dh);

    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let verts = info.hull.map(([x, y]) => [(x - cx) * scale, (y - cy) * scale]);
    verts = simplifyPolygon(verts, MAX_HULL_VERTICES)
      .filter((v, i, all) => Math.hypot(v[0] - all[(i + 1) % all.length][0], v[1] - all[(i + 1) % all.length][1]) > 1);
    const area = verts.length >= 3 ? polygonArea(verts) : 0;
    if (area < 0.15 * Math.PI * radius * radius) {          // forme trop fine : un cercle est plus sûr
      return { sprite: c, shape: circleShape(radius) };
    }
    const bound = Math.max(...verts.map(([x, y]) => Math.hypot(x, y)));
    return { sprite: c, shape: { type: "poly", verts, bound } };
  }

  /** Apparence + forme d'un niveau. Photo opaque : cercle (découpée si crop_circle),
   *  PNG transparent : sa silhouette, sans contour ni cercle. */
  function makeLook(img, type, cropCircle) {
    const r = type.radius;
    if (!img) return { sprite: makeFallback(r, type.color), shape: circleShape(r) };
    const info = analyzeImage(img);
    if (info && info.transparent) return makeCutout(img, info, r);
    return { sprite: makeSprite(img, r, cropCircle), shape: circleShape(r) };
  }

  async function loadLooks(pack) {
    const images = await Promise.all(pack.levels.map((l) => loadImage(l.image_url)));
    return TYPES.map((t, i) => makeLook(images[i], t, pack.crop_circle));
  }

  const defaultLooks = () => TYPES.map((t) => ({ sprite: makeFallback(t.radius, t.color), shape: circleShape(t.radius) }));

  // --------------------------------------------------------------------------
  // STYLE « CARNET À DESSIN » : traits de crayon, couleurs de surligneur
  // --------------------------------------------------------------------------
  const INK = "#2c2a35";
  const STAGE_PAPER = "#e8f6ec";        // même couleur que --stage-paper dans style.css
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
      // papier menthe à pois : se distingue du cahier quadrillé du reste du site
      ctx.fillStyle = STAGE_PAPER;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "rgba(40,120,80,0.22)";
      for (let x = 15; x < WIDTH; x += 30) {
        for (let y = 15; y < HEIGHT; y += 30) {
          ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
        }
      }
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
      const wall = { friction: SLIME_FRICTION, restitution: SLIME_RESTITUTION };
      ground.createFixture(new Chain(inner.map(([x, y]) => Vec2(x / SCALE, y / SCALE)), false), wall);
      // segments de la paroi intérieure + normale vers l'intérieur, pour wallDistance()
      this.segments = [];
      for (let i = 0; i < inner.length - 1; i++) {
        const [x0, y0] = inner[i], [x1, y1] = inner[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        this.segments.push({ x0, y0, dx: (x1 - x0) / len, dy: (y1 - y0) / len, len });
      }
    }

    /** Point de la paroi le plus proche de (x, y), normale vers l'intérieur et distance signée
     *  (positive à l'intérieur de la flasque, négative de l'autre côté du verre). */
    wallDistance(x, y) {
      let best = null;
      for (const g of this.segments) {
        const t = Math.max(0, Math.min(g.len, (x - g.x0) * g.dx + (y - g.y0) * g.dy));
        const qx = g.x0 + g.dx * t, qy = g.y0 + g.dy * t;
        const d = Math.hypot(x - qx, y - qy);
        if (!best || d < best.d) best = { d, qx, qy, nx: g.dy, ny: -g.dx };
      }
      best.signed = (x - best.qx) * best.nx + (y - best.qy) * best.ny;
      return best;
    }

    /** Décale vers l'intérieur une forme de rayon englobant `bound` qui chevaucherait le verre. */
    keepInside(x, y, bound) {
      const w = this.wallDistance(x, y);
      if (w.signed >= bound) return [x, y];
      const push = bound - w.signed;
      return [x + w.nx * push, y + w.ny * push];
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
  /** Ressort amorti : x tend vers target ; retourne la nouvelle vitesse. */
  function spring(x, v, target, freq, damping, dt) {
    const a = -freq * freq * (x - target) - 2 * damping * freq * v;
    return v + a * dt;
  }
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));

  /** Avance un ressort d'un pas ; en butée, la vitesse vers l'extérieur est annulée
   *  (sinon la déformation resterait collée à sa limite). Retourne [x, v]. */
  function stepSpring(x, v, target, freq, damping, max, dt) {
    v = spring(x, v, target, freq, damping, dt);
    x += v * dt;
    if (Math.abs(x) > max) {
      x = Math.sign(x) * max;
      if (v * x > 0) v = 0;
    }
    return [x, v];
  }

  class Ball {
    constructor(world, level, shape, pos, vel = [0, 0], angle = 0, angularVelocity = 0) {
      this.level = level;
      this.radius = TYPES[level].radius;         // demi-côté du carré où l'image est dessinée
      this.body = world.createBody({
        type: "dynamic",
        position: Vec2(pos[0] / SCALE, pos[1] / SCALE),
        linearVelocity: Vec2(vel[0] / SCALE, vel[1] / SCALE),
        angle,
        angularVelocity,
      });
      this.body.setUserData(this);
      this.fixture = null;
      this.setShape(shape);
      // état « slime » : écrasement (squash) le long d'un axe, torsion (twist)
      this.squash = 0; this.squashV = 0; this.axis = -Math.PI / 2;
      this.twist = 0; this.twistV = 0;
      this.prevV = [vel[0], vel[1]];
      this.prevW = angularVelocity;
    }

    /** Forme physique : cercle, ou silhouette du PNG (densité uniforme -> masse ∝ aire). */
    setShape(shape) {
      if (this.fixture) this.body.destroyFixture(this.fixture);
      const geom = shape.type === "poly"
        ? new Polygon(shape.verts.map(([x, y]) => Vec2(x / SCALE, y / SCALE)))
        : new Circle(shape.r / SCALE);
      this.fixture = this.body.createFixture(geom, {
        density: 1, friction: SLIME_FRICTION, restitution: SLIME_RESTITUTION,
      });
      this.bound = shape.bound;                  // rayon qui englobe la forme
    }

    get x() { return this.body.getPosition().x * SCALE; }
    get y() { return this.body.getPosition().y * SCALE; }
    get vx() { return this.body.getLinearVelocity().x * SCALE; }
    get vy() { return this.body.getLinearVelocity().y * SCALE; }
    get mass() { return this.body.getMass(); }

    remove(world) { world.destroyBody(this.body); }

    /** « Boing » d'une patate qui vient de naître d'une fusion. */
    pop() {
      this.squashV = -2.0;
      this.twistV = rand(-1.2, 1.2);
    }

    /** Déformation slime, une fois par image affichée (temps réel `dt`, temps simulé `simDt`).
     *  On regarde l'accélération due aux contacts (variation de vitesse moins la gravité) :
     *  au repos elle vaut juste la gravité -> léger affaissement ; un choc -> gros écrasement. */
    jelly(dt, simDt) {
      const vx = this.vx, vy = this.vy, w = this.body.getAngularVelocity();
      const ax = (vx - this.prevV[0]) / simDt;
      const ay = (vy - this.prevV[1]) / simDt - GRAVITY;
      const accel = Math.hypot(ax, ay);
      this.prevV = [vx, vy];
      // choc = accélération au-delà de « posé sur quelque chose »
      const shock = Math.max(0, accel - 1.5 * GRAVITY) * simDt;     // en px/s
      if (accel > 0.5 * GRAVITY) {
        const target = Math.atan2(ay, ax);                            // direction de la poussée
        const diff = Math.atan2(Math.sin(target - this.axis), Math.cos(target - this.axis));
        this.axis += diff * Math.min(1, shock > 0 ? 1 : 6 * dt);
      }
      this.squashV += shock * JELLY.impact;
      const rest = Math.min(accel, 2 * GRAVITY) / GRAVITY * JELLY.sag;
      [this.squash, this.squashV] = stepSpring(this.squash, this.squashV, rest, JELLY.squashFreq,
        JELLY.squashDamping, JELLY.maxSquash, dt);

      const dw = w - this.prevW;
      this.prevW = w;
      this.twistV += dw * JELLY.twist + Math.sign(dw || 1) * shock * JELLY.impact * 0.8;
      [this.twist, this.twistV] = stepSpring(this.twist, this.twistV, 0, JELLY.twistFreq,
        JELLY.twistDamping, JELLY.maxTwist, dt);
    }

    draw(ctx, looks) {
      const d = this.radius * 2;
      const s = this.squash;
      ctx.save();
      ctx.translate(this.x, this.y);
      // écrasement le long de l'axe du choc (aire à peu près conservée)
      ctx.rotate(this.axis);
      ctx.scale(1 - s, 1 / (1 - s));
      ctx.rotate(-this.axis);
      ctx.rotate(this.body.getAngle());     // y vers le bas : angle positif = sens horaire, comme pymunk
      ctx.transform(1, 0, this.twist, 1, 0, 0);   // torsion : le haut et le bas partent en sens opposés
      ctx.drawImage(looks[this.level].sprite, -this.radius, -this.radius, d, d);
      ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // SIMULATION
  // --------------------------------------------------------------------------
  class Simulation {
    constructor(voices) {
      this.voices = voices;
      this.looks = defaultLooks();      // image + forme physique de chaque niveau
      this.background = new Background();
      const { path, hl } = buildFlaskPath();
      this.glass = Flask.render(path, hl);
      this.speedIndex = 0;              // conservé après un reset
      this.reset();
    }

    /** Nouveau pack : nouvelles images, et nouvelles formes pour les balles déjà là. */
    setLooks(looks) {
      this.looks = looks;
      for (const b of this.balls) b.setShape(looks[b.level].shape);
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
      const shape = this.looks[level].shape;

      // goulot bouché ? on n'ajoute rien par-dessus une autre balle
      for (const b of this.balls) {
        if (Math.hypot(b.x - x, b.y - y) - b.bound <= shape.bound + 2) return false;
      }
      this.balls.push(new Ball(this.world, level, shape, [x, y], [0, 0], rand(0, TAU), rand(-3, 3)));
      if (SOUND_ON_SPAWN) this.voices.play(level, false);   // ne coupe jamais une fusion
      return true;
    }

    /** Fusionne les balles du même type qui se touchent (contacts réels du moteur physique,
     *  donc selon leur vraie forme). Une balle ne fusionne qu'une fois par passe. */
    mergePass() {
      const used = new Set();
      const pairs = [];
      const last = TYPES.length - 1;
      for (let c = this.world.getContactList(); c; c = c.getNext()) {
        if (!c.isTouching()) continue;
        const a = c.getFixtureA().getBody().getUserData();
        const b = c.getFixtureB().getBody().getUserData();
        if (!a || !b || a.level !== b.level || used.has(a) || used.has(b)) continue;
        if (!MERGE_LAST_TYPE && a.level === last) continue;
        used.add(a); used.add(b);
        pairs.push([a, b]);
      }
      if (!pairs.length) return;
      const born = [];
      for (const [a, b] of pairs) {
        const ax = a.x, ay = a.y, bx = b.x, by = b.y;
        const ma = a.mass, mb = b.mass, total = ma + mb;
        // le nouveau est au barycentre, avec la quantité de mouvement conservée
        const pos = [(ax * ma + bx * mb) / total, (ay * ma + by * mb) / total];
        const vel = [(a.vx * ma + b.vx * mb) / total, (a.vy * ma + b.vy * mb) / total];
        const angVel = (a.body.getAngularVelocity() + b.body.getAngularVelocity()) / 2;
        const angle = a.body.getAngle();
        if (a.level + 1 < TYPES.length) born.push([a.level + 1, pos, vel, angle, angVel]);
        const soundLevel = SOUND_OF_CREATED_FRUIT ? a.level + 1 : a.level;
        if (soundLevel < TYPES.length) this.voices.play(soundLevel);
        this.score += (a.level + 1) * 10;
      }
      this.balls = this.balls.filter((b) => {
        if (used.has(b)) b.remove(this.world);
        return !used.has(b);
      });
      for (const [level, pos, vel, angle, angVel] of born) {
        // une forme plus grosse qui naîtrait à cheval sur le verre serait éjectée dehors
        const shape = this.looks[level].shape;
        const inside = pos[1] > FLASK_TOP ? this.flask.keepInside(pos[0], pos[1], shape.bound) : pos;
        const ball = new Ball(this.world, level, shape, inside, vel, angle, angVel);
        ball.pop();
        this.balls.push(ball);
      }
    }

    /** Supprime les balles éjectées hors de l'écran, et remet dans la flasque une balle
     *  qui serait passée de l'autre côté du verre (formes poussées très fort). */
    cleanup() {
      for (const b of this.balls) {
        if (b.y < FLASK_TOP) continue;                 // au-dessus du goulot : elle tombe dedans
        const w = this.flask.wallDistance(b.x, b.y);
        if (w.signed > -2) continue;
        const [x, y] = this.flask.keepInside(b.x, b.y, b.bound);
        const v = b.body.getLinearVelocity();
        const out = v.x * w.nx + v.y * w.ny;          // on annule la vitesse vers l'extérieur
        b.body.setTransform(Vec2(x / SCALE, y / SCALE), b.body.getAngle());
        if (out < 0) b.body.setLinearVelocity(Vec2(v.x - out * w.nx, v.y - out * w.ny));
      }
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
      for (const b of this.balls) b.jelly(dt, simDt);     // temps réel : pas de stroboscope en x10

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
      for (const ball of this.balls) ball.draw(ctx, this.looks);
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
      sim.setLooks(await loadLooks(pack));
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
