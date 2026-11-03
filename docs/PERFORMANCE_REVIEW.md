# ProjectPC v2.6 — Revue technique globale

## Objectif

Cette passe ne cherche pas à ajouter du gameplay. Elle vise la stabilité, la latence ressentie, le coût CPU serveur, le trafic WebSocket, les FPS des clients distants et la maintenabilité du prototype à ~99 combattants.

## Méthodes de référence retenues

- Serveur autoritaire, prédiction locale pour le joueur contrôlé et interpolation/extrapolation pour les entités distantes.
- Snapshots limités + interest management spatial plutôt qu'un état complet de la carte pour chaque client.
- Contrôle explicite de la congestion WebSocket via `bufferedAmount` / file d'écriture.
- Boucle simulation à fréquence fixe avec rattrapage plafonné, plutôt qu'une accumulation de callbacks en retard.
- Spatial hashing pour les requêtes de proximité répétées.
- Réutilisation des buffers temporaires A* pour limiter les allocations/GC.
- Canvas adaptatif et rendu basse résolution pour les effets plein écran coûteux.
- Buffers audio réutilisés pour éviter de générer du bruit aléatoire complet à chaque tir/pas.
- Cloudflare Tunnel en protocole `auto` : QUIC privilégié, repli HTTP/2 automatique.

Références consultées :
- Cloudflare Tunnel / protocol auto / QUIC : https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/
- Quick Tunnel : https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- WebSocket bufferedAmount : https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
- Canvas optimization : https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
- Client prediction / reconciliation / interpolation : https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html
- Snapshot interpolation/compression : https://gafferongames.com/post/snapshot_interpolation/

## 1. Boucle serveur

### Avant

La simulation utilisait `setInterval`. Sous charge, plusieurs callbacks pouvaient se retrouver exécutés presque à la suite après un retard important.

### v2.6

- boucle fixe 30 Hz dédiée (`core/fixed-loop.js`) ;
- rattrapage limité à 2 ticks ;
- abandon du retard excessif après une suspension longue ;
- métriques : coût moyen d'un tick, retard moyen/max de boucle.

Cela privilégie la stabilité temporelle à la tentative de « rattraper » une seconde de simulation en rafale.

## 2. bots et recherches de proximité

### Problème

Beaucoup de décisions réalisaient encore des scans `for (players.values())` : cible, menace, séparation, soins, réanimation, radar, snapshots.

### v2.6

Un `SpatialHash` dynamique est reconstruit une seule fois à la fin de chaque tick et réutilisé au tick suivant. Il alimente notamment :

- recherche d'ennemis locaux ;
- menace immédiate ;
- séparation des alliés ;
- allié blessé / au sol ;
- joueurs pertinents pour un snapshot ;
- sons de pas proches ;
- repérage humain local.

Le pire cas global existe toujours dans certains traitements rares, mais le hot path n'est plus dominé par des scans complets répétés.

## 3. Pathfinding

### Problème

Chaque calcul A* recréait plusieurs gros TypedArrays (`gScore`, `parent`, `closed`). Avec de nombreuses bots recalculant des chemins, cela génère inutilement des allocations et de la pression GC.

### v2.6

- scratch buffers réutilisés pour les chemins à pied ;
- scratch buffers réutilisés par type/gabarit de véhicule ;
- les grilles statiques restent mises en cache ;
- les checks de murs continuent à exploiter l'index spatial des obstacles.

## 4. Réseau WebSocket

### Déjà présent

- serveur autoritaire ;
- snapshots 15 Hz ;
- interpolation/extrapolation client ;
- tirs en événements séparés ;
- format compact pour les joueurs distants ;
- interest radius ;
- skip de snapshot si backlog important.

### v2.6

