const DATA_URL = "./stations.json";
const MAX_MATCH_DISTANCE_KM = 45;
const CATALOG_LABEL_MAX_DISTANCE_KM = 12;
const INITIAL_RADIUS_M = 12000;
const EXPANDED_RADIUS_M = 22000;
const MAX_TERMINAL_DISTANCE_KM = 24;
const AERIALWAY_VALUES = "chair_lift|gondola|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet|cable_car|zip_line";
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const $ = (selector) => document.querySelector(selector);

let stations = [];
let currentCandidates = [];
let selectedStation = null;
let currentResult = null;
let lastInputPoint = null;
let analysisRunId = 0;
let map = null;
let mapMarker = null;
let tileErrorCount = 0;

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatCoord(n) { return Number(n).toFixed(6); }
function formatNumber(n, digits = 0) {
  return Number(n).toLocaleString("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function parseCoordinates(raw) {
  const text = raw.trim().replace(/−/g, "-");
  let match = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]+\s*(?:lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (match) return { lat: Number(match[1].replace(",", ".")), lon: Number(match[2].replace(",", ".")) };
  match = text.match(/(?:lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]+\s*lat(?:itude)?\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (match) return { lat: Number(match[2].replace(",", ".")), lon: Number(match[1].replace(",", ".")) };
  match = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (match) return { lat: Number(match[1]), lon: Number(match[2]) };
  match = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]+\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (match) return { lat: Number(match[1]), lon: Number(match[2]) };
  throw new Error("Format non reconnu. Utilise par exemple : lat: 45.889, lon: 6.735");
}

function validateCoordinates(point) {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
    throw new Error("Coordonnées invalides : latitude entre -90 et 90, longitude entre -180 et 180.");
  }
}

function setStatus(message, mode = "") {
  const status = $("#status");
  status.textContent = message;
  status.className = `status ${mode}`.trim();
}

function stationCandidates(point) {
  return stations
    .filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) && (Number(s.lat) !== 0 || Number(s.lon) !== 0))
    .map(s => ({ ...s, lat: Number(s.lat), lon: Number(s.lon), distanceKm: haversineKm(point.lat, point.lon, Number(s.lat), Number(s.lon)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .filter(s => s.distanceKm <= MAX_MATCH_DISTANCE_KM)
    .slice(0, 5);
}

function initMap() {
  map = L.map("map", { scrollWheelZoom: true }).setView([45.4, 6.2], 7);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
  }).addTo(map);
  map.on("tileerror", () => {
    tileErrorCount += 1;
    if (tileErrorCount >= 3) {
      $("#map-caption").textContent = "Le fond de carte ne répond pas. Les coordonnées restent disponibles et la carte peut être ouverte sur OpenStreetMap.";
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function updateMap(point, name = "Front de neige estimé") {
  const lat = Number(point.lat), lon = Number(point.lon);
  const title = `${name} — ${formatCoord(lat)}, ${formatCoord(lon)}`;
  if (mapMarker) map.removeLayer(mapMarker);
  mapMarker = L.marker([lat, lon]).addTo(map)
    .bindPopup(`<strong>${escapeHtml(name)}</strong><br>${formatCoord(lat)}, ${formatCoord(lon)}`)
    .openPopup();
  map.setView([lat, lon], 14);
  $("#map-caption").textContent = title;
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
  $("#open-map").href = osm;
  $("#osm-link").href = osm;
  setTimeout(() => map.invalidateSize(), 80);
}

function renderAlternatives() {
  const container = $("#alternatives");
  container.replaceChildren();
  currentCandidates.forEach(candidate => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate" + (selectedStation?.name === candidate.name ? " active" : "");
    const name = document.createElement("span");
    name.className = "candidate-name";
    name.textContent = candidate.name;
    const meta = document.createElement("span");
    meta.className = "candidate-meta";
    meta.textContent = `${candidate.massif} · ${formatNumber(candidate.distanceKm, 1)} km du point saisi · recalculer ici`;
    button.append(name, meta);
    button.addEventListener("click", () => selectStation(candidate));
    container.append(button);
  });
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function makeOverpassQuery(point, radiusM) {
  return `[out:json][timeout:25];\n(\n way(around:${radiusM},${point.lat},${point.lon})["aerialway"~"^(${AERIALWAY_VALUES})$"];\n node(around:${radiusM},${point.lat},${point.lon})["aerialway"="station"];\n);\nout body;\n>;\nout body qt;`;
}

async function requestOverpass(point, radiusM) {
  const query = makeOverpassQuery(point, radiusM);
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const payload = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query })
      }, 35000);
      if (!payload || !Array.isArray(payload.elements)) throw new Error("Réponse Overpass invalide");
      return payload.elements;
    } catch (error) {
      lastError = error;
      console.warn(`Overpass indisponible (${endpoint})`, error);
    }
  }
  throw new Error("OpenStreetMap ne répond pas pour le moment. Réessaie dans quelques instants.");
}

