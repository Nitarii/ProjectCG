# Développement rapide

## Vérifier avant de lancer

```bash
npm run verify
```

Cette commande vérifie la syntaxe des fichiers principaux puis exécute les self-tests serveur sans ouvrir de port.

## Lancer

```bash
npm start
```

Puis ouvrir `http://localhost:8080`.

## Principes à conserver

1. Toute nouvelle mécanique compétitive doit être validée côté serveur.
2. Ne jamais envoyer au client des secrets, tokens administrateur, données de profils ou ennemis censés être invisibles.
3. Préférer des événements réseau ponctuels à la répétition d'un même événement dans chaque snapshot.
4. Pour une nouvelle entité persistante, transmettre un état compact ; pour une explosion/tir/son, transmettre un événement.
5. Ajouter un test dans `runGeometrySelfTests()` lorsqu'une correction touche combat, économie, véhicule, hitbox ou navigation.
