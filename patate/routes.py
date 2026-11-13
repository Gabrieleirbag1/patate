"""Pages (jeu, Settings) et API JSON des packs."""

from flask import (Blueprint, abort, current_app, jsonify, render_template, request,
                   send_file, url_for)

from .auth import is_admin, require_api, require_page
from .packs import DEFAULT_ID, LEVELS, PackError

bp = Blueprint("routes", __name__)


def store():
    return current_app.extensions["packs"]


def media_url(pack_id, filename, mtime):
    return url_for("routes.media", pack_id=pack_id, filename=filename, v=mtime)


def check_visible(pack_id):
    """Un pack privé n'existe pas (404) pour qui n'a pas donné le mot de passe."""
    if store().is_private(pack_id) and not is_admin():
        raise PackError("Pack introuvable.", 404)


@bp.errorhandler(PackError)
def pack_error(exc):
    return jsonify(error=str(exc)), exc.status


# ----------------------------------------------------------------------------
# Pages
# ----------------------------------------------------------------------------
@bp.route("/")
def game():
    return render_template("game.html")


@bp.route("/settings")
@require_page
def settings():
    return render_template("settings.html", packs=store().list(include_private=True))


@bp.route("/settings/<pack_id>")
@require_page
def pack_edit(pack_id):
    try:
        pack = store().describe(pack_id, media_url)
    except PackError:
        abort(404)
    return render_template("pack_edit.html", pack=pack)


# ----------------------------------------------------------------------------
# API publique
# ----------------------------------------------------------------------------
@bp.route("/api/packs")
def api_packs():
    return jsonify(store().list(include_private=is_admin()))


@bp.route("/api/packs/<pack_id>")
def api_pack(pack_id):
    check_visible(pack_id)
    response = jsonify(store().describe(pack_id, media_url))
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/favicon.ico")
def favicon():
    """Les navigateurs (et certains robots) demandent /favicon.ico sans lire les <link rel=icon>."""
    return current_app.send_static_file("icons/favicon.ico")


@bp.route("/media/<pack_id>/<filename>")
def media(pack_id, filename):
    try:
        check_visible(pack_id)
        path = store().media_path(pack_id, filename)
    except PackError:
        path = None
    if path is None:
        abort(404)
    if pack_id == DEFAULT_ID and request.args.get("v"):
        # pack Fruits : public et versionné (?v=mtime) -> cache long
        return send_file(path, conditional=True, max_age=31536000)
    # packs perso : un pack peut devenir privé à tout moment -> revérifié à chaque affichage
    response = send_file(path, conditional=True, max_age=0)
    response.headers["Cache-Control"] = "private, no-cache"
    return response


# ----------------------------------------------------------------------------
# API protégée (mot de passe)
# ----------------------------------------------------------------------------
@bp.route("/api/packs", methods=["POST"])
@require_api
def api_create():
    payload = request.get_json(silent=True) or {}
    pack_id = store().create(payload.get("name"), private=payload.get("private", True))
    return jsonify(store().describe(pack_id, media_url)), 201


@bp.route("/api/packs/<pack_id>", methods=["PATCH"])
@require_api
def api_update(pack_id):
    payload = request.get_json(silent=True) or {}
    store().update(pack_id, name=payload.get("name"), crop_circle=payload.get("crop_circle"),
                   labels=payload.get("labels"), private=payload.get("private"))
    return jsonify(store().describe(pack_id, media_url))


@bp.route("/api/packs/<pack_id>", methods=["DELETE"])
@require_api
def api_delete(pack_id):
    store().delete(pack_id)
    return jsonify(ok=True)


@bp.route("/api/packs/<pack_id>/slots/<int:level>/<kind>", methods=["POST", "DELETE"])
@require_api
def api_slot(pack_id, level, kind):
    if kind not in ("image", "sound"):
        abort(404)
    if request.method == "DELETE":
        store().clear(pack_id, level, kind)
    else:
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            raise PackError("Aucun fichier reçu.")
        if kind == "image":
            store().set_image(pack_id, level, upload.stream)
        else:
            store().set_sound(pack_id, level, upload.stream, upload.filename)
    return jsonify(store().describe(pack_id, media_url))


@bp.route("/api/packs/<pack_id>/import/plan", methods=["POST"])
@require_api
def api_import_plan(pack_id):
    """Import d'un dossier, étape 1 : le navigateur envoie seulement les noms de fichiers,
    reçoit le niveau de chacun, puis envoie les fichiers retenus un par un (slots/<n>/<kind>)."""
    names = (request.get_json(silent=True) or {}).get("names")
    if not isinstance(names, list) or not names:
        raise PackError("Aucun fichier reçu.")
    plan = store().plan_import(pack_id, names[:2000])
    return jsonify(image=plan["image"], sound=plan["sound"], ignored=plan["ignored"])


@bp.route("/api/packs/<pack_id>/import", methods=["POST"])
@require_api
def api_import(pack_id):
    uploads = request.files.getlist("files")
    if not uploads:
        raise PackError("Aucun fichier reçu.")
    summary = store().import_files(pack_id, [(u.filename, u.stream) for u in uploads])
    return jsonify(summary=summary, pack=store().describe(pack_id, media_url))


@bp.app_errorhandler(413)
def too_large(_exc):
    return jsonify(error="Fichiers trop lourds (64 Mo maximum par envoi)."), 413


@bp.app_context_processor
def inject_globals():
    return {"LEVELS": LEVELS, "DEFAULT_ID": DEFAULT_ID, "is_admin": is_admin()}
