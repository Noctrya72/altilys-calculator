# Repère GPS — estimation du front de neige

Site statique HTML/CSS/JavaScript compatible avec GitHub Pages. L’interface et son style sont conservés ; le moteur calcule maintenant un centre estimé à partir des départs aval de remontées mécaniques.

## Publication sur GitHub Pages

1. Décompresse le ZIP et envoie les cinq fichiers (`index.html`, `styles.css`, `app.js`, `stations.json`, `README.md`) à la racine d’un dépôt GitHub.
2. Dans **Settings → Pages**, choisis **Deploy from a branch**, la branche `main` et le dossier `/(root)`.
3. Ouvre l’URL publiée, colle une ligne comme `lat: 45.889, lon: 6.735`, puis clique sur **Identifier la station**.

## Fonctionnement du calcul

1. L’outil cherche les remontées mécaniques OSM autour du point saisi. Il interroge d’abord un rayon de 12 km et élargit à 22 km lorsque peu de remontées sont trouvées.
2. Pour chaque remontée, il récupère les deux nœuds d’extrémité. L’altitude provient du tag `ele` dans OpenStreetMap lorsqu’il existe ; sinon, le moteur interroge l’API Elevation d’Open-Meteo, basée sur Copernicus DEM GLO-90.
3. Il estime l’extrémité aval d’après les altitudes, écarte les remontées dont la différence d’altitude ne permet pas de connaître le sens de manière suffisamment fiable, puis regroupe les départs aval proches géographiquement.
4. Il retient le groupe bas le plus pertinent et calcule la moyenne des latitudes et longitudes de ses départs aval. La carte, la copie et les coordonnées à six décimales affichent ce centre.
5. `stations.json` est facultatif pour le calcul : il sert seulement à proposer un nom de station et des suggestions. Une station absente du fichier est donc quand même recherchée directement dans OpenStreetMap.

## Limites importantes

- Les tags OSM et les géométries de remontées ne sont pas toujours complets ou à jour. Les départs aval sont estimés à partir des extrémités des lignes de remontées cartographiées.
- Quand un tag `ele` manque, l’API Open-Meteo utilise un modèle de terrain d’environ 90 m de résolution : il peut être incapable de distinguer deux extrémités proches en altitude. Le moteur préfère alors signaler le manque de données plutôt que produire une fausse précision.
- Un résultat à six décimales est un format numérique, pas une garantie de précision métrique ou centimétrique. Vérifie le point sur la carte avant de l’utiliser comme référence exacte.
- Le projet est entièrement côté navigateur, mais nécessite Internet pour les tuiles cartographiques, Overpass et les altitudes. Les instances publiques peuvent être temporairement indisponibles ou limitées.

## Données et attribution

- Remontées et données cartographiques : © OpenStreetMap contributors, distribuées sous la licence ODbL.
- Altitudes de terrain : Open-Meteo Elevation API / Copernicus DEM GLO-90.
- Fond de carte : tuiles standard OpenStreetMap.
