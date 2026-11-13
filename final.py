"""
Simulation de balles qui rebondissent et fusionnent (style Suika / vidéos virales).

Installation :
    pip install pygame pymunk
    pip install gTTS         (optionnel : génère un son manquant, voix en ligne)
    pip install pyttsx3       (optionnel : génère un son manquant, voix hors-ligne)

Principe :
    - Une flasque en verre à fond bombé contient les balles.
    - La plus petite balle tombe automatiquement par le goulot à intervalle régulier.
    - Deux balles du même type qui se touchent fusionnent en une plus grosse.
    - À chaque fusion, le son "<fruit>.mp3" du dossier "sons/" est joué tout de suite
      (il coupe le précédent : jamais de chevauchement). Plus le fruit est gros, plus
      le son est grave (cerise = aigu, pastèque = grave). Désactivable : TTS_ENABLED.
    - Quand une cerise est lâchée, son son est joué aussi, mais seulement si aucun autre
      son n'est en cours (SOUND_ON_SPAWN).

Images :
    Mets un PNG par type dans le dossier "images/" (ou change IMAGE_DIR).
    Si une image manque, une balle colorée avec un visage est générée à la place
    (pratique pour voir la rotation).

Contrôles :
    Clic gauche  : lâcher une balle à la position de la souris (dans le goulot)
    Espace       : lâcher une balle tout de suite
    A            : activer/désactiver le spawn automatique
    F            : accélérer la simulation (x1 -> x2 -> x4 -> x6 -> x8 -> x10 -> x1)
    R            : réinitialiser
    Echap        : quitter
"""

import array
import math
import os
import random
import unicodedata

import pygame
import pymunk

# ----------------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------------
WIDTH, HEIGHT = 800, 900          # taille de la fenêtre (la flasque s'adapte)
FPS = 60
GRAVITY = (0, 1200)               # pixels / s²
IMAGE_DIR = "images"

# Sons : un fichier "<nom du fruit>.mp3" par type, joué à chaque fusion.
# Un seul son à la fois : une nouvelle fusion coupe le son précédent et joue le sien immédiatement.
TTS_ENABLED = True                # False : aucun son
SOUND_DIR = "sons"                # dossier des sons (cherché dans le dossier courant puis à côté du script)
TTS_VOLUME = 1.0                  # 0.0 à 1.0
TRIM_SILENCE = True               # coupe le silence au début du fichier (l'mp3 en ajoute) -> son plus réactif
SOUND_OF_CREATED_FRUIT = True     # True  : son du fruit CRÉÉ     (2 cerises -> "fraise"; "cerise" ne joue jamais)
                                  # False : son du fruit FUSIONNÉ (2 cerises -> "cerise"; "pastèque" ne joue jamais)
SOUND_ON_SPAWN = True             # joue aussi le son du fruit lâché (la cerise, qui n'est jamais "créé" par une fusion).
                                  # Priorité basse : ne coupe jamais le son d'une fusion, et n'est joué que si le canal est libre.

# Hauteur du son selon la taille du fruit (aucune librairie en plus)
# Le plus petit fruit (cerise) = aigu, le plus gros (pastèque) = grave, progression linéaire entre les deux.
# Le décalage se fait en rééchantillonnant : plus c'est grave, plus le son est long (comme un vinyle ralenti).
# Avec 8 fruits, chaque fruit est ~3 demi-tons plus grave que le précédent (réduis l'écart si c'est trop).
PITCH_ENABLED = True
PITCH_SMALL_SEMITONES = +9        # décalage de la cerise    (+12 = une octave plus haut)
PITCH_BIG_SEMITONES = -12         # décalage de la pastèque  (-12 = une octave plus bas)

# Génération automatique d'un son manquant (optionnel, nécessite gTTS ou pyttsx3)
TTS_BACKEND = "gtts"              # "gtts" (en ligne) ou "pyttsx3" (hors-ligne)
TTS_LANG = "fr"
# Prononciation utilisée pour cette génération (le nom du type sert aussi de nom de fichier)
SPOKEN_TEXT = {
    "pasteque": "pastèque",
}

# Un type par ligne : (nom, rayon en pixels, fichier image, couleur de secours)
# L'ordre = l'ordre d'évolution : deux "cerise" donnent une "fraise", etc.
TYPES = [
    ("cerise",     18, "cerise.png",     (220, 50, 70)),
    ("fraise",     26, "fraise.png",     (240, 100, 90)),
    ("raisin",     36, "raisin.png",     (140, 80, 190)),
    ("orange",     48, "orange.png",     (250, 160, 40)),
    ("pomme",      62, "pomme.png",      (120, 200, 70)),
    ("pamplemousse", 78, "pample.png",   (250, 200, 80)),
    ("melon",      96, "melon.png",      (90, 190, 130)),
    ("pasteque",  118, "pasteque.png",   (60, 150, 80)),
]

