# Repère GPS — recherche de ressources des stations

Projet statique (HTML, CSS, JavaScript et catalogue JSON) avec une fonction serveur Cloudflare Pages facultative pour rechercher, à partir du nom d'une station :

- le site officiel, en privilégiant une page d'accueil en version hiver ;
- une page webcams, avec une indication sur la couverture du domaine ;
- le plan des pistes le plus récent trouvé sous forme de lien PDF direct, en tenant compte de la saison affichée.

La recherche utilise les résultats publics DuckDuckGo sans clé API. L'agent est un moteur de recherche et de classement à règles déterministes, pas un modèle de langage génératif. Les liens et leur classement doivent être contrôlés avant publication.

## Fonction de recherche automatique

Le fichier `functions/api/station-resources.js` est une Cloudflare Pages Function exposée à `/api/station-resources`. Il effectue les requêtes côté serveur pour éviter les restrictions CORS des moteurs de recherche dans le navigateur.

### Déploiement recommandé : Cloudflare Pages connecté au dépôt Git

1. Téléverse tous les fichiers du projet à la racine du dépôt, en conservant le dossier `functions/`.
2. Dans Cloudflare, crée ou sélectionne le projet Pages et connecte ce dépôt Git.
3. Pour ce projet HTML statique, laisse le champ de commande de build vide si Cloudflare te le demande, et règle le répertoire de sortie sur `.` (la racine du dépôt).
4. Déploie le site. Cloudflare détectera le dossier `functions/` et exposera `/api/station-resources`.
5. Sur le site déployé, teste l'agent avec « Les 2 Alpes » ou le nom d'une autre station. En cas de résultats incomplets, utilise les recherches manuelles proposées dans l'interface.

Aucune clé API n'est requise. DuckDuckGo peut limiter ou bloquer les requêtes automatisées ; l'agent prévoit un message d'erreur et des recherches de secours dans ce cas. Le cache en mémoire de la fonction limite les recherches identiques dans une même instance, mais il n'est pas partagé entre toutes les instances Cloudflare.

## Hébergement GitHub Pages uniquement

GitHub Pages ne fait pas exécuter le code serveur placé dans `functions/`. L'outil GPS existant continue de fonctionner, mais l'agent de liens proposera alors trois recherches directes (site officiel hiver, webcams, plan des pistes PDF) au lieu de sélectionner automatiquement les résultats. Pour la recherche automatique, héberge cette version via Cloudflare Pages avec le dossier `functions/` conservé.

## Format généré

L'agent produit un extrait copiable de cette forme, avec douze espaces devant les deux dernières lignes :

```js
url: "https://www.exemple.fr/hiver",

            webcam: "https://www.exemple.fr/webcams", // Couverture du domaine à vérifier

            plan: "https://www.exemple.fr/plan-des-pistes.pdf", // Saison identifiée si disponible
```

Les espaces visibles dans les lignes `webcam` et `plan` font partie du résultat copié. Les annotations indiquent la portée estimée des webcams et la saison détectée. Elles restent indicatives.

## Limites à connaître

- Le site « officiel » est une estimation basée sur les titres, extraits et URLs retournés par le moteur de recherche ; il n'y a pas de registre universel des sites officiels.
- « Tout le domaine skiable » n'est indiqué comme confirmé que si le texte du résultat suggère clairement une couverture globale. Sinon, l'interface affiche « Couverture non confirmée » ou « Couverture partielle ».
- Le plan sélectionné doit être un lien direct vers un PDF. L'agent favorise les saisons les plus récentes repérées dans le titre, l'URL ou l'extrait ; si une date manque, la saison peut ne pas être confirmée.
- Les moteurs de recherche publics, les sites de stations et les PDF peuvent changer, devenir indisponibles ou bloquer les requêtes automatiques. Toujours ouvrir les liens retenus et vérifier leur validité.
- Le fond de carte utilise Leaflet et les tuiles standard OpenStreetMap, et nécessite une connexion Internet.

## Fichiers principaux

- `index.html` : interface
- `styles.css` : styles
- `app.js` : interface GPS et logique côté navigateur de l'agent de liens
- `stations.json` : catalogue des stations
- `functions/api/station-resources.js` : recherche serveur Cloudflare Pages sans clé API
