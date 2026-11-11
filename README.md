# TECNO BLACK FRIDAY – SPIN & WIN

Application web responsive : les participants ouvrent un lien public, saisissent leur nom et leur numéro WhatsApp, puis jouent. Aucun compte Facebook et aucune application Meta for Developers ne sont nécessaires.

## Fonctionnalités
- Inscription par nom + numéro WhatsApp (un seul profil par numéro).
- Trois essais maximum par participant et un seul gain maximum.
- Réductions de 5 %, 10 %, 15 %, 20 %, 25 % ou écouteurs Bluetooth TECNO.
- Partage manuel du jeu/résultat sur WhatsApp et Facebook, et copie du lien.
- Enregistrement des participants et des gains dans SQLite.
- Tableau de bord administrateur : `/admin`.
- Export CSV des participants et des lots.

## Prérequis
Node.js 20 ou supérieur.

## Installation Windows
1. Extraire le ZIP.
2. Ouvrir PowerShell dans le dossier qui contient `package.json` (le dossier `tecno-black-friday-spin-win`).
3. Exécuter :
   ```powershell
   npm.cmd install
   ```
4. Copier `.env.example` vers `.env`, puis définir au minimum un mot de passe administrateur et une longue clé de session :
   ```env
   PORT=3000
   SESSION_SECRET=remplacer-par-une-cle-longue-aleatoire
   ADMIN_PASSWORD=choisir-un-mot-de-passe-admin-solide
   NODE_ENV=development
   ```
5. Démarrer :
   ```powershell
   npm.cmd start
   ```
6. Ouvrir `http://localhost:3000`. Administration : `http://localhost:3000/admin`.

## Mise en ligne
Pour que les participants au Gabon puissent jouer, le projet doit être déployé sur un hébergement Node.js accessible publiquement, avec HTTPS et un disque persistant pour le dossier `data/` (qui contient `spinwin.sqlite`). Configurer les variables `SESSION_SECRET`, `ADMIN_PASSWORD`, `NODE_ENV=production` et `PORT` selon l'hébergeur. Ne pas publier le fichier `.env`.

Le lien public fourni par l'hébergeur est celui à partager sur Facebook et WhatsApp. Les boutons ouvrent les interfaces de partage : ils ne publient jamais automatiquement sur le profil Facebook.

## Aperçu Facebook
Les balises Open Graph (titre et description) sont présentes. Pour afficher une image de campagne dans l'aperçu, ajouter une image publique HTTPS `og:image` dans `public/index.html` et renseigner l'URL canonique publique dans `og:url` après le déploiement. L'image doit être accessible sans connexion.

## Limites importantes
- Sans connexion Facebook, il n'est pas possible de garantir qu'une personne ne participe qu'une seule fois avec plusieurs numéros ou appareils. Le contrôle est effectué sur le numéro WhatsApp déclaré.
- La session du navigateur est conservée 30 jours, mais une suppression des cookies ou un autre appareil peut ouvrir une nouvelle session ; le numéro WhatsApp permet de retrouver la participation existante.
- Les probabilités des lots sont celles définies dans `server.js` et doivent être validées par l'organisateur avant lancement.
- Les lots restants ne sont pas limités automatiquement par un stock configuré dans cette version.
- Compléter et faire valider `REGLEMENT-A-CONFIRMER.md` avant la campagne.

## Administration
Se connecter sur `/admin` avec `ADMIN_PASSWORD`. Le tableau de bord présente les participants, gagnants et lots enregistrés. L'export CSV peut être ouvert avec Excel.
