# Image de Patate : Flask servi par gunicorn sur le port 6767.
#
#   sudo docker build -t patate .
#   ./server_patate.sh            (lance le conteneur avec les bons volumes, voir ce script)
#
# Ni le mot de passe (.env) ni les packs perso (data/) ne sont dans l'image :
# ils sont montés depuis l'hôte au lancement.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATATE_DATA_DIR=/app/data

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .
COPY patate ./patate

# Utilisateur sans droits root (server_patate.sh lance plutôt avec l'UID de l'hôte,
# pour que les fichiers de data/ appartiennent au même utilisateur des deux côtés).
RUN useradd --create-home --uid 1000 patate && mkdir -p /app/data && chown patate:patate /app/data
USER patate

EXPOSE 6767

# --preload : l'application est créée une seule fois avant de lancer les workers
# (sinon chaque worker pourrait générer sa propre clé de session au premier démarrage).
# --timeout 120 : laisse le temps aux gros envois de photos.
CMD ["gunicorn", "--bind", "0.0.0.0:6767", "--workers", "2", "--preload", "--timeout", "120", \
     "--access-logfile", "-", "--error-logfile", "-", "app:app"]
