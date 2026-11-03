# ProjectPC — Point Control v2.6

**Développeur : Nitarii**

Shooter tactique PvP top-down/isométrique à trois équipes avec serveur WebSocket autoritaire et progression persistante.



## v2.6 — audit performance, réseau et interface modulaire

Cette version est une **revue technique globale** plutôt qu'une simple passe de contenu. Le serveur reste autoritaire, mais les chemins chauds réseau/bots/rendu/persistance ont été restructurés et instrumentés.

- Boucle serveur remplacée par une **fixed timestep** à rattrapage borné : un gros retard ne provoque plus une longue boucle de ticks de rattrapage qui aggrave le lag. `/health` expose maintenant coût moyen d'un tick, retard de boucle, snapshots envoyés/sautés et octets WebSocket.
- **Spatial hash dynamique** pour les combattants : recherches de cibles, alliés, réanimations, séparation bots, radar et réplication ne rescannent plus systématiquement les 99 personnages.
- A* piéton/véhicule conserve maintenant des **buffers typés réutilisables**, ce qui réduit les allocations et les pics de garbage collector pendant les recalculs de chemin.
- Réplication WebSocket adaptative par client : lorsque `bufferedAmount` monte, ProjectPC réduit d'abord la fréquence et la zone d'intérêt puis abandonne les snapshots intermédiaires périmés au lieu de laisser grossir la file réseau.
- Radar compacté en tableaux numériques et état de match mis en cache quelques millisecondes pour éviter de reconstruire le même JSON lourd pour chaque client.
- Keepalive WebSocket, TCP `NoDelay`, détection de clients morts et timeouts HTTP plus stricts.
- Fichiers statiques avec `ETag` / `304 Not Modified` et cache court ; le HTML reste `no-store`.
- `START_ONLINE.bat` attend réellement `/health`, refuse les doubles serveurs et lance `cloudflared --protocol auto`, laissant Cloudflare privilégier QUIC puis retomber sur HTTP/2 si nécessaire.
- Client : entrées réseau limitées, **résolution de rendu adaptative**, fréquence du brouillard/minimap/HUD modulée et bruit audio procédural mis en cache au lieu de recréer un buffer à chaque son.
- Persistance : sauvegarde de profils **atomique et asynchrone** pendant la partie, flush synchrone réservé à l'arrêt ; sauvegarde de secours en cas de JSON corrompu conservée.
- Le menu `Échap` n'est plus une unique grande fenêtre : **Inventaire / achats**, **Équipe / escouade**, **Admin** et **Paramètres** sont quatre fenêtres distinctes accessibles depuis un dock compact.
- Nouvelle commande `npm run stress` pour ouvrir plusieurs clients WebSocket locaux et mesurer le serveur avec 99 combattants. Dans le test local fourni : **24 clients humains simulés + 75 bots**, coût moyen d'un tick ~**3,0 ms**, retard moyen ~**0,31 ms**, sans snapshot sauté sur 8 s. Ces chiffres sont des mesures locales de développement, pas une promesse de performances Internet.

Voir `docs/PERFORMANCE_REVIEW.md` et `docs/TUNNEL.md` pour le détail des décisions et les pistes futures.

## v2.5 — visée plus stable et snipers plus réalistes

- Les deux fusils à verrou ont une cadence fortement réduite : **.308 ≈ 1 tir toutes les 2,5 s**, Magnum ≈ **1 tir toutes les 3,6 s**. Le DMR reste semi-auto et n'est pas concerné par ce cycle de verrou.
- Le zoom au clic droit dépend maintenant de la **portée réelle de l'arme** : faible avec une arme courte, progressivement plus puissant avec les fusils longue portée.
- La transition utilise un lissage de type `SmoothDamp` et conserve sa vitesse lorsque tu presses ou relâches le clic droit : plus de snap/rebond brutal.
- Le changement de zoom est compensé autour de la position du personnage. L'ancien effet où la caméra semblait rapidement se replacer au-dessus du joueur pendant la transition est supprimé.
- Tant que le clic droit est maintenu, déplacer le réticule vers un bord de l'écran fait glisser **doucement** le cadrage dans cette direction. Cela donne davantage de visibilité devant l'arme sans téléporter/recentrer la caméra.
- Les armes longue portée disposent à la fois d'un zoom légèrement plus fort et d'un look-ahead plus important.

## v2.4 — grosse passe optimisation multijoueur / client distant

Cette version cible spécialement les joueurs qui se connectent à distance via Cloudflare et les combats avec beaucoup d’bots.