SPAWNABLE = [0]                   # types lâchés au clic / à la barre espace (0 = la plus petite)
MERGE_LAST_TYPE = False           # True : deux balles du dernier type disparaissent
AUTO_SPAWN = True                 # la plus petite balle tombe toute seule
AUTO_SPAWN_LEVEL = 0              # type lâché automatiquement (0 = la plus petite)
AUTO_SPAWN_DELAY = 1.0            # secondes entre deux balles
                                  # (si le goulot est bouché, le spawn attend qu'il se libère)
RESTART_WHEN_FULL = True          # flasque pleine (balles immobiles dans le goulot) -> on recommence
FULL_DELAY = 3.0                  # secondes d'immobilité avant de considérer la flasque pleine

# Physique
# Attention : pymunk MULTIPLIE les élasticités des deux objets en contact.
# 0.75 x 0.75 = 0.56 de rebond effectif. Monte-les pour plus de rebond (max 1.0).
BALL_ELASTICITY = 0.75
WALL_ELASTICITY = 0.75
FRICTION = 0.6                    # friction -> fait tourner les balles
DENSITY = 0.002                   # masse proportionnelle à l'aire
MERGE_TOLERANCE = 1.5             # px de tolérance pour détecter le contact
SUBSTEPS = 5                      # sous-pas de physique par image (stabilité)
SPEED_LEVELS = [1, 2, 4, 6, 8, 10]  # paliers de vitesse, touche F (après le dernier -> retour à x1)

# Flasque (tout est calculé à partir de ces valeurs)
FLASK_CX = WIDTH / 2              # axe central
FLASK_TOP = 40                    # y du bord du goulot
FLASK_NECK_W = 140                # largeur du goulot
FLASK_NECK_H = 55                 # longueur du goulot droit
FLASK_SHOULDER_H = 85             # hauteur de l'épaulement (goulot -> corps)
FLASK_BODY_W = WIDTH - 60         # largeur du corps
FLASK_BOTTOM = HEIGHT - 28        # y du point le plus bas du fond
FLASK_BOTTOM_DEPTH = 0.7          # bombé du fond : 1.0 = demi-cercle, 0.5 = fond plus plat
WALL_RADIUS = 8                   # demi-épaisseur du verre


# ----------------------------------------------------------------------------
# OUTILS
# ----------------------------------------------------------------------------
def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return tuple(int(lerp(a, b, t)) for a, b in zip(c1, c2))


def vertical_gradient(size, stops):
    """Dégradé vertical. stops = [(position 0..1, (r, g, b)), ...]"""
    w, h = size
    surf = pygame.Surface(size)
    color = stops[0][1]
    for y in range(h):
        t = y / max(1, h - 1)
        for k in range(len(stops) - 1):
            p0, c0 = stops[k]
            p1, c1 = stops[k + 1]
            if p0 <= t <= p1:
                color = lerp_color(c0, c1, (t - p0) / (p1 - p0))
                break
        pygame.draw.line(surf, color, (0, y), (w, y))
    return surf


def make_glow(radius, color, strength=1.0):
    """Disque lumineux dont l'opacité décroît doucement du centre vers le bord."""
    surf = pygame.Surface((radius * 2, radius * 2), pygame.SRCALPHA)
    for i in range(radius, 0, -1):
        t = i / radius  # 1 au bord, 0 au centre
        alpha = int(255 * strength * (1 - t) ** 2)
        pygame.draw.circle(surf, (*color, alpha), (radius, radius), i)
    return surf


