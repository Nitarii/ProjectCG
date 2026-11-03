# Architecture — ProjectPC v2.5

## Vue d'ensemble

```text
ProjectPC-v2.5/
├─ server.js                    # bootstrap minimal
├─ src/server/
│  ├─ index.js                  # simulation autoritaire, réseau et gameplay
│  ├─ config/
│  │  ├─ catalog.js             # armes, soins, outils, accessoires, profils bots
│  │  └─ map.js                 # équipes, carte procédurale, zone de guerre
│  └─ net/simple-ws.js          # implémentation WebSocket sans dépendance npm
├─ public/
│  ├─ index.html                # interface
│  ├─ css/styles.css            # styles
│  └─ js/game.js                # client rendu/input/audio
├─ data/                        # données runtime, non publiées dans Git
├─ scripts/verify.js            # syntaxe + tests serveur
└─ docs/
```

## Autorité serveur

Le client n'est jamais autoritaire pour les dégâts, tirs, munitions, collisions, XP, argent, licences, véhicules, captures ou réanimations. Le serveur valide les actions reçues puis envoie l'état résultant.

## Flux réseau

- Simulation serveur : 30 Hz.
- Snapshots autoritaires : **15 Hz**, puis interpolation/extrapolation côté client.
- Physique serveur : **30 Hz** ; décisions bots : **15 Hz**.
- Métadonnées radar/match : fréquence réduite et séparée des animations locales.
- Les autres combattants utilisent un format réseau compact et une zone d’intérêt spatiale.
- Les véhicules lointains sont représentés par un état léger dans le radar ; les sièges/occupants détaillés ne sont envoyés qu’à proximité.
- Les tirs utilisent des messages `shot_batch` immédiats filtrés par proximité/segment de tir. Les projectiles ne dépendent plus de l’horloge locale des différents PC.
- Les snapshots sont jetables : lorsqu’un socket accumule trop de données, le serveur saute les états intermédiaires plutôt que de créer de la latence croissante.

## Données persistantes

`data/profiles.json` est créé automatiquement au premier lancement. Il est volontairement ignoré par Git : ne jamais le publier ni l'inclure dans un dépôt public.

## Où modifier quoi ?

- Valeurs d'armes / déblocages / coûts : `src/server/config/catalog.js`
- Taille de carte / équipes / génération du décor : `src/server/config/map.js`
- bots, véhicules, combat, économie, snapshots : `src/server/index.js`
- Rendu, inputs, UI, audio : `public/js/game.js`
- Apparence : `public/css/styles.css`
- Interface HTML : `public/index.html`


## v2.6 — composants de performance

- `src/server/core/fixed-loop.js` : ordonnanceur fixed-step avec rattrapage borné.
- `src/server/core/spatial-hash.js` : index spatial dynamique des acteurs.
- `src/server/persistence/profile-store.js` : persistance atomique/asynchrone des profils.
- `scripts/stress-local.js` : banc de charge WebSocket local.
- `/health` : télémétrie légère de boucle et de réplication réseau.

Le protocole conserve un serveur autoritaire. Les snapshots d'état sont jetables et adaptatifs ; les événements importants (tirs, achats, actions) restent des messages fiables séparés. L'objectif est qu'un client lent ne puisse pas transformer sa propre congestion en retard accumulé de plusieurs secondes.