- Les snapshots réseau passent à **15 Hz** au lieu d’envoyer l’état complet 30 fois/s. Les positions restent rendues à la fréquence de l’écran grâce à interpolation + extrapolation côté client.
- Le joueur local utilise maintenant une **prédiction visuelle de déplacement** avec réconciliation douce vers le serveur : les contrôles restent nettement plus fluides malgré la latence Internet, sans rendre le client autoritaire.
- Les combattants distants sont répliqués sous un format réseau compact et uniquement dans une **zone d’intérêt** assez grande pour couvrir le combat réel (plus de personnages à l’autre bout de la carte dans chaque snapshot).
- Les véhicules lointains utilisent un état radar léger ; les détails de sièges/passagers ne sont envoyés qu’à proximité ou lorsque le joueur est dans le véhicule.
- Les décisions bots sont cadencées séparément de la physique : physique à 30 Hz, logique bots à 15 Hz.
- Le repérage d’équipe réutilise la cible déjà calculée par les bots au lieu de refaire un second scan complet bots × ennemis.
- Protection contre l’accumulation réseau : si un client lent prend du retard, le serveur saute les snapshots intermédiaires au lieu de lui envoyer plusieurs secondes d’état périmé.
- Les tirs ne passent plus par le flux lourd des snapshots : ils utilisent un message **`shot_batch` immédiat** et limité aux joueurs concernés/proches.
- Correction majeure des balles/tracers chez les joueurs distants : le rendu ne dépend plus de l’horloge Windows du serveur. Un décalage d’horloge entre deux PC pouvait faire considérer un projectile comme déjà expiré avant même son affichage.
- Le tireur et ses alliés proches reçoivent donc bien les **balles normales et tracers DMR/sniper** en multijoueur.
- Les gros masques de vision floutés plein écran ont été remplacés par des rendus basse résolution beaucoup moins coûteux. Le brouillard derrière les murs est mis en cache et recalculé moins souvent.
- Minimap limitée à ~11 rafraîchissements/s, HUD/DOM ~10/s, tout en gardant le rendu du jeu à la fréquence écran.
- Culling renforcé des obstacles, joueurs, véhicules, particules et effets hors écran.
- Résolution interne du canvas plafonnée pour éviter de rendre inutilement à 2× la résolution sur certains écrans.

Lors d’un **stress test local synthétique avec 8 clients + 99 combattants**, cette passe a fait passer le trafic snapshots cumulé d’environ **28,9 Mo à 4,7 Mo sur 5 s** et la charge serveur observée d’environ **28 % à 6,5 % d’un cœur CPU** dans cet environnement. Ce n’est pas une garantie de performances sur Internet, mais cela confirme que le principal gaspillage réseau/CPU a été fortement réduit.

## v2.3 — balistique avec perte de dégâts & réanimation bots

- Les balles continuent désormais jusqu’au **double de la portée nominale** de l’arme (ou jusqu’au premier mur / personnage / véhicule touché).
- Jusqu’à la portée nominale : **100 % des dégâts**.
- Entre 1× et 2× la portée : perte de dégâts **linéaire** avec la distance (ex. 1,5× = 50 %).
- À partir de 2× la portée : **0 dégât**.
- Le réticule indique `DÉGÂTS RÉDUITS` au-delà de la portée nominale puis `0 DÉGÂT` à partir du double.
- Les bots peuvent maintenant tenter une **réanimation opportuniste** d’un allié proche si elles n’ont pas d’ennemi visible menaçant, n’ont pas été touchées récemment et n’ont pas vu de cible très récemment. Les profils Secours/Soutien/Tactique sont plus enclins à le faire.
- Une bots annule immédiatement sa réanimation si la situation redevient dangereuse.

## v2.2 — embarquement bots et rotations de navettes

- Refonte de l’embarquement bots à la base pour supprimer les bouchons devant les quads/jeeps.
- Chaque passager réserve maintenant **une place précise** et possède un **point d’embarquement distinct** autour du véhicule au lieu de tous viser son centre.
- Une réservation de véhicule reste stable jusqu’à l’embarquement : les bots ne changent plus constamment de jeep/quad en chemin.
- Les navettes dédiées sont prioritaires et sont remplies **une par une** avant les autres transports, afin de déclencher beaucoup plus vite leurs rotations.
- Les passagers montent dès qu’ils atteignent leur porte ; une sécurité anti-bouchon finalise l’embarquement si une bots est déjà collée au véhicule mais repoussée de quelques pixels par la foule.
- Les bots qui n’ont pas encore de place attendent sur des **positions dispersées dans la base** au lieu de toutes se regrouper au point de spawn ou devant les véhicules.
- La répulsion entre alliés est fortement réduite uniquement pendant l’approche d’un véhicule réservé, ce qui évite qu’ils se bloquent mutuellement.
- Nettoyage renforcé des réservations invalides et des sièges réservés lorsqu’un véhicule part, est détruit ou respawn.
- Ajout de tests automatiques vérifiant 4 réservations de sièges distinctes, 4 points d’embarquement séparés et le remplissage complet d’une jeep sans collision de réservation.
- Correction d’un crash serveur possible lors d’une **déconnexion réseau brutale / ECONNRESET** : perdre un navigateur ou un tunnel ne peut plus terminer le processus serveur.