def make_bokeh(radius, color, alpha):
    """Petit disque translucide avec un anneau plus marqué (effet bokeh)."""
    k = 4  # dessiné en x4 puis réduit pour des bords lisses
    size = radius * 2 + 2
    surf = pygame.Surface((size * k, size * k), pygame.SRCALPHA)
    surf.fill((*color, 0))
    c = size * k // 2
    pygame.draw.circle(surf, (*color, int(alpha * 0.45)), (c, c), radius * k)
    pygame.draw.circle(surf, (*color, alpha), (c, c), radius * k, max(k, radius * k // 7))
    return pygame.transform.smoothscale(surf, (size, size))


def offset_path(path, d):
    """Décale une polyligne de d pixels vers l'INTÉRIEUR de la flasque (d<0 : vers l'extérieur)."""
    out = []
    n = len(path)
    for i, (x, y) in enumerate(path):
        x0, y0 = path[max(0, i - 1)]
        x1, y1 = path[min(n - 1, i + 1)]
        tx, ty = x1 - x0, y1 - y0
        length = math.hypot(tx, ty) or 1.0
        tx, ty = tx / length, ty / length
        out.append((x + ty * d, y - tx * d))
    return out


def draw_thick_polyline(surf, color, pts, width):
    """Polyligne épaisse aux jointures arrondies (draw.lines laisse des trous)."""
    for p0, p1 in zip(pts, pts[1:]):
        pygame.draw.line(surf, color, p0, p1, width)
    for p in pts:
        pygame.draw.circle(surf, color, p, width / 2)


# ----------------------------------------------------------------------------
# CHARGEMENT DES IMAGES
# ----------------------------------------------------------------------------
def make_fallback(radius, color):
    """Balle colorée avec un visage simple, pour bien voir la rotation."""
    k = 4  # dessiné en x4 puis réduit pour des bords lisses
    R = radius * k
    surf = pygame.Surface((R * 2, R * 2), pygame.SRCALPHA)
    surf.fill((*color, 0))
    pygame.draw.circle(surf, color, (R, R), R)
    pygame.draw.circle(surf, (0, 0, 0), (R, R), R, max(2 * k, R // 12))
    eye = max(2 * k, R // 7)
    for sign in (-1, 1):
        ex, ey = R + sign * R // 3, R - R // 4
        pygame.draw.circle(surf, (255, 255, 255), (ex, ey), eye * 2)
        pygame.draw.circle(surf, (0, 0, 0), (ex, ey), eye)
    pygame.draw.arc(
        surf, (0, 0, 0),
        pygame.Rect(R - R // 2, R, R, R // 2),
        math.pi, 2 * math.pi, max(2 * k, R // 14),
    )
    return pygame.transform.smoothscale(surf, (radius * 2, radius * 2))


def load_sprites():
    sprites = []
    for name, radius, filename, color in TYPES:
        path = os.path.join(IMAGE_DIR, filename)
        if os.path.exists(path):
            img = pygame.image.load(path).convert_alpha()
            img = pygame.transform.smoothscale(img, (radius * 2, radius * 2))
        else:
            print(f"[info] image introuvable : {path} -> balle de secours pour '{name}'")
            img = make_fallback(radius, color)
        sprites.append(img)
    return sprites


# ----------------------------------------------------------------------------
# SONS
# ----------------------------------------------------------------------------
_pyttsx_engine = None


def normalize(text):
    """Minuscules sans accents : 'Pastèque' -> 'pasteque' (pour retrouver les fichiers)."""
    text = unicodedata.normalize("NFD", text)
    return "".join(c for c in text if unicodedata.category(c) != "Mn").lower().strip()


def find_sound_dir():
    """Dossier des sons : dans le dossier courant, sinon à côté du script."""
    if os.path.isabs(SOUND_DIR):
        return SOUND_DIR
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for base in (os.getcwd(), script_dir):
        candidate = os.path.join(base, SOUND_DIR)
        if os.path.isdir(candidate):
            return candidate
    return os.path.join(script_dir, SOUND_DIR)


def find_sound_file(directory, name):
    """Retrouve '<name>.mp3' (ou .wav/.ogg) sans tenir compte des accents ni des majuscules."""
    wanted = normalize(name)
    try:
        files = sorted(os.listdir(directory))
    except OSError:
        return None
    for fname in files:
        stem, ext = os.path.splitext(fname)
        if ext.lower() in (".mp3", ".wav", ".ogg") and normalize(stem) == wanted:
            return os.path.join(directory, fname)
    return None


def pitch_for_level(level):
    """Décalage en demi-tons : cerise (niveau 0) = aigu ... dernier fruit = grave."""
    last = len(TYPES) - 1
    t = level / last if last else 0.0
    return lerp(PITCH_SMALL_SEMITONES, PITCH_BIG_SEMITONES, t)


def prepare_sound(sound, semitones):
    """Coupe le silence du début, puis décale la hauteur en rééchantillonnant.
    Python pur (module `array`) : aucune librairie à installer."""
    freq, fmt, channels = pygame.mixer.get_init()
    if fmt == -16:
        typecode, is_int = "h", True          # entiers 16 bits signés (cas courant)
    elif fmt in (32, -32):
        typecode, is_int = "f", False         # flottants 32 bits
    else:
        raise ValueError(f"format audio {fmt} non géré")

    raw = sound.get_raw()                     # octets, dans le format du mixer
    data = array.array(typecode)
    frame_bytes = data.itemsize * channels
    data.frombytes(raw[: len(raw) - len(raw) % frame_bytes])
    if len(data) == 0:
        return sound

    if TRIM_SILENCE:
        threshold = 0.015 * max(max(data), -min(data))
        first = next((j for j, v in enumerate(data) if abs(v) > threshold), 0) // channels
        first = max(0, first - int(0.005 * freq))        # on garde 5 ms d'attaque
        data = data[first * channels:]

    if PITCH_ENABLED and abs(semitones) > 1e-6:
        factor = 2 ** (semitones / 12)        # >1 : plus aigu et plus court
        n = len(data) // channels             # nombre d'images (frames)
        new_n = max(1, int(n / factor))
        out = array.array(typecode, [0] * (new_n * channels))
        last = n - 1
        for i in range(new_n):
            pos = i * factor
            i0 = int(pos)
            frac = pos - i0
            i1 = i0 + 1 if i0 < last else last
            b0, b1, bo = i0 * channels, i1 * channels, i * channels
            for c in range(channels):
                a = data[b0 + c]
                v = a + (data[b1 + c] - a) * frac        # interpolation linéaire
                out[bo + c] = int(v) if is_int else v
        data = out

    return pygame.mixer.Sound(buffer=data.tobytes())


def generate_voice(name, path):
    """Génère un fichier audio qui prononce le nom du fruit."""
    global _pyttsx_engine
    text = SPOKEN_TEXT.get(name, name)

    if TTS_BACKEND == "gtts":
        from gtts import gTTS
        gTTS(text=text, lang=TTS_LANG).save(path)  # nécessite internet
    elif TTS_BACKEND == "pyttsx3":
        import pyttsx3
        if _pyttsx_engine is None:
            _pyttsx_engine = pyttsx3.init()
            for voice in _pyttsx_engine.getProperty("voices"):
                label = f"{voice.id} {voice.name}".lower()
                if TTS_LANG in label or "french" in label or "fran" in label:
                    _pyttsx_engine.setProperty("voice", voice.id)
                    break
        _pyttsx_engine.save_to_file(text, path)
        _pyttsx_engine.runAndWait()
    else:
        raise ValueError(f"TTS_BACKEND inconnu : {TTS_BACKEND}")


def load_voices():
    """Une pygame.mixer.Sound par type (None si indisponible), déjà préparée (silence + hauteur)."""
    voices = [None] * len(TYPES)
    if not TTS_ENABLED or not pygame.mixer.get_init():
        return voices

    directory = find_sound_dir()
    print(f"[son] dossier : {directory}")
    can_generate = True
    can_process = PITCH_ENABLED or TRIM_SILENCE
    for i, (name, *_rest) in enumerate(TYPES):
        path = find_sound_file(directory, name)

        # son manquant : on tente de le générer (gTTS / pyttsx3), sinon on passe
        if path is None and can_generate:
            ext = "mp3" if TTS_BACKEND == "gtts" else "wav"
            gen_path = os.path.join(directory, f"{name}.{ext}")
            created_dir = not os.path.isdir(directory)
            try:
                os.makedirs(directory, exist_ok=True)
                print(f"[son] '{name}' introuvable -> génération...")
                generate_voice(name, gen_path)
                path = gen_path
            except Exception as exc:  # module manquant, pas d'internet, voix absente...
                print(f"[son] génération impossible ({exc})")
                can_generate = False
                if created_dir and not os.listdir(directory):
                    os.rmdir(directory)   # on ne laisse pas un dossier vide derrière nous
        if path is None or not os.path.exists(path):
            print(f"[son] aucun fichier pour '{name}' -> pas de son pour ce fruit")
            continue

        try:
            sound = pygame.mixer.Sound(path)
            semitones = pitch_for_level(i)
            applied = 0.0
            if can_process:
                try:
                    sound = prepare_sound(sound, semitones)
                    applied = semitones if PITCH_ENABLED else 0.0
                except Exception as exc:  # format audio inattendu...
                    print(f"[son] !!! pitch/silence IMPOSSIBLES ({exc}) -> sons joués tels quels, sans changement de hauteur")
                    can_process = False
            sound.set_volume(TTS_VOLUME)
            voices[i] = sound
            print(f"[son] {name:<13} {os.path.basename(path):<18} {applied:+5.1f} demi-tons  {sound.get_length():.2f} s")
        except Exception as exc:
            print(f"[son] impossible de charger '{path}' : {exc}")
    return voices


# ----------------------------------------------------------------------------
# ARRIÈRE-PLAN
# ----------------------------------------------------------------------------
class Background:
    """Ciel crépusculaire : dégradé, lueurs, étoiles scintillantes, bokeh qui montent, vignette."""

    def __init__(self):
        self.t = 0.0
        big = max(WIDTH, HEIGHT)

        # dégradé de base
        self.base = vertical_gradient((WIDTH, HEIGHT), [
            (0.00, (12, 12, 40)),
            (0.40, (44, 30, 98)),
            (0.75, (112, 52, 132)),
            (1.00, (200, 94, 128)),
        ])

        # grandes lueurs colorées
        for (px, py), rad, col, strength in [
            ((WIDTH * 0.50, HEIGHT * 0.52), big * 0.60, (130, 110, 255), 0.30),   # halo derrière la flasque
            ((WIDTH * 0.10, HEIGHT * 0.18), big * 0.34, (255, 120, 200), 0.20),
            ((WIDTH * 0.92, HEIGHT * 0.78), big * 0.38, (80, 200, 255), 0.18),
        ]:
            glow = make_glow(int(rad), col, strength)
            self.base.blit(glow, glow.get_rect(center=(int(px), int(py))))

        # étoiles (la couleur de fond sous chaque étoile est mémorisée pour le scintillement)
        self.stars = []
        for _ in range(110):
            x = random.randrange(WIDTH)
            y = random.randrange(int(HEIGHT * 0.62))
            self.stars.append({
                "pos": (x, y),
                "size": random.choice((1, 1, 1, 2)),
                "bg": self.base.get_at((x, y))[:3],
                "phase": random.uniform(0, math.tau),
                "speed": random.uniform(0.8, 2.4),
            })

        # bokeh qui montent lentement
        palette = [(255, 170, 220), (150, 190, 255), (190, 160, 255), (255, 220, 170), (140, 235, 230)]
        self.bokeh = []
        for _ in range(36):
            radius = random.randint(5, 24)
            self.bokeh.append({
                "sprite": make_bokeh(radius, random.choice(palette), random.randint(40, 105)),
                "x": random.uniform(0, WIDTH),
                "y": random.uniform(0, HEIGHT),
                "vy": random.uniform(8, 26),
                "sway": random.uniform(6, 22),
                "freq": random.uniform(0.3, 0.9),
                "phase": random.uniform(0, math.tau),
            })

        # vignette (assombrit les bords)
        self.vignette = pygame.Surface((WIDTH, HEIGHT), pygame.SRCALPHA)
        self.vignette.fill((0, 0, 0, 130))
        steps = 60
        for i in range(steps):
            s = 1 - i / steps
            rx, ry = WIDTH * 0.75 * s, HEIGHT * 0.75 * s
            rect = pygame.Rect(0, 0, int(rx * 2), int(ry * 2))
            rect.center = (WIDTH // 2, HEIGHT // 2)
            pygame.draw.ellipse(self.vignette, (0, 0, 0, int(130 * s ** 2.2)), rect)

    def update(self, dt):
        self.t += dt
        for p in self.bokeh:
            p["y"] -= p["vy"] * dt
            h = p["sprite"].get_height()
            if p["y"] < -h:
                p["y"] = HEIGHT + h
                p["x"] = random.uniform(0, WIDTH)

    def draw(self, screen):
        screen.blit(self.base, (0, 0))
        for s in self.stars:
            b = 0.5 + 0.5 * math.sin(self.t * s["speed"] + s["phase"])
            color = lerp_color(s["bg"], (255, 255, 255), 0.25 + 0.7 * b)
            pygame.draw.circle(screen, color, s["pos"], s["size"])
        for p in self.bokeh:
            x = p["x"] + math.sin(self.t * p["freq"] + p["phase"]) * p["sway"]
            screen.blit(p["sprite"], p["sprite"].get_rect(center=(x, p["y"])))
        screen.blit(self.vignette, (0, 0))


# ----------------------------------------------------------------------------
# FLASQUE (physique + rendu verre)
# ----------------------------------------------------------------------------
def build_flask_path():
    """
    Contour de la flasque, de haut-gauche à haut-droit en passant par le fond bombé.
    Retourne (points, (i0, i1)) ; i0..i1 = portion de la paroi gauche qui reçoit le reflet.
    """
    cx = FLASK_CX
    neck_x = FLASK_NECK_W / 2
    body_x = FLASK_BODY_W / 2
    y_neck_end = FLASK_TOP + FLASK_NECK_H
    y_shoulder_end = y_neck_end + FLASK_SHOULDER_H

    # fond bombé : demi-ellipse de demi-largeur body_x et de profondeur ry
    arc_cy = max(FLASK_BOTTOM - FLASK_BOTTOM_DEPTH * body_x, y_shoulder_end)
    ry = FLASK_BOTTOM - arc_cy

    # côté gauche, de haut en bas
    left = [(cx - neck_x, FLASK_TOP), (cx - neck_x, y_neck_end)]

    # épaulement : courbe en S (tangente verticale aux deux bouts)
    n = 18
    for i in range(1, n + 1):
        t = i / n
        s = t * t * (3 - 2 * t)
        left.append((cx - lerp(neck_x, body_x, s), lerp(y_neck_end, y_shoulder_end, t)))
    shoulder_end_idx = len(left) - 1

    # corps droit
    if arc_cy > y_shoulder_end:
        left.append((cx - body_x, arc_cy))

    # fond : de l'angle pi (gauche) à pi/2 (point le plus bas)
    m = 28
    for i in range(1, m + 1):
        a = math.pi - (math.pi / 2) * i / m
        left.append((cx + body_x * math.cos(a), arc_cy + ry * math.sin(a)))

    # côté droit = symétrique (sans dupliquer le point du bas)
    right = [(2 * cx - x, y) for x, y in reversed(left[:-1])]
    path = left + right

    hl = (shoulder_end_idx + 1, len(left) - 1 - int(m * 0.40))
    return path, hl


class Flask:
    def __init__(self, space):
        self.path, self.highlight = build_flask_path()
        self.neck_inner_half = FLASK_NECK_W / 2 - WALL_RADIUS
        self._add_walls(space)
        self._render()

    def _add_walls(self, space):
        for p0, p1 in zip(self.path, self.path[1:]):
            seg = pymunk.Segment(space.static_body, p0, p1, WALL_RADIUS)
            seg.elasticity = WALL_ELASTICITY
            seg.friction = FRICTION
            space.add(seg)

    def _render(self):
        # Rendu en haute résolution (x K) puis réduction : bords lisses, et c'est fait
        # une seule fois au démarrage, donc sans aucun coût pendant la simulation.
        K = 3
        path = self.path

        def S(pts):
            return [(x * K, y * K) for x, y in pts]

        def new_layer():
            surf = pygame.Surface((WIDTH * K, HEIGHT * K), pygame.SRCALPHA)
            surf.fill((205, 228, 255, 0))  # pixels transparents teintés : pas de liseré sombre
            return surf

        def finish(surf):
            return pygame.transform.smoothscale(surf, (WIDTH, HEIGHT))

        # --- couche arrière : le "creux" de la flasque (dessinée avant les balles)
        back = new_layer()
        pygame.draw.polygon(back, (170, 210, 255, 30), S(path))
        self.back = finish(back)

        # --- couche avant : verre, bords brillants, reflets (dessinée par-dessus les balles)
        front = new_layer()
        inner = offset_path(path, WALL_RADIUS)
        draw_thick_polyline(front, (200, 228, 255, 105), S(path), WALL_RADIUS * 2 * K)
        draw_thick_polyline(front, (255, 255, 255, 190), S(inner), 2 * K)
        draw_thick_polyline(front, (190, 215, 255, 110), S(offset_path(path, -WALL_RADIUS)), 2 * K)

        # collerette du goulot
        cx = FLASK_CX
        nx = FLASK_NECK_W / 2
        lip_w = WALL_RADIUS * 2 + 14
        for x in (cx - nx - lip_w / 2, cx + nx - lip_w / 2):
            rect = pygame.Rect(int(x * K), (FLASK_TOP - 9) * K, int(lip_w * K), 14 * K)
            pygame.draw.rect(front, (205, 230, 255, 150), rect, border_radius=7 * K)
            pygame.draw.rect(front, (255, 255, 255, 210), rect, width=2 * K, border_radius=7 * K)

        # reflets : longue traînée à gauche, plus courte à droite
        i0, i1 = self.highlight
        far = offset_path(path, WALL_RADIUS + 13)
        left_hl = S(far[i0:i1])
        right_hl = S([far[len(far) - 1 - j] for j in range(i0, i0 + (i1 - i0) // 2)])
        draw_thick_polyline(front, (255, 255, 255, 55), left_hl, 9 * K)
        draw_thick_polyline(front, (255, 255, 255, 150), left_hl, 3 * K)
        draw_thick_polyline(front, (255, 255, 255, 40), right_hl, 6 * K)
        draw_thick_polyline(front, (255, 255, 255, 110), right_hl, 2 * K)
        # petit point de lumière sur l'épaulement
        sx, sy = far[max(0, i0 - 7)]
        pygame.draw.circle(front, (255, 255, 255, 170), (int(sx * K), int(sy * K)), 3 * K)
        self.front = finish(front)


# ----------------------------------------------------------------------------
# BALLE
# ----------------------------------------------------------------------------
class Ball:
    def __init__(self, space, level, pos, velocity=(0, 0), angle=0.0, angular_velocity=0.0):
        self.level = level
        self.radius = TYPES[level][1]
        mass = DENSITY * math.pi * self.radius ** 2
        moment = pymunk.moment_for_circle(mass, 0, self.radius)
        self.body = pymunk.Body(mass, moment)
        self.body.position = pos
        self.body.velocity = velocity
        self.body.angle = angle
        self.body.angular_velocity = angular_velocity
        self.shape = pymunk.Circle(self.body, self.radius)
        self.shape.elasticity = BALL_ELASTICITY
        self.shape.friction = FRICTION
        space.add(self.body, self.shape)

    def remove(self, space):
        space.remove(self.shape, self.body)

    def draw(self, screen, sprites):
        # pymunk : angle positif = sens horaire à l'écran (axe y vers le bas)
        # pygame.transform.rotate : angle positif = sens anti-horaire -> on inverse
        # rotozoom = rotation lissée (anti-aliasing), plus joli que transform.rotate
        rotated = pygame.transform.rotozoom(sprites[self.level], -math.degrees(self.body.angle), 1)
        rect = rotated.get_rect(center=(self.body.position.x, self.body.position.y))
        screen.blit(rotated, rect)


# ----------------------------------------------------------------------------
# SIMULATION
# ----------------------------------------------------------------------------
class Simulation:
    def __init__(self):
        self.sprites = load_sprites()
        self.voices = load_voices()
        self.voice_channel = pygame.mixer.Channel(0) if pygame.mixer.get_init() else None
        self.background = Background()
        self.speed_index = 0              # index dans SPEED_LEVELS (conservé après un reset)
        self.reset()

    def reset(self):
        self.space = pymunk.Space()
        self.space.gravity = GRAVITY
        self.space.iterations = 20          # piles de balles plus stables avec le rebond
        self.balls = []
        self.score = 0
        self.spawn_timer = 0.0
        self.full_timer = 0.0
        self.flask = Flask(self.space)

    def spawn(self, x=None, level=None):
        """Lâche une balle au-dessus du goulot. Retourne False si la place n'est pas libre."""
        if level is None:
            level = random.choice(SPAWNABLE)
        r = TYPES[level][1]
        half = max(0.0, self.flask.neck_inner_half - r)
        if x is None:
            x = random.uniform(FLASK_CX - half, FLASK_CX + half)
        x = max(FLASK_CX - half, min(FLASK_CX + half, x))
        y = max(r + 2, FLASK_TOP - r - 2)

        # goulot bouché ? on n'ajoute rien par-dessus une autre balle
        if self.space.point_query_nearest((x, y), r + 2, pymunk.ShapeFilter()) is not None:
            return False

        self.balls.append(Ball(self.space, level, (x, y),
                               velocity=(0, 0),
                               angle=random.uniform(0, 2 * math.pi),
                               angular_velocity=random.uniform(-3, 3)))
        if SOUND_ON_SPAWN:
            self.say(level, interrupt=False)   # son de la cerise lâchée, sans jamais couper une fusion
        return True

    def say(self, level, interrupt=True):
        """Joue le son du type `level`. Un seul canal : le son précédent est coupé net,
        donc jamais de chevauchement. Avec interrupt=False, on ne joue que si le canal est libre."""
        sound = self.voices[level]
        if sound is None or self.voice_channel is None:
            return
        if not interrupt and self.voice_channel.get_busy():
            return
        self.voice_channel.play(sound)

    def _merge_pass(self):
        """Détecte les balles du même type en contact et les fusionne."""
        to_remove = set()
        to_add = []
        n = len(self.balls)
        for i in range(n):
            a = self.balls[i]
            if i in to_remove:
                continue
            for j in range(i + 1, n):
                b = self.balls[j]
                if j in to_remove or a.level != b.level:
                    continue
                if not MERGE_LAST_TYPE and a.level == len(TYPES) - 1:
                    continue
                pa, pb = a.body.position, b.body.position
                if pa.get_distance(pb) <= a.radius + b.radius + MERGE_TOLERANCE:
                    to_remove.update((i, j))
                    ma, mb = a.body.mass, b.body.mass
                    total = ma + mb
                    # le nouveau est au barycentre, avec la quantité de mouvement conservée
                    pos = (pa * ma + pb * mb) / total
                    vel = (a.body.velocity * ma + b.body.velocity * mb) / total
                    # rotation : moyenne des vitesses angulaires, angle de la première balle
                    ang_vel = (a.body.angular_velocity + b.body.angular_velocity) / 2
                    angle = a.body.angle
                    if a.level + 1 < len(TYPES):
                        to_add.append((a.level + 1, pos, vel, angle, ang_vel))
                    # son immédiat de la fusion (voir SOUND_OF_CREATED_FRUIT)
                    sound_level = a.level + 1 if SOUND_OF_CREATED_FRUIT else a.level
                    if sound_level < len(TYPES):
                        self.say(sound_level)
                    self.score += (a.level + 1) * 10
                    break

        if to_remove:
            for idx in sorted(to_remove, reverse=True):
                self.balls[idx].remove(self.space)
                del self.balls[idx]
            for level, pos, vel, angle, ang_vel in to_add:
                self.balls.append(Ball(self.space, level, pos, vel, angle, ang_vel))

    def _cleanup(self):
        """Supprime les balles éjectées hors de l'écran."""
        for ball in self.balls[:]:
            x, y = ball.body.position
            if y > HEIGHT + 300 or x < -300 or x > WIDTH + 300:
                ball.remove(self.space)
                self.balls.remove(ball)

    @property
    def speed(self):
        return SPEED_LEVELS[self.speed_index]

    def cycle_speed(self):
        """x1 -> x2 -> x4 -> ... -> x10 -> x1"""
        self.speed_index = (self.speed_index + 1) % len(SPEED_LEVELS)

    def update(self, dt):
        # Vitesse x N : on rejoue N fois le même pas de temps (au lieu d'agrandir dt),
        # donc la physique reste aussi stable qu'à vitesse normale.
        for _ in range(self.speed):
            for _ in range(SUBSTEPS):
                self.space.step(dt / SUBSTEPS)
            self._merge_pass()
            self._cleanup()
        self.background.update(dt)
        sim_dt = dt * self.speed          # temps de jeu écoulé (spawn, flasque pleine)

        if AUTO_SPAWN:
            self.spawn_timer += sim_dt
            if self.spawn_timer >= AUTO_SPAWN_DELAY:
                if self.spawn(level=AUTO_SPAWN_LEVEL):
                    self.spawn_timer = 0.0

        # flasque pleine : une balle reste immobile dans la zone du goulot -> on recommence
        if RESTART_WHEN_FULL:
            fill_y = FLASK_TOP + FLASK_NECK_H
            clogged = any(b.body.position.y < fill_y and b.body.velocity.length < 60
                          for b in self.balls)
            self.full_timer = self.full_timer + sim_dt if clogged else 0.0
            if self.full_timer >= FULL_DELAY:
                self.reset()

    def draw(self, screen, font):
        self.background.draw(screen)
        screen.blit(self.flask.back, (0, 0))
        for ball in self.balls:
            ball.draw(screen, self.sprites)
        screen.blit(self.flask.front, (0, 0))

        label = f"Score : {self.score}"
        shadow = font.render(label, True, (10, 8, 30))
        txt = font.render(label, True, (255, 255, 255))
        screen.blit(shadow, (17, 15))
        screen.blit(txt, (15, 13))

        if self.speed > 1:
            label = f"Vitesse : x{self.speed}"
            shadow = font.render(label, True, (10, 8, 30))
            txt = font.render(label, True, (255, 220, 120))
            screen.blit(shadow, (17, 41))
            screen.blit(txt, (15, 39))


def main():
    global AUTO_SPAWN
    pygame.mixer.pre_init(44100, -16, 2, 512)   # format audio fixe : indispensable pour décaler la hauteur
    pygame.init()
    screen = pygame.display.set_mode((WIDTH, HEIGHT))
    pygame.display.set_caption("Simulation de fusion")
    clock = pygame.time.Clock()
    font = pygame.font.SysFont(None, 32)
    sim = Simulation()

    running = True
    while running:
        dt = min(clock.tick(FPS) / 1000.0, 1 / 30)   # évite les gros sauts si la fenêtre rame
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    running = False
                elif event.key == pygame.K_SPACE:
                    sim.spawn()
                elif event.key == pygame.K_a:
                    AUTO_SPAWN = not AUTO_SPAWN
                elif event.key == pygame.K_f:
                    sim.cycle_speed()
                elif event.key == pygame.K_r:
                    sim.reset()
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                sim.spawn(x=event.pos[0])

        sim.update(dt)
        sim.draw(screen, font)
        pygame.display.flip()

    pygame.quit()


if __name__ == "__main__":
    main()
