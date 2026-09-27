Whisper MCP 0.5.1

Corrections:
- Enregistrer et transcrire insere directement la transcription dans la note active.
- Aucune note Clippings n'est creee par Enregistrer et transcrire.
- Les transcriptions automatiques continuent de creer des notes dans le repertoire Clippings configure.
- L'historique des fichiers traites est stocke dans processed-audio.json, a la racine du vault.
- Migration automatique de l'ancien whisperProcessedAudioPaths depuis data.json.

Installation:
1. Desactiver le plugin Whisper MCP dans Obsidian.
2. Remplacer main.js et manifest.json dans .obsidian/plugins/whisper-mcp/.
3. Reactiver le plugin (ou redemarrer Obsidian).