## v2.1 — véhicules, escouades, soins et lisibilité

- Les **pilotes-navettes dédiés attendent désormais que leur jeep soit pleine** avant de lancer le départ vers la Zone de guerre.
- Les véhicules endommagés se **réparent automatiquement dans leur propre base** ; la réparation démarre après un court délai sans dégâts.
- Les bots montent beaucoup plus vite en passager et un conducteur humain peut repartir presque immédiatement après avoir pris le volant.
- Les quads et jeeps sont légèrement plus rapides. Leur orientation visuelle suit réellement le sens du déplacement et l'ancienne ombre mal positionnée a été supprimée.
- Ajout de **4 escouades par équipe** pour les joueurs humains. On rejoint/quitte une escouade depuis `Échap` ; les membres de son escouade ont leur pseudo et leurs points carte/minimap en vert.
- Affichage des places du véhicule en bas à droite avec conducteur, passagers, places libres et remplissage.
- Killfeed simplifiée : `Pseudo1 a tué Pseudo2 (Arme)`.
- `G` maintenu affiche maintenant la **prévisualisation de trajectoire** d'une frag/flash et l'emplacement prévu d'une mine ; l'accessoire est utilisé au relâchement.
- Le panneau admin peut aussi **ajouter/retirer de l'argent** et téléporter le joueur sélectionné au Point de contrôle.
- Le menu pause/loadout a été compacté pour tenir sur un seul écran sur la majorité des résolutions, avec repli adaptatif sur les très petits écrans.
- Les humains au sol ne sont plus forcés de respawn : après le délai minimal, `Espace` reste un choix et ils peuvent attendre une réanimation indéfiniment.
- Les armes très haut niveau sont beaucoup plus rares chez les bots et le prix des licences a été abaissé (première PM : **5 000 €** de licence).
- Tous les modèles d'armes ont maintenant un élément de chargeur visible : pendant les 2 s de rechargement il disparaît de l'arme et un chargeur tombe au sol. Un test serveur couvre toutes les armes.
- Les soins peuvent être utilisés en marchant, avec une vitesse réduite. À proximité d'un allié blessé, `E` utilise son objet médical sur lui : la cible s'immobilise pendant le soin et le soigneur reçoit **XP + argent**.
- Les tests couvrent aussi l'attente d'une navette pleine, la réparation en base et les escouades.

## v2.0 — transports bots et lisibilité de la capture

- Les combattants bots hors de la Zone de guerre **n’effectuent plus le trajet complet à pied** : ils restent à la base, prennent un véhicule disponible ou attendent le retour d’une navette/conducteur allié.
- Les réservations de places restent respectées : une bots n’abandonne pas sa réservation pour courir vers le front.
- Arrivée des quads/jeeps au front durcie : les véhicules entrent plus profondément dans la Zone de guerre avant le débarquement, les anciens chemins bots sont effacés et un délai empêche une remontée immédiate dans le même véhicule.
- Correction d’un gel possible au premier départ des véhicules : la génération de la grille de navigation véhicule exploite maintenant l’**index spatial des obstacles** au lieu de tester toute la carte pour chaque cellule.
- L’interface affiche, à côté du score de chaque équipe, son **poids de présence dans la Zone de guerre**. Un personnage dans le Point de contrôle compte pour 2.
- La barre supérieure représente désormais le **cycle de score de 10 secondes** de la Zone de guerre et prend la couleur de l’équipe actuellement en tête.
- En cas d’égalité en tête entre 2 ou 3 équipes à la fin d’un cycle, **aucun point n’est attribué**.

## Point Control

- **33 combattants par équipe**, soit 99 combattants lorsque les trois équipes sont complètes.
- Deux pilotes-navettes dédiés par équipe.
- Immense **Zone de guerre** centrale.
- Présence récompensée toutes les 5 s.
- Toutes les 10 s, l'équipe ayant le plus grand poids de présence gagne 1 point.
- Première équipe à **100 points** : victoire.
- Le **Point de contrôle** mobile se trouve dans la Zone de guerre : un combattant dessus compte double et ses gains positifs d'XP/argent sont doublés.

