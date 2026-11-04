## v3.1.0-alpha — Rechargements par arme, accroupissement et structures 3D

- 13 rigs d'armes procéduraux avec séquences de rechargement différentes et synchronisation serveur.
- Fusil à pompe à cartouches successives, interruptible lorsque la chambre dispose d'une munition.
- Accroupissement Ctrl/C : vitesse, précision, hauteur de visée et hitbox ajustées.
- Herbe et buissons déterministes LOD ; ~1 200 arbres solides côté serveur.
- 320 bâtiments à véritables ouvertures, espaces intérieurs et 53 structures à deux niveaux avec escaliers.
- Collisions avec murs et planchers, réplication des hauteurs d'acteurs et tirs tenant compte de la hauteur.
- Tests de régression sur les escaliers, 13 armes, carte, protocole réseau, moteur WebGL simulé.

# Changelog

## v2.6 — audit performance / réseau / menus

- Boucle serveur fixed-step à rattrapage borné et métriques de performance dans `/health`.
- Spatial hash dynamique pour les combattants et réutilisation de buffers A* afin de réduire scans complets et allocations.
- Backpressure WebSocket adaptative par client via `bufferedAmount`, fréquence/interest radius réduites avant abandon des snapshots périmés.
- Radar compact, cache court de l'état de match, heartbeat ping/pong, TCP NoDelay et timeouts HTTP.
- Sauvegardes profils atomiques/asynchrones en jeu.
- ETag/304 et cache HTTP des assets.
- `cloudflared --protocol auto` et démarrage en ligne avec vérification de santé.
- Résolution de rendu adaptative, fréquence de certains effets ajustée et buffers audio procéduraux réutilisés.
- Menu séparé en quatre fenêtres : Inventaire/Achats, Équipe/Escouade, Admin, Paramètres.
- `npm run stress` ajouté pour les tests synthétiques multi-clients.

## v2.5 — visée/caméra et cadence sniper

- Fusils à verrou fortement ralentis : .308 à **0,40 tir/s** (~2,5 s entre deux tirs) et Magnum à **0,28 tir/s** (~3,6 s).
- Zoom de visée calculé à partir de la portée de l'arme : les armes longue portée zooment davantage, sans changement brutal de cadrage.
- Nouveau lissage `SmoothDamp` du zoom et du décalage de caméra pour conserver une vitesse de transition continue à l'appui/relâchement du clic droit.
- Compensation exacte du changement d'échelle autour du personnage : le joueur ne saute plus visuellement vers le haut/bas lorsque le zoom commence ou se termine.
- En maintenant clic droit, déplacer le réticule crée un **look-ahead progressif** dans sa direction pour voir plus loin ; amplitude plus importante avec les armes longue portée.
- Le look-ahead est calculé en espace écran, indépendamment de l'angle de visée, afin d'éviter les boucles de rétroaction et les oscillations de caméra.

## v2.4 — optimisation multijoueur / rendu client

- Snapshots d’état à 15 Hz avec interpolation/extrapolation visuelle côté client.
- Prédiction visuelle du déplacement du joueur local pour masquer la latence réseau sans déplacer l’autorité hors du serveur.
- Format réseau compact pour les combattants distants et zone d’intérêt de réplication.
- Etats détaillés des véhicules envoyés seulement lorsqu’ils sont proches/pertinents ; état léger pour la carte/minimap.
- Tirs séparés des snapshots via `shot_batch` immédiat et filtré spatialement.
- Correction du bug d’horloges différentes serveur/client qui rendait balles et tracers invisibles chez certains joueurs Internet.
- Backpressure WebSocket : snapshots intermédiaires abandonnés pour les clients en retard au lieu d’accumuler une file d’attente.
- bots : logique à 15 Hz, physique à 30 Hz ; repérage d’équipe réutilisant les cibles bots déjà calculées.
- Vision et brouillard de guerre rendus sur canvases basse résolution ; brouillard mural mis en cache.
- Minimap, HUD et éléments DOM rafraîchis moins souvent ; culling renforcé du rendu hors écran.
- Résolution interne du canvas plafonnée à 1,35×.
- Stress test synthétique local 8 clients : ~28,9 Mo → ~4,7 Mo de snapshots sur 5 s et ~28 % → ~6,5 % d’un cœur CPU dans l’environnement de test.

## v2.3 — balistique / réanimation bots
- Dégâts pleins jusqu’à la portée nominale, falloff linéaire jusqu’à 0 au double de la portée.
- Tirs, murs et véhicules utilisent la nouvelle distance balistique.
- Réanimation opportuniste des alliés proches par les bots quand la zone est jugée sûre.
- Réticule adapté aux zones de falloff.


