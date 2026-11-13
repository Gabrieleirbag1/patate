"""Lancement : python app.py  (ou : flask --app app run)

Réglages : fichier .env à la racine (ligne PATATE_PASSWORD=...), ou variables d'environnement :
    PATATE_PASSWORD    mot de passe des Settings (obligatoire pour les ouvrir, aucun par défaut)
    PATATE_SECRET_KEY  clé de signature des cookies (défaut : générée dans data/secret_key)
    PATATE_DATA_DIR    dossier des packs personnalisés (défaut : ./data)
    HOST / PORT        adresse d'écoute (défaut : 127.0.0.1:6767)
"""

import os

from patate import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "6767")),
            debug=os.environ.get("FLASK_DEBUG") == "1")
