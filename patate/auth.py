"""Accès aux Settings : un mot de passe unique, pas de comptes."""

import functools
import hmac

from flask import Blueprint, current_app, jsonify, redirect, render_template, request, session, url_for

bp = Blueprint("auth", __name__)


def is_admin():
    return session.get("admin") is True


def check_password(candidate):
    expected = current_app.config["PATATE_PASSWORD"]
    return hmac.compare_digest((candidate or "").encode(), expected.encode())


def require_page(view):
    """Page des Settings : redirige vers le formulaire de mot de passe."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)
    return wrapper


def require_api(view):
    """Appel d'API qui modifie les médias : 401 sans mot de passe.
    L'en-tête X-Patate (posé par fetch) bloque les formulaires envoyés depuis un autre site."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return jsonify(error="Mot de passe requis."), 401
        if request.headers.get("X-Patate") != "1":
            return jsonify(error="En-tête X-Patate manquant."), 400
        return view(*args, **kwargs)
    return wrapper


@bp.route("/settings/login", methods=["GET", "POST"])
def login():
    error = None
    next_url = request.values.get("next") or ""
    if not next_url.startswith("/settings") or next_url.startswith("//"):
        next_url = url_for("routes.settings")
    if request.method == "POST":
        if check_password(request.form.get("password")):
            session.clear()
            session["admin"] = True
            return redirect(next_url)
        error = "Mot de passe incorrect."
    return render_template("login.html", error=error, next_url=next_url), (401 if error else 200)


@bp.route("/settings/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("routes.game"))