## v2.2 — embarquement bots / navettes

- Réservations de sièges passager individuelles au lieu d’une simple réservation générique du véhicule.
- Points d’embarquement séparés par porte/siège afin d’éviter les amas d’bots au centre des véhicules.
- Priorité aux navettes dédiées et remplissage des véhicules déjà entamés avant d’en ouvrir un nouveau.
- Réservations stables pendant l’approche, embarquement accéléré et sécurité anti-bouchon à très courte distance.
- Positions d’attente dispersées dans la base pour libérer les voies de circulation.
- Répulsion alliée réduite lors de l’embarquement et nettoyage des réservations plus robuste.
- Tests dédiés au flux d’embarquement complet d’une jeep.
- Gestion explicite des erreurs socket WebSocket pour qu’un `ECONNRESET` client ne fasse plus tomber tout le serveur.

## v2.1 — escouades, véhicules et soins

- Navettes dédiées pleines avant départ, réparation en base, embarquement plus rapide.
- Escouades humaines et marquage vert sur terrain/carte/minimap.
- Prévisualisation G pour grenades/flash/mines.
- Soins d’alliés, soins en mouvement ralenti, XP/argent de soutien.
- Affichage des places véhicule, orientation véhicule corrigée, ombre supprimée.
- Prix des licences réduits et équipement bots haut niveau raréfié.
- Rechargement vérifié sur tout l’arsenal avec chargeur visuel absent pendant la manipulation.

## v2.0 — transports et capture globale

- Les bots hors de la Zone de guerre attendent désormais un transport au lieu de parcourir la carte à pied.
- Recherche des véhicules limitée à la zone de base pour éviter que les passagers courent à la rencontre d’une navette encore loin.
- Débarquement bots fiabilisé : entrée plus profonde dans la Zone de guerre, nettoyage du pathfinding et temporisation anti-remontée.
- Navigation véhicules optimisée grâce à l’index spatial des obstacles ; suppression du gros pic CPU lors de la création initiale de la grille A*.
- L’état réseau expose maintenant le poids de présence par équipe dans la Zone de guerre, le leader, l’égalité éventuelle et l’avancement du cycle de 10 s.
- HUD : score + poids de présence, barre de cycle colorée selon l’équipe en tête.
- Égalité en tête = aucun point attribué à la fin du cycle.
- Ajout de tests automatiques sur l’égalité de capture, l’attente transport et le débarquement au front.

## v1.9 — hitmarker

- Ajout d’un hitmarker visuel bref sur le réticule lorsqu’un tir du joueur touche un ennemi.
- Ajout d’un son de confirmation d’impact court et distinct, réglé par le volume des effets.
- Le serveur confirme l’impact : un tir allié, un mur ou un véhicule ne déclenche pas le hitmarker.
- Fusil à pompe : une seule confirmation par coup même si plusieurs plombs touchent la même cible.

## v1.8 — revue technique

- Conducteurs **et passagers** ne peuvent plus tirer, viser, recharger, utiliser un outil ou un accessoire depuis un véhicule. Validation client + serveur.
- Suppression du vieux message réseau `weapon` comme moyen de changer gratuitement d'arme : le loadout/économie reste l'unique chemin autoritaire.
- Réduction importante du trafic : tirs et effets ponctuels ne sont plus renvoyés 30 fois/s à chaque joueur ; ils sont transmis une seule fois via WebSocket fiable.
- Radar et état de match lourds limités à 10 Hz, tout en gardant positions/visée/véhicules à 30 Hz.
- Index spatial côté client pour les obstacles : particules, brouillard, minimap et rendu principal ne parcourent plus toute la carte à chaque frame.
- Culling du décor hors écran/proximité pour diminuer le coût de rendu sur les grandes cartes.
- Durcissement HTTP : traversée de chemin corrigée, URL malformées gérées, méthodes limitées, headers de sécurité.
- Protection anti-flood WebSocket simple.
- Migration automatique des clés `isofront.*` vers `projectpc.*` pour conserver pseudo, token/progression, clavier et volume.
- `data/profiles.json` n'est plus livré/committé : il est créé au runtime et ignoré par Git.
- Si `profiles.json` devient illisible, le serveur conserve une **copie de secours horodatée** avant de repartir sur une base vide, afin de faciliter la récupération.
- Réorganisation du projet en `src/server`, `public/js`, `public/css`, `scripts`, `docs`.
- Commande `npm run verify` : vérification syntaxique + batterie de tests serveur.
