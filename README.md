# patate

Simulation de fusion (style Suika) en application web Flask : des petites balles tombent par le goulot d'une flasque en verre, et deux balles identiques qui se touchent fusionnent en une plus grosse, jusqu'à la version géante. Chaque fusion joue un son dont la hauteur baisse avec la taille.

C'est le portage web de `final.py` (pygame/pymunk). La simulation tourne dans le navigateur (Canvas + [Planck.js](https://github.com/piqnt/planck.js), inclus dans `patate/static/vendor/`) ; Flask sert les pages, les médias et l'API des packs.

## Lancer

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env               # puis choisis ton mot de passe dans .env
.venv/bin/python app.py            # http://127.0.0.1:5000
```

Les réglages se font dans le fichier **`.env`** à la racine (ignoré par git ; modèle : `.env.example`). Une vraie variable d'environnement garde la priorité sur le fichier.

| Variable            | Défaut                    | Rôle                                        |
|---------------------|---------------------------|---------------------------------------------|
| `PATATE_PASSWORD`   | *aucun* (obligatoire)     | mot de passe des Settings ; vide = Settings fermés |
| `PATATE_SECRET_KEY` | générée dans `data/`      | signature du cookie de session              |
| `PATATE_DATA_DIR`   | `./data`                  | dossier des packs personnalisés             |
| `HOST` / `PORT`     | `127.0.0.1` / `5000`      | adresse d'écoute (`HOST=0.0.0.0` pour le réseau local) |

## Jouer

Cliquer sur le jeu pour démarrer (les navigateurs exigent un clic pour activer le son), puis :

- **clic / toucher** : lâcher une balle à cet endroit du goulot
- **Espace** : lâcher une balle
- **A** : spawn automatique on/off
- **F** : vitesse x1 → x2 → x4 → x6 → x8 → x10 → x1
- **R** : réinitialiser

Quand la flasque est pleine (balles immobiles dans le goulot pendant 3 s), la partie recommence. Le menu « Pack » choisit les images et sons ; le choix est mémorisé dans le navigateur (ou via `/?pack=<id>`).

## Settings (mot de passe)

`/settings` est protégé par un mot de passe unique, défini par `PATATE_PASSWORD` dans `.env`, sans comptes. Tant qu'il est vide, personne ne peut y entrer (le jeu, lui, marche normalement). On peut y :

- créer, renommer et supprimer des packs ;
- envoyer une image et/ou un son pour chacun des 8 niveaux (du plus petit au plus gros) ;
- importer un dossier entier (par exemple des photos de proches). Un fichier nommé comme un niveau (`cerise.jpg`, `3.mp3`…) va dans ce niveau ; les autres remplissent les niveaux libres par ordre alphabétique ;
- choisir si les images sont découpées en cercle (conseillé pour des photos) ;
- rendre un pack **privé** (coché par défaut pour un nouveau pack) : un invité ne le voit pas dans le jeu, et ses images et sons renvoient 404 sans le mot de passe.

Le bandeau en haut du jeu indique toujours l'état : **Invité** (bouton « + Ajouter mes images & sons ») ou **Connecté** (packs privés visibles dans le menu, marqués 🔒, boutons « Gérer mes packs » et « Se déconnecter »).

Le pack **Fruits** est celui par défaut et ne peut pas être modifié. Un niveau sans image ou sans son dans un pack perso reprend celui du pack Fruits.

## Stockage (pas de base de données)

```
patate/default_pack/      pack « Fruits » : pack.json + img_0..7.png + snd_0..7.mp3
data/packs/<id>/          packs perso : même format (dossier ignoré par git)
data/secret_key           clé de session générée au premier lancement
```

Les images du pack Fruits sont des fruits dessinés simples, et ses sons sont pour l'instant des MP3 silencieux (0,3 s) : remplace `patate/default_pack/snd_N.mp3` par de vrais sons (niveau 0 = cerise … 7 = pastèque). Les images envoyées sont converties en PNG de 512 px maximum ; les sons acceptés sont MP3, WAV et OGG.

## Crédits

- Moteur physique : [Planck.js](https://github.com/piqnt/planck.js) (licence MIT), copié dans `patate/static/vendor/`.
- Polices manuscrites : [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) et [Gochi Hand](https://fonts.google.com/specimen/Gochi+Hand) (SIL Open Font License), copiées dans `patate/static/fonts/`.