- congestion adaptative par client : 15 Hz normal, cadence abaissée uniquement pour un client dont la file réseau grossit ;
- rayon d'intérêt réduit temporairement si ce client est en retard ;
- `TCP_NODELAY` activé sur les sockets ;
- keepalive TCP ;
- ping/pong WebSocket et nettoyage des connexions fantômes ;
- cadence radar/méta abaissée à 5 Hz ;
- radar compact en tableaux au lieu de répéter les clés JSON pour chaque allié ;
- inputs clients non critiques sautés si le navigateur a déjà une file d'envoi importante ;
- input continu ~22 Hz, transitions de touches toujours envoyées immédiatement.

Les tirs restent prioritaires et ne dépendent pas du snapshot pour leur affichage.

## 5. HTTP / chargement via tunnel

- ETag + Last-Modified sur les fichiers statiques ;
- réponse 304 quand le navigateur possède déjà la bonne version ;
- timeouts HTTP explicites ;
- `/health` expose désormais les métriques de boucle/réseau utiles au diagnostic.

## 6. Cloudflare Tunnel

`START_ONLINE.bat` :

- vérifie d'abord si le serveur local répond ;
- ne lance pas volontairement un second serveur s'il existe déjà ;
- attend `/health` avant d'ouvrir le tunnel ;
- utilise `--protocol auto` : Cloudflare privilégie QUIC et repasse en HTTP/2 si UDP n'est pas disponible ;
- réduit le bruit des logs (`warn`).

Un Quick Tunnel reste un outil de test : pas de garantie d'uptime et limite Cloudflare actuelle de 200 requêtes en vol. Pour une publication durable, utiliser un Named Tunnel + domaine.

## 7. Client / FPS

### Canvas

- culling spatial des obstacles et entités conservé ;
- brouillard de murs basse résolution conservé ;
- résolution interne désormais adaptative : elle descend doucement si le temps de frame reste mauvais et remonte lentement si la machine a de la marge ;
- carte tactique plafonnée à ~30 rendus/s au lieu de redessiner ses ~1000 obstacles à chaque frame d'un écran 144 Hz.

### Audio

Ancien coût caché important : chaque tir/pas créait et remplissait un nouveau `AudioBuffer` de bruit aléatoire. En gros combat, cela provoquait beaucoup d'allocations JavaScript et de travail audio.

v2.6 génère un buffer de bruit unique à l'ouverture de l'AudioContext puis le réutilise pour tirs, explosions et pas.

## 8. Persistance

- sauvegarde des profils déplacée dans `persistence/profile-store.js` ;
- écriture atomique `.tmp` -> renommage ;
- écriture asynchrone pendant le fonctionnement normal pour éviter de bloquer le tick serveur ;
- flush synchrone uniquement à l'arrêt ;
- sauvegarde de secours conservée si JSON corrompu.

## 9. Interface / maintenabilité

Le vieux menu unique a été remplacé par quatre fenêtres séparées :

1. Inventaire / achats
2. Équipe / escouade
3. Admin
4. Paramètres

Cela évite un gigantesque panneau vertical et permet d'ajouter plus tard une fenêtre statistiques, graphismes, contrôles, serveur, etc. sans re-casser tout le layout.

## 10. Nouveaux fichiers structurants

```text
src/server/core/spatial-hash.js
src/server/core/fixed-loop.js
src/server/persistence/profile-store.js
scripts/stress-local.js
docs/PERFORMANCE_REVIEW.md
```

## 11. Ce qui reste le plus intéressant pour une future grosse version

Par ordre d'impact potentiel :

1. vrai protocole snapshot binaire ou delta-compressé avec ACK de baseline ;
2. worker/OffscreenCanvas pour une partie de la carte/fog si le client web reste la cible finale ;
3. séparation du gros fichier serveur en domaines `bots/`, `combat/`, `vehicles/`, `match/` avec tests unitaires dédiés ;
4. métriques Prometheus/CSV pour stress tests longs ;
5. passage d'un Quick Tunnel à un Named Tunnel ou hébergement VPS lorsqu'il y aura des joueurs réguliers ;
6. serveur de partie par processus/worker si plusieurs matchs doivent tourner sur la même machine.

Ces étapes demandent plus de changements de protocole/architecture et doivent être faites avec des tests multi-clients systématiques.
