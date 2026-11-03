# ProjectCG — Point Control

Jeu original de Nitarii. © 2026 Nitarii. Tous droits réservés. Toute copie ou redistribution sans autorisation écrite est interdite. Voir [LICENSE](LICENSE).

## Déploiement

Le dépôt contient déjà le fichier de publication automatique GitHub Pages. Pour terminer la mise en ligne, ajouter à la racine du dépôt **le contenu** du dossier `ProjectPC-v2.6` de l'archive préparée, notamment `public/index.html`, `public/js/game.js`, `public/css/styles.css` et `src/server/` (sans conserver le dossier `ProjectPC-v2.6` comme sous-dossier).

Puis dans **Settings → Pages**, choisir **Source : GitHub Actions**. Une fois la publication réussie, l'interface sera accessible sur https://nitarii.github.io/ProjectCG/ .

**Attention :** GitHub Pages ne peut pas exécuter le serveur Node.js/WebSocket. Pour jouer au jeu multijoueur, lancer le serveur séparément via `START_ONLINE.bat` sur un PC, puis saisir dans le site l'adresse HTTPS du tunnel Cloudflare. Le PC hébergeant la partie doit rester connecté.

La base des profils (`data/profiles.json`) et les données de joueurs ne doivent jamais être envoyées dans ce dépôt public.