function isLiftWay(element) {
  return element?.type === "way" && element.tags?.aerialway && new RegExp(`^(?:${AERIALWAY_VALUES})$`).test(element.tags.aerialway) && Array.isArray(element.nodes) && element.nodes.length >= 2;
}

function parseElevation(value) {
  if (value === undefined || value === null || value === "") return null;
  let text = String(value).trim().replace(/\s*m(?:ètres?)?\s*$/i, "").replace(/\s/g, "");
  if (/^-?\d{1,2},\d{3}$/.test(text)) text = text.replace(",", "");
  else text = text.replace(",", ".");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > -500 && number < 10000 ? number : null;
}

function distanceMeters(a, b) {
  return haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
}

function collectLiftEndpoints(elements) {
  const nodesById = new Map(elements.filter(item => item.type === "node" && Number.isFinite(item.lat) && Number.isFinite(item.lon)).map(node => [node.id, node]));
  const stationNodes = [...nodesById.values()].filter(node => node.tags?.aerialway === "station");
  const ways = elements.filter(isLiftWay);
  const lifts = [];
  const endpointIds = new Set();

  for (const way of ways) {
    let first = nodesById.get(way.nodes[0]);
    let last = nodesById.get(way.nodes[way.nodes.length - 1]);
    if (!first || !last) continue;

    // Some OSM lifts place a tagged station node just beside the geometric endpoint.
    const snapToStation = node => {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const stationNode of stationNodes) {
        const d = distanceMeters(node, stationNode);
        if (d <= 80 && d < nearestDistance) { nearest = stationNode; nearestDistance = d; }
      }
      return nearest || node;
    };
    first = snapToStation(first);
    last = snapToStation(last);
    if (first.id === last.id) continue;
    endpointIds.add(first.id);
    endpointIds.add(last.id);
    lifts.push({ id: way.id, type: way.tags.aerialway, name: way.tags.name || "Remontée sans nom", firstId: first.id, lastId: last.id });
  }

  const endpoints = new Map();
  for (const id of endpointIds) {
    const node = nodesById.get(id);
    if (!node) continue;
    const ele = parseElevation(node.tags?.ele);
    endpoints.set(id, {
      id,
      lat: Number(node.lat),
      lon: Number(node.lon),
      elevation: ele,
      elevationSource: ele === null ? null : "OpenStreetMap (ele)",
      tags: node.tags || {}
    });
  }
  return { ways, lifts, endpoints };
}

async function fillMissingElevations(endpoints) {
  const missing = [...endpoints.values()].filter(node => node.elevation === null);
  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
  await Promise.all(chunks.map(async chunk => {
    const url = new URL(ELEVATION_URL);
    url.searchParams.set("latitude", chunk.map(node => node.lat.toFixed(6)).join(","));
    url.searchParams.set("longitude", chunk.map(node => node.lon.toFixed(6)).join(","));
    try {
      const data = await fetchJson(url.toString(), { headers: { "Accept": "application/json" } }, 15000);
      if (!Array.isArray(data.elevation)) throw new Error("Réponse d’altitude invalide");
      chunk.forEach((node, index) => {
        const elevation = Number(data.elevation[index]);
        if (Number.isFinite(elevation)) {
          node.elevation = elevation;
          node.elevationSource = "Open-Meteo / Copernicus GLO-90";
        }
      });
    } catch (error) {
      console.warn("Altitude Open-Meteo indisponible", error);
    }
  }));
}

