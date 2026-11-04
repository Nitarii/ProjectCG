# ProjectCG2 — FPS 3D v3.1 alpha

© 2026 Nitarii. Tous droits réservés.

## Nouvelles fonctions jouables

- **Rechargements animés par arme** : treize rigs procéduraux distincts, propres à la disposition du chargeur et au type de mécanisme. Mouvements des mains, basculement de l'arme, retrait du chargeur, insertion, manipulation de culasse, ou chargement individuel des cartouches. Le timing vient du serveur pour synchroniser munitions et animation. Le fusil à pompe recharge cartouche par cartouche et peut interrompre cette action pour tirer une cartouche déjà insérée.
- **Accroupissement serveur** : Ctrl maintenu ou C pour basculer l'état. Caméra abaissée progressivement, déplacement environ 44 % plus lent, sprint empêché, précision améliorée, hitbox verticale raccourcie (FPS).
- **Végétation** : 1 197 arbres avec obstacles côté serveur et géométrie côté client ; herbe et buissons procéduraux déterministes avec niveau de détail suivant la distance.
- **Bâtiments** : 320 structures creuses générées avec ouvertures, murs et pièces accessibles, 53 à deux niveaux. Les escaliers modifient la hauteur autoritaire du joueur. Les étages sont répliqués aux clients et les tirs prennent en compte la hauteur des cibles.

## Commandes

**Ctrl** : accroupi (maintenir). **C** : accroupi (basculer). **Maj** : sprint debout. **R** : recharger. Les autres touches de la v3.0 sont conservées.

## Limites honnêtes de cette version alpha

Le rendu conserve les modèles procéduraux géométriques WebGL2 et n'est pas encore une simulation milsim photoréaliste. Les animations sont des poses paramétriques sans squelette et sans motion capture. Le terrain reste plat. Les escaliers et les étages sont accessibles aux joueurs, mais les bots ne savent pas encore planifier des attaques tactiques multi-étages. Les détails intérieurs sont principalement visuels. Les collisions verticales ont été étendues aux joueurs et planchers, mais restent simplifiées et ne constituent pas encore un moteur de physique 3D général. Pas de textures PBR, d'ombres dynamiques ni de pénétration balistique par matériau.

## Validation

La commande `npm run verify` contrôle syntaxe, géométrie, réseau, moteur 3D simulé, accès aux étages, entrées et carte, profils des treize armes. Elle ne remplace pas un test sur un navigateur WebGL2 réel avec une partie multijoueur longue. Pour le mode local, double-cliquer sur `START_LOCAL.bat` avec Node.js installé.
