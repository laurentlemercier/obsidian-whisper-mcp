# Obsidian Whisper MCP — V0.5.1

Plugin Obsidian desktop qui utilise ton serveur Whisper via MCP Streamable HTTP.

## Fonctionnalités

- Connexion MCP avec `initialize` puis `tools/list`.
- Transport HTTP via `requestUrl()` d'Obsidian pour éviter l'Origin `app://obsidian.md` de la WebView.
- Endpoint normalisé automatiquement avec `/mcp/`.
- Bearer API token.
- `small` / `medium`.
- Langue configurable (`auto`, `fr`, etc.).
- Transcription d'un fichier audio du vault via `transcribe_data`.
- Polling via `get_transcription_status`.
- Récupération via `get_transcription_result`.
- Affichage du résultat dans une modal.
- **Nouveau V0.2 : insertion de la transcription dans la note Markdown active.**

## Commandes

- `Whisper MCP: Transcrire un fichier audio`
- `Whisper MCP: Transcrire et insérer dans la note active`

La seconde commande ajoute en fin de note :

```markdown
## Transcription Whisper

> **Fichier audio :** Audio/Recording_....m4a
> **Modèle :** small
> **Langue :** auto

Texte transcrit...
```

## Build

```powershell
npm install
npm run build
```

Copier ensuite `main.js` et `manifest.json` dans :

```text
<Vault>/.obsidian/plugins/whisper-mcp/
```

## Test

1. Configurer l'endpoint MCP, par exemple `http://192.168.1.10:8000/mcp/`.
2. Configurer le token si nécessaire.
3. Utiliser `Tester la connexion MCP`.
4. Ouvrir une note Markdown.
5. Utiliser `Transcrire et insérer dans la note active`.


## V0.3.1

- Répertoire audio configurable dans les paramètres (par défaut `Audio`).
- Modal de sélection avec recherche et tri par nom, taille, date de création et date de modification.
- Tri initial par date de modification décroissante.
- Affichage de la taille en o/Ko/Mo/Go et des dates localisées.
- La transcription insérée contient un lien Markdown cliquable vers le fichier audio, avec un chemin relatif correct depuis la note.


## V0.4.0 — transcription automatique

- Option **Transcription automatique des nouveaux enregistrements**.
- Surveillance des nouveaux fichiers audio créés dans le **Répertoire audio** configuré.
- Chaque transcription automatique est enregistrée dans un fichier Markdown séparé sous le **Répertoire des transcriptions** (par défaut `Clippings`).
- Nom généré : `YYYYMMDD_HHMM_<nom-audio>.md`, avec suffixe `_2`, `_3`, etc. en cas de collision.
- Le lien Markdown vers le fichier audio est inclus dans chaque note pour permettre sa réécoute depuis Obsidian.
- La transcription automatique utilise les réglages MCP, modèle et langue actuellement configurés.
- Le plugin attend brièvement après la création du fichier audio afin de limiter le risque de lire un fichier encore en cours d’écriture.

La transcription automatique est **désactivée par défaut**. Elle ne traite pas rétroactivement les fichiers déjà présents lors du chargement du plugin ; seuls les nouveaux fichiers créés après l’activation sont détectés.


## V0.4.2

Le répertoire de sortie des notes de transcription automatique est configurable dans les paramètres du plugin. La valeur par défaut est `Clippings`. Le chemin est relatif à la racine du vault et les sous-répertoires sont créés automatiquement si nécessaire.

## V0.5.0 — Enregistrer et transcrire

La commande **Whisper MCP: Enregistrer et transcrire** pilote le module natif **Audio recorder** d’Obsidian.

1. Ouvrir une note Markdown.
2. Lancer la commande `Whisper MCP: Enregistrer et transcrire` depuis la palette de commandes (un raccourci peut lui être attribué dans Obsidian).
3. Le plugin démarre l’enregistrement natif d’Obsidian.
4. Arrêter l’enregistrement avec le bouton natif Audio recorder.
5. Le plugin détecte le nouveau fichier ajouté à la note, attend qu’il soit stable, puis le transcrit via le serveur MCP.
6. Une note est créée dans le répertoire `Clippings` configuré.
7. Un lien vers cette note de transcription est ajouté à la note active.

Le fichier audio reste à l’emplacement choisi par les réglages natifs d’Obsidian. Aucun déplacement du fichier n’est nécessaire pour ce mode.