function clusterTerminals(terminals, maxDistanceKm = 1.5) {
  const parent = terminals.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    const rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (let i = 0; i < terminals.length; i++) {
    for (let j = i + 1; j < terminals.length; j++) {
      if (haversineKm(terminals[i].lat, terminals[i].lon, terminals[j].lat, terminals[j].lon) <= maxDistanceKm) union(i, j);
    }
  }
  const groups = new Map();
  terminals.forEach((terminal, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(terminal);
  });
  return [...groups.values()];
}

function summarizeCluster(cluster, inputPoint) {
  const count = cluster.length;
  const lat = cluster.reduce((sum, point) => sum + point.lat, 0) / count;
  const lon = cluster.reduce((sum, point) => sum + point.lon, 0) / count;
  const meanElevation = cluster.reduce((sum, point) => sum + point.elevation, 0) / count;
  let totalPairDistance = 0, pairCount = 0, maxSpreadKm = 0;
  for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      const d = haversineKm(cluster[i].lat, cluster[i].lon, cluster[j].lat, cluster[j].lon);
      totalPairDistance += d;
      pairCount += 1;
      maxSpreadKm = Math.max(maxSpreadKm, d);
    }
  }
  const sources = new Set(cluster.map(point => point.elevationSource));
  return {
    lat, lon,
    meanElevation,
    count,
    averagePairDistanceM: pairCount ? (totalPairDistance / pairCount) * 1000 : 0,
    maxSpreadKm,
    distanceFromInputKm: haversineKm(inputPoint.lat, inputPoint.lon, lat, lon),
    elevationSources: [...sources],
    terminals: cluster
  };
}

async function computeFront(elements, inputPoint, radiusM) {
  const { ways, lifts, endpoints } = collectLiftEndpoints(elements);
  if (!lifts.length || endpoints.size < 2) throw new Error("Aucune remontée exploitable n’a été trouvée près de ce point.");
  await fillMissingElevations(endpoints);

  const terminals = [];
  let rejectedForElevation = 0;
  for (const lift of lifts) {
    const a = endpoints.get(lift.firstId), b = endpoints.get(lift.lastId);
    if (!a || !b || !Number.isFinite(a.elevation) || !Number.isFinite(b.elevation)) { rejectedForElevation++; continue; }
    const distanceA = haversineKm(inputPoint.lat, inputPoint.lon, a.lat, a.lon);
    const distanceB = haversineKm(inputPoint.lat, inputPoint.lon, b.lat, b.lon);
    const lower = a.elevation <= b.elevation ? a : b;
    const higher = lower.id === a.id ? b : a;
    if (haversineKm(inputPoint.lat, inputPoint.lon, lower.lat, lower.lon) > Math.min(MAX_TERMINAL_DISTANCE_KM, radiusM / 1000 + 2)) continue;

    const elevationDifference = Math.abs(a.elevation - b.elevation);
    const bothOsmElevations = a.elevationSource === "OpenStreetMap (ele)" && b.elevationSource === "OpenStreetMap (ele)";
    // DEM resolution is ~90 m: tiny differences from it are not enough to know which end is downhill.
    if (elevationDifference < (bothOsmElevations ? 3 : 18)) { rejectedForElevation++; continue; }

    terminals.push({
      lat: lower.lat,
      lon: lower.lon,
      elevation: lower.elevation,
      elevationSource: lower.elevationSource,
      liftId: lift.id,
      liftName: lift.name,
      liftType: lift.type,
      elevationDifference,
      otherEndElevation: higher.elevation,
      distanceFromInputKm: Math.min(distanceA, distanceB)
    });
  }

  if (!terminals.length) {
    const suffix = rejectedForElevation ? " Les altitudes disponibles ne permettent pas de déterminer de façon fiable l’extrémité aval." : "";
    throw new Error("Les remontées ont été trouvées, mais leurs altitudes sont insuffisantes pour calculer le front de neige." + suffix);
  }

  const clusters = clusterTerminals(terminals).map(cluster => summarizeCluster(cluster, inputPoint));
  // Ignore isolated low outliers when a cluster of two or more lower terminals is available.
  const multiTerminalClusters = clusters.filter(cluster => cluster.count >= 2);
  const usableClusters = multiTerminalClusters.length ? multiTerminalClusters : clusters;
  usableClusters.sort((a, b) => {
    const altitudeDifference = a.meanElevation - b.meanElevation;
    if (Math.abs(altitudeDifference) >= 30) return altitudeDifference;
    if (b.count !== a.count) return b.count - a.count;
    return a.distanceFromInputKm - b.distanceFromInputKm;
  });
  const best = usableClusters[0];
  if (best.distanceFromInputKm > MAX_TERMINAL_DISTANCE_KM) throw new Error("Les remontées trouvées sont trop éloignées du point saisi pour confirmer le domaine.");

  return {
    ...best,
    liftWaysFound: ways.length,
    lowerTerminalsFound: terminals.length,
    rejectedForElevation,
    radiusM,
    usedDem: best.elevationSources.some(source => source === "Open-Meteo / Copernicus GLO-90")
  };
}