## Progression et économie

- Nouveau profil : **Pistolet 9 mm + Bandage** gratuits.
- Niveau requis → achat d'une **licence permanente** → achat moins cher pour chaque vie.
- XP et argent sont persistants.
- Le stuff acheté pour la vie en cours est perdu au respawn ; licences et argent restent acquis.
- `Tab` classe les combattants selon le **gain net d'argent de la manche**.

## Contrôles

- `ZQSD` / `WASD` : déplacement
- `Shift` : sprint
- clic gauche : tirer
- clic droit : viser
- `R` : recharger
- `E` : soin
- `F` court : véhicule / traîner ou lâcher un allié au sol
- `F` maintenu : réanimer
- `K` : conducteur — éjecter les passagers
- `A` AZERTY / `Q` QWERTY : outil
- `G` maintenu : prévisualiser accessoire · relâcher : utiliser
- `Tab` maintenu : classement
- `M` ou `,` : carte tactique
- `Échap` : équipe, boutique, loadout, volume et panneau admin

**Dans un véhicule**, armes, visée, recharge, outils et accessoires sont désactivés pour tous les occupants.

## Structure

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Les fichiers principaux sont maintenant séparés entre serveur, configuration, client, styles, scripts et documentation.

## Lancement local

1. Installer Node.js LTS.
2. Lancer `START_SERVER.bat`.
3. Ouvrir `http://localhost:8080`.

## Lancement Internet

1. Lancer une fois `INSTALL_CLOUDFLARED.bat`.
2. Lancer `START_ONLINE.bat`.
3. Partager l'adresse `https://...trycloudflare.com`.

## Progression / confidentialité

La progression est stockée dans `data/profiles.json`. Le fichier est créé automatiquement au premier lancement et est **ignoré par Git** afin d'éviter de publier accidentellement les données des joueurs.

Pour mettre le projet à jour, conserve simplement ton ancien `data/profiles.json` dans le nouveau dossier.

## Vérification

```text
npm run verify
```

La commande vérifie la syntaxe du serveur/client et exécute les tests de combat, murs, hitboxes, économie, soins, réanimation, véhicules, navigation et la nouvelle interdiction de combat depuis les véhicules.


## v1.9 — Hitmarker

Quand votre tir touche un ennemi, le serveur envoie une confirmation privée au tireur : un X blanc très bref apparaît sur le réticule et un son de hitmarker est joué. Les tirs alliés, impacts décor et véhicules ne déclenchent pas cette confirmation.

## Version GitHub Pages

Site : `https://nitarii.github.io/ProjectCG/`

Les fichiers statiques situés dans `public/` sont publiés automatiquement par
`.github/workflows/pages.yml`, après activation de **Settings → Pages → Source :
GitHub Actions** dans les paramètres du dépôt.

**Important :** GitHub Pages ne peut pas exécuter Node.js ni héberger des WebSockets.
Le serveur autoritaire `src/server/` doit donc rester démarré séparément.
Pour jouer depuis GitHub Pages, lance `START_ONLINE.bat`, récupère l'adresse HTTPS
`trycloudflare.com` produite, puis colle-la dans le champ « Adresse du serveur ».
Cette adresse change généralement à chaque redémarrage du tunnel gratuit.
Il faut que le PC serveur reste allumé pendant les parties.

Le navigateur se connecte directement au serveur externe en WSS et la progression
reste enregistrée uniquement sur la machine qui héberge le serveur.


## Mise à jour 2.7 — stabilité, réseau et interface

Le jeu utilise désormais quatre fenêtres de menu séparées : **Inventaire/Achats**, **Équipe/Escouade**, **Administration** et **Paramètres**. Sur ordinateur, les panneaux peuvent être déplacés depuis leur barre supérieure. Les paramètres affichent la latence aller-retour serveur et les données en attente d'envoi.

**Sécurité de l'administration :** le premier joueur connecté n'est plus automatiquement administrateur. Le serveur affiche un **code confidentiel dans sa console** au démarrage. L'hôte le saisit dans le champ facultatif du menu de connexion. Le code peut être fixé en utilisant la variable d'environnement `PROJECTPC_ADMIN_TOKEN`. Ne jamais le publier ni le partager.

Avant publication : `npm run verify` (simulation et tests réseau). Le déploiement GitHub Pages exécute désormais ces tests automatiquement.

[Revue technique détaillée, composant par composant](docs/TECHNICAL_REVIEW_2.7.md).
