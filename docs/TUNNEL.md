# Cloudflare Tunnel — ProjectPC

## Mode actuel

`START_ONLINE.bat` utilise un Quick Tunnel `trycloudflare.com`.

Le transport est laissé en `auto` : QUIC est privilégié ; si UDP n'est pas disponible, `cloudflared` repasse automatiquement en HTTP/2.

## À vérifier sur le PC hôte

- autoriser les connexions sortantes UDP/TCP 7844 ;
- éviter un VPN/proxy qui force tout le trafic Cloudflare Tunnel à repasser par une autre région ;
- Ethernet plutôt que Wi-Fi pour le PC hôte si possible ;
- laisser `cloudflared.exe` et le serveur ouverts ;
- consulter `http://127.0.0.1:8080/health` pour les métriques serveur.

## Limites Quick Tunnel

Quick Tunnel est destiné au développement/test. Cloudflare indique actuellement :

- pas de garantie d'uptime ;
- URL différente à chaque création ;
- jusqu'à 200 requêtes simultanées en vol.

Pour une adresse stable et un usage public, migrer vers un Named Tunnel.
