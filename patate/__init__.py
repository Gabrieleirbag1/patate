"""Patate : simulation de fusion de fruits, en application web Flask."""

import os
import secrets

from dotenv import load_dotenv
from flask import Flask

from .packs import PackStore


def _secret_key(data_dir):
    """SECRET_KEY : variable d'environnement, sinon générée une fois et gardée dans data/."""
    key = os.environ.get("PATATE_SECRET_KEY")
    if key:
        return key
    path = os.path.join(data_dir, "secret_key")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(key)
    os.chmod(path, 0o600)
    return key


def create_app(data_dir=None, password=None):
    app = Flask(__name__)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # réglages lus dans le fichier .env à la racine du projet
    # (une vraie variable d'environnement garde la priorité sur le fichier)
    load_dotenv(os.path.join(root, ".env"))
    data_dir = os.path.abspath(data_dir or os.environ.get("PATATE_DATA_DIR") or os.path.join(root, "data"))
    os.makedirs(data_dir, exist_ok=True)

    app.config.update(
        SECRET_KEY=_secret_key(data_dir),
        PATATE_PASSWORD=password or os.environ.get("PATATE_PASSWORD", ""),   # aucun mot de passe par défaut
        MAX_CONTENT_LENGTH=64 * 1024 * 1024,     # 64 Mo par requête (import de dossier)
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        JSON_AS_ASCII=False,
    )
    app.extensions["packs"] = PackStore(data_dir)
    if not app.config["PATATE_PASSWORD"].strip():
        app.logger.warning("PATATE_PASSWORD est vide : les Settings restent fermés. "
                           "Renseigne-le dans le fichier .env puis relance l'application.")

    from .auth import bp as auth_bp
    from .routes import bp as routes_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(routes_bp)
    return app
