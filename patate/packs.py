"""Stockage des packs de médias, sans base de données.

Un pack = un dossier contenant un ``pack.json`` + des fichiers rangés par niveau :
    img_<n>.png              image du niveau n (0 = le plus petit)
    snd_<n>.<mp3|wav|ogg>    son du niveau n

Le pack « fruits » (dossier ``default_pack`` du code) est en lecture seule.
Les packs personnalisés vivent dans ``<data>/packs/<slug>/``.
Un emplacement vide d'un pack personnalisé reprend le média du pack « fruits ».
"""

import io
import json
import os
import re
import shutil
import unicodedata

from PIL import Image, ImageOps, UnidentifiedImageError

LEVELS = 8
DEFAULT_ID = "fruits"
RESERVED_IDS = {DEFAULT_ID, "login", "logout"}   # /settings/<id> ne doit pas masquer ces pages
DEFAULT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "default_pack")

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
SOUND_EXTS = {".mp3", ".wav", ".ogg"}
IMAGE_MAX_SIDE = 512


class PackError(Exception):
    """Erreur « métier » renvoyée telle quelle à l'utilisateur (avec un code HTTP)."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ----------------------------------------------------------------------------
# Outils
# ----------------------------------------------------------------------------
def normalize(text):
    """Minuscules sans accents : 'Pastèque' -> 'pasteque' (comme final.py)."""
    text = unicodedata.normalize("NFD", text)
    return "".join(c for c in text if unicodedata.category(c) != "Mn").lower().strip()


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", normalize(text)).strip("-")
    return slug[:40].strip("-")


def _ext(filename):
    return os.path.splitext(filename or "")[1].lower()


def is_image(filename):
    return _ext(filename) in IMAGE_EXTS


def is_sound(filename):
    return _ext(filename) in SOUND_EXTS


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _empty_slots(labels=None):
    labels = labels or [f"niveau {i + 1}" for i in range(LEVELS)]
    return [{"label": labels[i], "image": None, "sound": None} for i in range(LEVELS)]


# ----------------------------------------------------------------------------
# Store
# ----------------------------------------------------------------------------
class PackStore:
    def __init__(self, data_dir):
        self.root = os.path.join(data_dir, "packs")
        os.makedirs(self.root, exist_ok=True)

    # -- emplacement ----------------------------------------------------------
    def pack_dir(self, pack_id):
        if pack_id == DEFAULT_ID:
            return DEFAULT_DIR
        if not SLUG_RE.match(pack_id or ""):
            raise PackError("Identifiant de pack invalide.", 404)
        return os.path.join(self.root, pack_id)

    def exists(self, pack_id):
        try:
            return os.path.isfile(os.path.join(self.pack_dir(pack_id), "pack.json"))
        except PackError:
            return False

    def _load(self, pack_id):
        if not self.exists(pack_id):
            raise PackError("Pack introuvable.", 404)
        data = _read_json(os.path.join(self.pack_dir(pack_id), "pack.json"))
        slots = data.get("slots") or []
        slots = (slots + _empty_slots())[:LEVELS]
        data["slots"] = slots
        data.setdefault("name", pack_id)
        data.setdefault("crop_circle", True)
        return data

    def _save(self, pack_id, data):
        self._check_writable(pack_id)
        _write_json(os.path.join(self.pack_dir(pack_id), "pack.json"), data)

    @staticmethod
    def _check_writable(pack_id):
        if pack_id == DEFAULT_ID:
            raise PackError("Le pack « Fruits » est en lecture seule.", 403)

    # -- lecture --------------------------------------------------------------
    def list(self):
        packs = [{"id": DEFAULT_ID, "name": self._load(DEFAULT_ID)["name"], "readonly": True}]
        for entry in sorted(os.listdir(self.root)):
            if SLUG_RE.match(entry) and entry not in RESERVED_IDS and self.exists(entry):
                packs.append({"id": entry, "name": self._load(entry)["name"], "readonly": False})
        return packs

    def media_path(self, pack_id, filename):
        """Chemin absolu d'un fichier de pack, ou None (aucun nom libre : uniquement img_n / snd_n)."""
        if not re.fullmatch(r"(img_[0-9]\.png|snd_[0-9]\.(mp3|wav|ogg))", filename or ""):
            return None
        directory = self.pack_dir(pack_id)
        path = os.path.join(directory, filename)
        return path if os.path.isfile(path) else None

    def describe(self, pack_id, url_for_media):
        """Description complète d'un pack pour le jeu / les Settings.
        url_for_media(pack_id, filename, mtime) -> URL."""
        data = self._load(pack_id)
        default = self._load(DEFAULT_ID)
        levels = []
        for i, slot in enumerate(data["slots"]):
            item = {"level": i, "label": slot.get("label") or default["slots"][i]["label"]}
            for kind in ("image", "sound"):
                own = slot.get(kind)
                source_id, filename = (pack_id, own) if own else (DEFAULT_ID, default["slots"][i].get(kind))
                path = self.media_path(source_id, filename) if filename else None
                if path:
                    item[f"{kind}_url"] = url_for_media(source_id, filename, int(os.path.getmtime(path)))
                    item[f"{kind}_inherited"] = source_id != pack_id
                else:
                    item[f"{kind}_url"] = None
                    item[f"{kind}_inherited"] = False
            levels.append(item)
        return {
            "id": pack_id,
            "name": data["name"],
            "crop_circle": bool(data["crop_circle"]),
            "readonly": pack_id == DEFAULT_ID,
            "levels": levels,
        }

    # -- écriture -------------------------------------------------------------
    def create(self, name):
        name = (name or "").strip()[:60]
        if not name:
            raise PackError("Donne un nom au pack.")
        base = slugify(name) or "pack"
        if base in RESERVED_IDS:
            base = f"{base}-perso"
        slug, k = base, 2
        while self.exists(slug):
            slug = f"{base[:36]}-{k}"
            k += 1
        os.makedirs(self.pack_dir(slug))
        default_labels = [s["label"] for s in self._load(DEFAULT_ID)["slots"]]
        self._save(slug, {"name": name, "crop_circle": True, "slots": _empty_slots(default_labels)})
        return slug

    def delete(self, pack_id):
        self._check_writable(pack_id)
        if not self.exists(pack_id):
            raise PackError("Pack introuvable.", 404)
        shutil.rmtree(self.pack_dir(pack_id))

    def update(self, pack_id, name=None, crop_circle=None, labels=None):
        self._check_writable(pack_id)
        data = self._load(pack_id)
        if name is not None:
            name = str(name).strip()[:60]
            if not name:
                raise PackError("Le nom ne peut pas être vide.")
            data["name"] = name
        if crop_circle is not None:
            data["crop_circle"] = bool(crop_circle)
        if labels is not None:
            if not isinstance(labels, list) or len(labels) != LEVELS:
                raise PackError(f"Il faut exactement {LEVELS} libellés.")
            for slot, label in zip(data["slots"], labels):
                slot["label"] = str(label).strip()[:40] or slot["label"]
        self._save(pack_id, data)

    def _check_level(self, level):
        if not (0 <= level < LEVELS):
            raise PackError("Niveau invalide.", 404)

    def set_image(self, pack_id, level, stream):
        self._check_writable(pack_id)
        self._check_level(level)
        data = self._load(pack_id)
        try:
            img = Image.open(io.BytesIO(stream.read()))
            img = ImageOps.exif_transpose(img)
            img.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE))
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise PackError("Ce fichier n'est pas une image lisible.") from exc
        filename = f"img_{level}.png"
        img.save(os.path.join(self.pack_dir(pack_id), filename), "PNG", optimize=True)
        data["slots"][level]["image"] = filename
        self._save(pack_id, data)

    def set_sound(self, pack_id, level, stream, original_name):
        self._check_writable(pack_id)
        self._check_level(level)
        ext = _ext(original_name)
        if ext not in SOUND_EXTS:
            raise PackError("Formats audio acceptés : MP3, WAV, OGG.")
        data = self._load(pack_id)
        directory = self.pack_dir(pack_id)
        for old in SOUND_EXTS:  # un seul son par niveau
            old_path = os.path.join(directory, f"snd_{level}{old}")
            if os.path.exists(old_path):
                os.remove(old_path)
        filename = f"snd_{level}{ext}"
        with open(os.path.join(directory, filename), "wb") as fh:
            shutil.copyfileobj(stream, fh)
        data["slots"][level]["sound"] = filename
        self._save(pack_id, data)

    def clear(self, pack_id, level, kind):
        self._check_writable(pack_id)
        self._check_level(level)
        data = self._load(pack_id)
        filename = data["slots"][level].get(kind)
        if filename:
            path = self.media_path(pack_id, filename)
            if path:
                os.remove(path)
            data["slots"][level][kind] = None
            self._save(pack_id, data)

    def plan_import(self, pack_id, names):
        """Répartit une liste de noms de fichiers (import d'un dossier) sur les niveaux.

        1) un fichier dont le nom (sans accents/majuscules) vaut le libellé d'un niveau
           ou son numéro (1..8) va dans ce niveau ;
        2) les autres remplissent, par ordre alphabétique, les niveaux encore libres
           (du plus petit au plus gros), images et sons séparément.
        Retourne {"image": {niveau: index}, "sound": {niveau: index}, "ignored": [noms]},
        où index est la position du fichier dans `names`.
        """
        self._check_writable(pack_id)
        data = self._load(pack_id)
        keys = {}
        for i, slot in enumerate(data["slots"]):
            keys[normalize(slot["label"])] = i
            keys[str(i + 1)] = i

        groups = {"image": [], "sound": []}
        ignored = []
        for index, name in enumerate(names):
            base = os.path.basename(str(name or "").replace("\\", "/"))
            if not base or base.startswith("."):
                continue
            kind = "image" if is_image(base) else "sound" if is_sound(base) else None
            if kind is None:
                ignored.append(base)
            else:
                groups[kind].append((base, index))

        plan = {"image": {}, "sound": {}, "ignored": ignored}
        for kind, items in groups.items():
            items.sort(key=lambda it: (normalize(it[0]), it[1]))
            assigned = {}
            rest = []
            for base, index in items:
                level = keys.get(normalize(os.path.splitext(base)[0]))
                if level is not None and level not in assigned:
                    assigned[level] = index
                else:
                    rest.append((base, index))
            free = [i for i in range(LEVELS) if i not in assigned]
            for level, (_base, index) in zip(free, rest):
                assigned[level] = index
            ignored.extend(base for base, _ in rest[len(free):])
            plan[kind] = dict(sorted(assigned.items()))
        return plan

    def import_files(self, pack_id, files):
        """Import en une requête : files = [(nom_original, stream), ...] (voir plan_import).
        Retourne un résumé {"images": n, "sounds": n, "ignored": [noms]}."""
        plan = self.plan_import(pack_id, [name for name, _ in files])
        summary = {"images": 0, "sounds": 0, "ignored": plan["ignored"]}
        for kind in ("image", "sound"):
            for level, index in plan[kind].items():
                name, stream = files[index]
                base = os.path.basename((name or "").replace("\\", "/"))
                try:
                    if kind == "image":
                        self.set_image(pack_id, level, stream)
                        summary["images"] += 1
                    else:
                        self.set_sound(pack_id, level, stream, base)
                        summary["sounds"] += 1
                except PackError:
                    summary["ignored"].append(base)
        return summary