async function analyzeAround(anchor) {
  let elements = await requestOverpass(anchor, INITIAL_RADIUS_M);
  let ways = elements.filter(isLiftWay);
  let radiusUsed = INITIAL_RADIUS_M;
  if (ways.length < 3) {
    const expandedElements = await requestOverpass(anchor, EXPANDED_RADIUS_M);
    const expandedWays = expandedElements.filter(isLiftWay);
    if (expandedWays.length > ways.length) {
      elements = expandedElements;
      ways = expandedWays;
      radiusUsed = EXPANDED_RADIUS_M;
    }
  }
  return computeFront(elements, anchor, radiusUsed);
}

function displayResult(result, labelStation, inputPoint, analysisAnchor) {
  currentResult = result;
  const stationName = labelStation?.name || "Front de neige estimé";
  const massif = labelStation?.massif || "Repérage direct OpenStreetMap";
  $("#result-section").hidden = false;
  $("#station-massif").textContent = massif;
  $("#station-name").textContent = stationName;

  const confidence = $("#confidence");
  if (result.count >= 4 && result.maxSpreadKm <= 1.5) {
    confidence.textContent = "Groupe cohérent";
    confidence.style.color = "var(--accent)";
    confidence.style.borderColor = "#2a5e59";
    confidence.style.background = "#12332f";
  } else if (result.count >= 2) {
    confidence.textContent = "Estimation plausible";
    confidence.style.color = "var(--blue)";
    confidence.style.borderColor = "#365a83";
    confidence.style.background = "#142a44";
  } else {
    confidence.textContent = "À vérifier";
    confidence.style.color = "var(--danger)";
    confidence.style.borderColor = "#7f4549";
    confidence.style.background = "#361e28";
  }

  $("#station-distance").textContent = `${result.count} départ${result.count > 1 ? "s aval regroupés" : " aval identifié"} · altitude moyenne ${formatNumber(result.meanElevation)} m`;
  $("#output-lat").textContent = formatCoord(result.lat);
  $("#output-lon").textContent = formatCoord(result.lon);
  $("#precision-note").textContent = result.count >= 2
    ? `Centre calculé à partir de ${result.count} départs aval de remontées.`
    : "Un seul départ aval exploitable : contrôle manuel recommandé.";

  const averageDistance = formatNumber(result.averagePairDistanceM, 0);
  const spread = formatNumber(result.maxSpreadKm * 1000, 0);
  const sourceLabel = result.usedDem ? "altitudes OSM complétées par le modèle de terrain Copernicus GLO-90 (résolution 90 m)" : "altitudes taguées dans OpenStreetMap";
  const fallbackNote = analysisAnchor && haversineKm(inputPoint.lat, inputPoint.lon, analysisAnchor.lat, analysisAnchor.lon) > 0.2
    ? ` Analyse centrée sur un point de référence voisin (${formatNumber(haversineKm(inputPoint.lat, inputPoint.lon, analysisAnchor.lat, analysisAnchor.lon), 1)} km du point saisi).`
    : "";
  $("#source-note").textContent = `Source : remontées OpenStreetMap ; ${sourceLabel}. Altitude moyenne des extrémités retenues : ${formatNumber(result.meanElevation)} m. Distance moyenne entre départs aval : ${averageDistance} m ; dispersion maximale : ${spread} m.${fallbackNote} Les six décimales sont un format d’affichage, pas une garantie de précision centimétrique.`;
  updateMap(result, stationName);
  renderAlternatives();
}

