# ProjectCG2 — FPS 3D (prototype technique)

© 2026 Nitarii. Tous droits réservés.

## Ce qui fonctionne

- Une caméra à la première personne avec orientation horizontale et verticale à la souris, verrouillage du pointeur et zoom en visée.
- Un monde 3D WebGL2 affichant la carte existante, les bâtiments, les murs, les combattants des trois équipes, les véhicules et le point de contrôle mobile.
- Les déplacements orientés par la caméra en ZQSD/WASD, validés par le serveur, avec prédiction locale et réconciliation.
- Les systèmes existants de trois équipes, bots, escouades, achat d'équipements, classes d'armes, soins, réanimation, objectifs, véhicules, sauvegardes et administration.
- Tir serveur 3D : azimut + élévation, pesanteur, hauteur d'obstacles, impact sur personnage/véhicule et perte progressive d'énergie. La portée **effective** d'une arme ne constitue plus une limite de distance. Un tir finit au sol, sur un obstacle ou en bordure du monde.
- Tracers 3D des armes qui en utilisent et interface carte/minimap conservée.
- Moteur 3D autonome sans dépendance chargée par CDN. WebGL2 requis ; version 2D de secours en cas d'incompatibilité.

## Commandes

Clique une fois sur la scène après avoir rejoint le serveur pour capturer la souris. Souris : orientation ; clic gauche : tir ; clic droit : visée ; ZQSD/WASD : déplacements ; Maj : sprint ; R : recharger ; X : outil ; E : soins ; F : véhicules/réanimation ; G : accessoire ; Tab : score ; M : carte ; Échap : menu et libération de la souris.

## Échelle provisoire de simulation

La convention actuelle est environ 1 unité = 0,03 m. La gravité simulée est 327 unités/s² (=9,81 m/s²). Les vitesses d'armes du catalogue sont multipliées par trois pour obtenir des ordres de grandeur cohérents avec cette échelle. Cette balistique est un premier modèle de chute et d'atténuation, **pas** une simulation exhaustive du vent, de la pénétration, des matériaux ou de la balistique terminale.

## Performance et limites

- Le serveur conserve 30 ticks/s, 15 snapshots/s et un index spatial. Un rayon de réplication modéré évite de multiplier les raycasts coûteux. Le tir ne possède pas de coupure de portée même au-delà du rayon de réplication visuelle ; l'identification des cibles à très longue distance nécessite un futur LOD réseau.
- Les modèles 3D sont actuellement des volumes procéduraux **simples**. Il n'y a pas encore de vrais modèles humanoïdes, animations squelettiques, textures PBR, terrain sculpté, ombres dynamiques ou navigation sur plusieurs étages.
- Le déplacement et les collisions restent essentiellement calculés sur un sol plat en 2D par le serveur, avec une représentation et une visée en hauteur. Ceci constitue une phase de migration vers un FPS complet.
- WebGL2 n'était pas disponible dans l'environnement Chromium automatisé utilisé lors de la préparation. Les tests Node du serveur et du protocole ont réussi ; un test visuel avec WebGL2 sur PC reste nécessaire.

## Prochaines étapes vers un milsim réaliste

Créer un vrai terrain navigable avec altitude ; personnages animés squelettiques et rigs d'armes ; physique des projectiles continue avec vent et pénétration ; sélection du stance (accroupi/couché), saut/franchissement, collisions 3D, véhicule en conduite FPS, occlusion audio, équipements avec ergonomie ; streaming d'entités à longue distance sans surcharge réseau, LOD, PBR et shaders de lumière/ombres, optimisation GPU selon profil d'ordinateur. Tester systématiquement les interactions client/serveur et le tunnel sur Internet.
