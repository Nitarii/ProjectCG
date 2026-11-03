# Audit technique ProjectCG 2.7 — 3 novembre 2026

## Portée
Code analysé par composant, syntaxe et auto-tests de géométrie/combat/navigation, tests de régression WebSocket, stress synthétique de 12 clients et 99 acteurs, revue visuelle de l'interface. Aucune campagne prolongée avec des joueurs réels via Cloudflare ; les résultats locaux ne sont pas une promesse de performance Internet.

## Composants examinés

| Composant | Diagnostic et action |
|---|---|
| `server.js` | Bootstrap minimal conservé. |
| `src/server/core/fixed-loop.js` | Simulation fixe 30 Hz, rattrapage limité ; conserver les métriques de durée de tick et de retard. |
| `src/server/core/spatial-hash.js` | Index spatial pour les acteurs proches ; éviter les scans complets répétés. |
| `src/server/config/map.js` | Carte déterministe 60 000 × 52 000 ; vérification de géométrie et navigation. |
| `src/server/config/catalog.js` | Arsenal, soins, véhicules et accessoires conservés ; aucun équilibrage spéculatif. |
| `src/server/net/simple-ws.js` | Validation plus stricte du handshake, des fragments et opcodes ; binaires interdits, file d'envoi bornée. |
| `src/server/persistence/profile-store.js` | Écriture atomique conservée ; retry exponentiel en cas d'erreur et fichier temporaire de fermeture distinct. |
| `src/server/index.js` — réseau | Allowlist d'origines, messages limités, broadcasts sautés sous congestion, snapshots confirmés seulement après envoi accepté. |
| `src/server/index.js` — sécurité | Premier client n'est plus administrateur ; code admin secret requis, affiché seulement dans la console du serveur. |
| `src/server/index.js` — simulation | Combats, équipements, revives, outils, bots, navigation et objectifs couverts par l'auto-test existant. |
| `src/server/index.js` — snapshots | Cadences 15 Hz / métadonnées ~5 Hz et intérêt spatial conservés ; compteur octets correctement mis à jour. |
| `public/js/game.js` | Quatre fenêtres indépendantes via le dock ; panneaux déplaçables à la souris sur ordinateur ; RTT mesurée toutes les ~3 s. |
| `public/css/styles.css` | Fenêtres dimensionnées individuellement, repli responsive pour écrans étroits. |
| `public/index.html` | Inventaire/Achats, Équipe/Escouade, Admin, Paramètres ; champ code admin privé facultatif. |
| `START_ONLINE.bat` / `START_TUNNEL.bat` | Quick Tunnel conservé ; protocole auto QUIC/HTTP2 ; URL temporaire. |
| `.github/workflows/pages.yml` | Le déploiement Pages dépend désormais de `npm run verify`. |
| `scripts/test-network.js` | Nouveaux tests : fragments texte, trames illégales, données binaires, consommateurs lents, handshake invalide. |

## Mesures / résultats locaux
Stress synthétique : 12 clients WebSocket ; 99 combattants (humains + bots) ; 3,5 secondes de charge. Coût moyen tick ~2,41 ms ; retard moyen de boucle ~0,39 ms ; 0 snapshots ignorés, trafic serveur sortant ~1,70 Mo/s. Les clients ne tiraient pas pendant cette mesure ; cela n'évalue pas les pics de combat. Auto-tests jeu et protocole réussis. Inspection Chromium sans erreur JavaScript lors des changements de fenêtres (connexion HTTP locale non autorisée dans l'environnement Chromium du test).

## Cloudflare et sécurité
Cloudflare prend en charge WebSocket, mais Quick Tunnel n'offre ni adresse stable ni garantie de disponibilité. Préférer un Named Tunnel pour une mise en ligne pérenne. Limiter les origines navigateur autorisées (`PROJECTPC_ALLOWED_ORIGINS`), garder le secret admin hors GitHub (`PROJECTPC_ADMIN_TOKEN` facultatif) et surveiller la RTT. La vérification d'Origin ne remplace pas l'authentification des joueurs.

## Prochaines mesures à effectuer
Capturer les percentiles P50/P95/P99 du temps CPU et de latence sur 10–30 minutes de véritable combat ; simuler tirs, véhicules et explosions simultanés ; éprouver la déconnexion/reconnexion réelle du tunnel ; ajouter fuzzing RFC 6455 et tests sur 720p/4K/ultrawide ; poursuivre la séparation du gros fichier `src/server/index.js` en modules.

## Références
- https://developers.cloudflare.com/network/websockets/
- https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