async function runAnalysis(primaryPoint, labelStation, fallbackStation = null) {
  const thisRun = ++analysisRunId;
  currentResult = null;
  const analysisAnchor = { lat: primaryPoint.lat, lon: primaryPoint.lon };
  $("#result-section").hidden = true;
  selectedStation = labelStation || null;
  renderAlternatives();
  setStatus("Recherche des remontées mécaniques et estimation des altitudes aval…");
  updateMap({ lat: primaryPoint.lat, lon: primaryPoint.lon }, "Point saisi");

  let result = null;
  let successfulAnchor = analysisAnchor;
  let firstError = null;
  try {
    result = await analyzeAround(analysisAnchor);
  } catch (error) {
    firstError = error;
    console.warn("Analyse autour des coordonnées saisies impossible", error);
  }

  if (!result && fallbackStation && haversineKm(analysisAnchor.lat, analysisAnchor.lon, fallbackStation.lat, fallbackStation.lon) <= 20) {
    const fallbackAnchor = { lat: fallbackStation.lat, lon: fallbackStation.lon };
    if (haversineKm(analysisAnchor.lat, analysisAnchor.lon, fallbackAnchor.lat, fallbackAnchor.lon) > 0.2) {
      try {
        setStatus("Peu de remontées trouvées au point exact ; nouvelle recherche autour de la station la plus proche…");
        result = await analyzeAround(fallbackAnchor);
        successfulAnchor = fallbackAnchor;
      } catch (error) {
        console.warn("Analyse autour de la station de référence impossible", error);
      }
    }
  }

  if (thisRun !== analysisRunId) return;
  if (!result) {
    $("#result-section").hidden = true;
    updateMap({ lat: primaryPoint.lat, lon: primaryPoint.lon }, "Point saisi — résultat non confirmé");
    setStatus(firstError?.message || "Impossible d’estimer le front de neige avec les données disponibles. Vérifie les coordonnées et réessaie.", "error");
    return;
  }

  displayResult(result, labelStation, primaryPoint, successfulAnchor);
  const confidenceText = result.count >= 3 ? "résultat basé sur plusieurs remontées" : "résultat à vérifier, peu de remontées exploitables";
  setStatus(`Front de neige estimé : ${labelStation?.name || "domaine détecté directement"}. ${confidenceText}.`, result.count >= 2 ? "success" : "error");
}

async function handleSearch(event) {
  event.preventDefault();
  const button = $("#search-button");
  button.disabled = true;
  try {
    const point = parseCoordinates($("#coordinate-input").value);
    validateCoordinates(point);
    lastInputPoint = point;
    currentCandidates = stationCandidates(point);
    renderAlternatives();
    const nearest = currentCandidates[0] || null;
    const labelStation = nearest && nearest.distanceKm <= CATALOG_LABEL_MAX_DISTANCE_KM ? nearest : null;
    setStatus(currentCandidates.length
      ? `Point reçu. ${currentCandidates.length} station(s) du catalogue proche(s) ; la position sera calculée avec les remontées.`
      : "Point reçu. Recherche directe des remontées autour des coordonnées, sans dépendre du catalogue…");
    await runAnalysis(point, labelStation, labelStation || (nearest && nearest.distanceKm <= 20 ? nearest : null));
  } catch (error) {
    setStatus(error.message || "Une erreur est survenue.", "error");
  } finally {
    button.disabled = false;
  }
}

