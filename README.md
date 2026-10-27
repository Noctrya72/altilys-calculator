# Repère GPS — agent géographique autonome

Site statique HTML/CSS/JavaScript compatible avec GitHub Pages et Cloudflare Pages. L’agent sélectionne automatiquement le groupe de terminaux aval le mieux étayé à partir de données cartographiques ouvertes, puis expose les candidats, les critères et les limites de son choix.

## Publication

1. Décompresse le ZIP et envoie `index.html`, `styles.css`, `app.js`, `stations.json` et `README.md` à la racine du dépôt.
2. Sur GitHub Pages, choisis **Settings → Pages → Deploy from a branch**, branche `main`, dossier `/(root)`. Sur Cloudflare Pages, conserve ton déploiement statique existant.
3. Ouvre le site, saisis un format comme `lat: 45.889, lon: 6.735`, puis lance l’analyse autonome.

## Comment l’agent décide

1. Recherche d’abord les remontées mécaniques OpenStreetMap dans un rayon de 12 km, puis élargit à 22 km si la première recherche trouve trop peu de remontées.
2. Identifie les extrémités des lignes de remontées. Les balises explicites `aerialway:station=bottom` et `aerialway:station=top` sont prioritaires. En leur absence, l’altitude des extrémités sert à estimer le sens aval.
3. Quand une altitude manque, interroge Open-Meteo Elevation, basé sur Copernicus DEM GLO-90. Les altitudes de ce modèle sont approximatives (résolution spatiale d’environ 90 m).
4. Regroupe les terminaux à moins d’environ 750 m les uns des autres, fusionne les positions presque superposées (seuil de 45 m) pour limiter les doubles comptes et calcule le centre géographique de chaque groupe.
5. Classe les groupes avec un score heuristique lisible : soutien par les terminaux distincts (28 points maximum), proximité du point d’analyse (24), cohésion géographique (14), balises explicites bottom/top (19), qualité des données d’altitude (7) et comparaison relative des altitudes (8). Un groupe isolé est pénalisé en matière de soutien, et une sélection multi-terminaux est privilégiée lorsqu’elle existe. Ce score n’est **pas** une probabilité statistique.
6. Affiche le groupe retenu et les groupes alternatifs dans le rapport ; la carte distingue le point d’entrée, les terminaux retenus, le centre calculé et les centres candidats alternatifs.

## Gratuité et cache

- Aucune clé API et aucun modèle génératif payant ne sont nécessaires.
- Les données OpenStreetMap sont demandées aux instances publiques Overpass ; elles sont gratuites, mais soumises à des limites, et peuvent être indisponibles. Le moteur conserve temporairement certains résultats dans le stockage local du navigateur afin de limiter les requêtes répétées.
- Open-Meteo Elevation n’exige pas de clé pour un usage non commercial dans les limites de son offre gratuite. L’usage commercial ou un volume plus élevé peut nécessiter une offre payante. Consulte les conditions à jour avant de publier un service commercial.
- Le fond de carte standard utilise les tuiles OpenStreetMap, dont le serveur a une politique d’usage. Ne pas précharger ou aspirer massivement les tuiles.

## Limites importantes

- Cet « agent » est un moteur géographique autonome explicable, pas une IA générative. Cela évite d’envoyer les coordonnées à un modèle externe ou de laisser un modèle inventer des résultats.
- La complétude et la fraîcheur des données dépendent d’OpenStreetMap. Une remontée peut manquer, être mal tracée ou avoir des balises incomplètes.
- Le modèle GLO-90 ne permet pas toujours d’orienter avec fiabilité deux terminaux proches en altitude ; ces cas sont rejetés ou moins favorisés lorsqu’il manque une balise explicite.
- Le « front de neige » n’est pas une notion cartographique unique. Le point calculé représente un centre des terminaux aval trouvés, pas forcément le centre réel des bâtiments, caisses ou départs de pistes.
- Vérifie systématiquement les marqueurs et le point calculé sur une carte détaillée. Six décimales ne garantissent pas une précision métrique ou centimétrique.

## Sources et attribution

- Remontées et données cartographiques : © OpenStreetMap contributors, licence ODbL.
- Altitudes : Open-Meteo Elevation API et Copernicus DEM GLO-90 ; attribution Open-Meteo et Copernicus requise.
- Fond de carte : tuiles standard OpenStreetMap.

Documentation : [balises de station des remontées OSM](https://wiki.openstreetmap.org/wiki/Key:aerialway:station), [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), [Open-Meteo Elevation](https://open-meteo.com/en/docs/elevation-api), [conditions Open-Meteo](https://open-meteo.com/en/terms).