async function selectStation(station) {
  if (!lastInputPoint) lastInputPoint = { lat: station.lat, lon: station.lon };
  const button = $("#search-button");
  button.disabled = true;
  try {
    selectedStation = station;
    renderAlternatives();
    await runAnalysis({ lat: station.lat, lon: station.lon }, station, null);
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  initMap();
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error("stations.json inaccessible");
    const data = await response.json();
    stations = Array.isArray(data) ? data : [];
  } catch (error) {
    // stations.json is optional: direct OpenStreetMap search still works without it.
    console.warn("Catalogue de stations inaccessible ; fonctionnement direct OSM activé.", error);
    stations = [];
  }

  $("#coordinate-form").addEventListener("submit", handleSearch);
  $("#use-example").addEventListener("click", () => {
    $("#coordinate-input").value = "lat: 45.889, lon: 6.735";
    $("#coordinate-form").requestSubmit();
  });
  $("#copy-coordinates").addEventListener("click", async () => {
    if (!currentResult) return;
    const text = `lat: ${formatCoord(currentResult.lat)}, lon: ${formatCoord(currentResult.lon)}`;
    try {
      await navigator.clipboard.writeText(text);
      $("#copy-coordinates").textContent = "Copié ✓";
      setTimeout(() => $("#copy-coordinates").textContent = "Copier", 1600);
    } catch {
      window.prompt("Copie ces coordonnées :", text);
    }
  });
}

document.addEventListener("DOMContentLoaded", boot, { once: true });


// Convertisseur indépendant ajouté sans modifier le moteur de recherche des stations.
function parseHemisphereCoordinates(raw) {
  const matches = [...String(raw).matchAll(/([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([NSEW])/gi)];
  if (matches.length !== 2) {
    throw new Error('Format non reconnu. Exemple attendu : 45.892693°N 6.782763°E');
  }

  let lat = null;
  let lon = null;
  for (const match of matches) {
    const value = Math.abs(Number(match[1].replace(',', '.')));
    const hemisphere = match[2].toUpperCase();
    if (!Number.isFinite(value)) throw new Error('Une des coordonnées n’est pas un nombre valide.');
    if (hemisphere === 'N' || hemisphere === 'S') {
      if (lat !== null) throw new Error('Indique une seule latitude (N ou S) et une seule longitude (E ou W).');
      lat = hemisphere === 'S' ? -value : value;
    } else {
      if (lon !== null) throw new Error('Indique une seule latitude (N ou S) et une seule longitude (E ou W).');
      lon = hemisphere === 'W' ? -value : value;
    }
  }

  if (lat === null || lon === null) throw new Error('Il faut une latitude N/S et une longitude E/W.');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Coordonnées hors limites : latitude entre 0 et 90°, longitude entre 0 et 180°.');
  }
  return { lat, lon };
}

function bootFormatConverter() {
  const form = document.querySelector('#format-converter-form');
  if (!form) return;
  const input = document.querySelector('#hemisphere-input');
  const status = document.querySelector('#format-status');
  const result = document.querySelector('#format-result');
  const output = document.querySelector('#formatted-coordinates');
  const convertButton = document.querySelector('#format-convert-button');
  const exampleButton = document.querySelector('#format-use-example');
  const copyButton = document.querySelector('#format-copy-button');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const point = parseHemisphereCoordinates(input.value);
      const indentation = ' '.repeat(13);
      output.textContent = `lat: ${point.lat.toFixed(6)},\n${indentation}lon: ${point.lon.toFixed(6)},`;
      result.hidden = false;
      status.textContent = 'Coordonnées converties. Le format avec indentation est prêt à copier.';
      status.className = 'status success';
    } catch (error) {
      result.hidden = true;
      status.textContent = error.message || 'Impossible de convertir ces coordonnées.';
      status.className = 'status error';
    }
  });

  exampleButton.addEventListener('click', () => {
    input.value = '45.892693°N 6.782763°E';
    form.requestSubmit();
  });

  copyButton.addEventListener('click', async () => {
    const text = output.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copié ✓';
      window.setTimeout(() => { copyButton.textContent = 'Copier'; }, 1600);
    } catch {
      window.prompt('Copie ce texte :', text);
    }
  });

  form.requestSubmit();
}

document.addEventListener('DOMContentLoaded', bootFormatConverter, { once: true });
