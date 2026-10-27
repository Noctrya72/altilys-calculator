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
let analysisLayer = null;
let elevationMemoryCache = new Map();
let lastAgentReport = null;
const OVERPASS_CACHE_PREFIX = "repere-gps-overpass-v2:";
const OVERPASS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OVERPASS_CACHE_MAX_CHARS = 900000;

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
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(map);
  analysisLayer = L.layerGroup().addTo(map);
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
  if (analysisLayer) analysisLayer.clearLayers();
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

function overpassCacheKey(point, radiusM) {
  return `${OVERPASS_CACHE_PREFIX}${radiusM}:${Number(point.lat).toFixed(4)}:${Number(point.lon).toFixed(4)}`;
}

function readOverpassCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || Date.now() - cached.savedAt > OVERPASS_CACHE_TTL_MS || !Array.isArray(cached.elements)) {
      localStorage.removeItem(key);
      return null;
    }
    return cached.elements;
  } catch {
    return null;
  }
}

function writeOverpassCache(key, elements) {
  try {
    const serialized = JSON.stringify({ savedAt: Date.now(), elements });
    // Large mountain areas may exceed browser storage quotas; in that case the app still works without persistence.
    if (serialized.length > OVERPASS_CACHE_MAX_CHARS) return;
    const oldKeys = [];
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index);
      if (candidate?.startsWith(OVERPASS_CACHE_PREFIX)) oldKeys.push(candidate);
    }
    // Keep the cache bounded and prefer recently saved entries.
    if (oldKeys.length >= 4) {
      oldKeys.slice(0, oldKeys.length - 3).forEach(oldKey => localStorage.removeItem(oldKey));
    }
    localStorage.setItem(key, serialized);
  } catch {
    // Private browsing, disabled storage, or a full quota must not prevent a search.
  }
}

async function requestOverpass(point, radiusM) {
  const key = overpassCacheKey(point, radiusM);
  const cached = readOverpassCache(key);
  if (cached) {
    lastAgentReport?.events?.push(`Données cartographiques réutilisées depuis le cache (${Math.round(OVERPASS_CACHE_TTL_MS / 3600000)} h maximum).`);
    return cached;
  }

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
      writeOverpassCache(key, payload.elements);
      return payload.elements;
    } catch (error) {
      lastError = error;
      console.warn(`Overpass indisponible (${endpoint})`, error);
    }
  }
  if (lastError?.name === "AbortError") {
    throw new Error("La recherche cartographique a dépassé le délai autorisé. Réessaie dans quelques instants.");
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

function getStationRole(node) {
  const value = String(node?.tags?.["aerialway:station"] || "").trim().toLowerCase();
  if (value === "bottom" || value === "lower") return "bottom";
  if (value === "top" || value === "upper") return "top";
  if (value === "mid" || value === "middle") return "mid";
  return "unknown";
}

function collectLiftEndpoints(elements) {
  const nodesById = new Map(elements.filter(item => item.type === "node" && Number.isFinite(item.lat) && Number.isFinite(item.lon)).map(node => [node.id, node]));
  const stationNodes = [...nodesById.values()].filter(node => {
    const role = String(node.tags?.["aerialway:station"] || "").toLowerCase();
    return node.tags?.aerialway === "station" || ["bottom", "top", "lower", "upper", "mid", "middle"].includes(role);
  });
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
      tags: node.tags || {},
      stationRole: getStationRole(node)
    });
  }
  return { ways, lifts, endpoints };
}

async function fillMissingElevations(endpoints) {
  const missing = [...endpoints.values()].filter(node => node.elevation === null);
  const uncached = [];
  for (const node of missing) {
    const key = `${node.lat.toFixed(5)},${node.lon.toFixed(5)}`;
    const cached = elevationMemoryCache.get(key);
    if (cached && Date.now() - cached.savedAt < 30 * 24 * 60 * 60 * 1000) {
      node.elevation = cached.elevation;
      node.elevationSource = "Open-Meteo / Copernicus GLO-90 (cache)";
    } else {
      uncached.push(node);
    }
  }

  const chunks = [];
  for (let i = 0; i < uncached.length; i += 100) chunks.push(uncached.slice(i, i + 100));
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
          elevationMemoryCache.set(`${node.lat.toFixed(5)},${node.lon.toFixed(5)}`, { elevation, savedAt: Date.now() });
        }
      });
    } catch (error) {
      console.warn("Altitude Open-Meteo indisponible", error);
    }
  }));
}

function clusterTerminals(terminals, maxDistanceKm = 0.75) {
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

function deduplicateTerminalPositions(cluster, thresholdM = 45) {
  const positions = [];
  for (const terminal of cluster) {
    let match = null;
    let bestDistance = Infinity;
    for (const position of positions) {
      const distance = distanceMeters(terminal, position);
      if (distance <= thresholdM && distance < bestDistance) {
        match = position;
        bestDistance = distance;
      }
    }
    if (!match) {
      positions.push({
        lat: terminal.lat,
        lon: terminal.lon,
        elevation: terminal.elevation,
        elevationSource: terminal.elevationSource,
        nodeId: terminal.lowerNodeId,
        explicitBottom: terminal.directionMethod === "balise bottom",
        explicitDirection: terminal.explicitDirection,
        directionMethods: [terminal.directionMethod],
        liftIds: [terminal.liftId],
        liftNames: [terminal.liftName],
        rawTerminals: [terminal]
      });
    } else {
      match.rawTerminals.push(terminal);
      match.liftIds.push(terminal.liftId);
      match.liftNames.push(terminal.liftName);
      match.explicitBottom ||= terminal.directionMethod === "balise bottom";
      match.explicitDirection ||= terminal.explicitDirection;
      match.directionMethods.push(terminal.directionMethod);
      if (terminal.elevation !== null && Number.isFinite(terminal.elevation)) {
        const values = match.rawTerminals.map(item => item.elevation).filter(Number.isFinite);
        match.elevation = values.reduce((sum, value) => sum + value, 0) / values.length;
      }
    }
  }
  return positions;
}

function summarizeCluster(cluster, inputPoint) {
  const positions = deduplicateTerminalPositions(cluster);
  const count = positions.length;
  const lat = positions.reduce((sum, point) => sum + point.lat, 0) / count;
  const lon = positions.reduce((sum, point) => sum + point.lon, 0) / count;
  const validElevations = positions.filter(point => Number.isFinite(point.elevation));
  const meanElevation = validElevations.length
    ? validElevations.reduce((sum, point) => sum + point.elevation, 0) / validElevations.length
    : null;
  let totalPairDistance = 0, pairCount = 0, maxSpreadKm = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const d = haversineKm(positions[i].lat, positions[i].lon, positions[j].lat, positions[j].lon);
      totalPairDistance += d;
      pairCount += 1;
      maxSpreadKm = Math.max(maxSpreadKm, d);
    }
  }
  const uniqueLiftIds = new Set(cluster.map(point => point.liftId));
  const explicitBottomCount = positions.filter(point => point.explicitBottom).length;
  const explicitDirectionCount = positions.filter(point => point.explicitDirection).length;
  const osmElevationCount = positions.filter(point => point.rawTerminals.some(t => t.elevationSource === "OpenStreetMap (ele)")).length;
  const demElevationCount = positions.filter(point => point.rawTerminals.some(t => String(t.elevationSource || "").includes("Copernicus GLO-90"))).length;
  const sources = new Set(cluster.map(point => point.elevationSource).filter(Boolean));
  return {
    lat,
    lon,
    meanElevation,
    count,
    liftCount: uniqueLiftIds.size,
    explicitBottomCount,
    explicitDirectionCount,
    osmElevationCount,
    demElevationCount,
    averagePairDistanceM: pairCount ? (totalPairDistance / pairCount) * 1000 : 0,
    maxSpreadKm,
    distanceFromInputKm: haversineKm(inputPoint.lat, inputPoint.lon, lat, lon),
    elevationSources: [...sources],
    terminals: cluster,
    positions
  };
}

function scoreCluster(candidate, allCandidates) {
  // Score explicable, pas une probabilité statistique. Le point saisi est supposé proche de la zone recherchée.
  const support = Math.min(Math.max(0, (candidate.count - 1) / 3), 1) * 28;
  const proximity = Math.max(0, 1 - candidate.distanceFromInputKm / 24) * 24;
  const cohesion = Math.max(0, 1 - candidate.maxSpreadKm / 3) * 14;
  const bottomRatio = candidate.count ? candidate.explicitBottomCount / candidate.count : 0;
  const directionRatio = candidate.count ? candidate.explicitDirectionCount / candidate.count : 0;
  const directionEvidence = Math.min(1, bottomRatio + Math.max(0, directionRatio - bottomRatio) * 0.65);
  const tagEvidence = directionEvidence * 19;
  const sourceRatio = candidate.count ? (candidate.osmElevationCount + candidate.demElevationCount * 0.5) / candidate.count : 0;
  const elevationEvidence = Math.min(1, sourceRatio) * 7;
  const altitudes = allCandidates.map(item => item.meanElevation).filter(Number.isFinite);
  let altitudeEvidence = 0;
  if (Number.isFinite(candidate.meanElevation) && altitudes.length) {
    const minimum = Math.min(...altitudes);
    const maximum = Math.max(...altitudes);
    // L'altitude sert de critère secondaire : le groupe le plus bas n'est pas forcément le secteur recherché.
    altitudeEvidence = maximum - minimum >= 10
      ? ((maximum - candidate.meanElevation) / (maximum - minimum)) * 8
      : 4;
  }
  const score = Math.round(Math.min(100, support + proximity + cohesion + tagEvidence + elevationEvidence + altitudeEvidence));
  return {
    ...candidate,
    score,
    scoreBreakdown: {
      support: Math.round(support),
      proximity: Math.round(proximity),
      cohesion: Math.round(cohesion),
      explicitTags: Math.round(tagEvidence),
      elevationData: Math.round(elevationEvidence),
      altitudeComparison: Math.round(altitudeEvidence)
    }
  };
}

function explainCandidate(candidate, allCandidates) {
  const bestCount = Math.max(...allCandidates.map(item => item.count));
  const statements = [];
  if (candidate.explicitBottomCount > 0) {
    statements.push(`${candidate.explicitBottomCount} terminal(s) porte(nt) la balise OSM explicite « bottom »`);
  } else if (candidate.explicitDirectionCount > 0) {
    statements.push(`${candidate.explicitDirectionCount} direction(s) déduite(s) d'une balise OSM « top » opposée`);
  } else {
    statements.push("le sens aval est déduit des altitudes, sans balise bottom explicite");
  }
  statements.push(`${candidate.count} position(s) de terminal distincte(s) soutenue(s) par ${candidate.liftCount} remontée(s)`);
  statements.push(`centre à ${formatNumber(candidate.distanceFromInputKm, 1)} km du point d’analyse`);
  if (candidate.maxSpreadKm > 1.5) statements.push(`dispersion étendue (${formatNumber(candidate.maxSpreadKm, 2)} km), à surveiller`);
  if (candidate.count < bestCount) statements.push("moins de terminaux que le groupe le plus fourni");
  return statements.join(" ; ") + ".";
}

async function computeFront(elements, inputPoint, radiusM) {
  const { ways, lifts, endpoints } = collectLiftEndpoints(elements);
  if (!lifts.length || endpoints.size < 2) throw new Error("Aucune remontée exploitable n’a été trouvée près de ce point.");
  await fillMissingElevations(endpoints);

  const terminals = [];
  let rejectedForElevation = 0;
  let explicitBottomFound = 0;
  let elevationInferredFound = 0;
  for (const lift of lifts) {
    const a = endpoints.get(lift.firstId), b = endpoints.get(lift.lastId);
    if (!a || !b) continue;

    const distanceA = haversineKm(inputPoint.lat, inputPoint.lon, a.lat, a.lon);
    const distanceB = haversineKm(inputPoint.lat, inputPoint.lon, b.lat, b.lon);
    if (Math.min(distanceA, distanceB) > Math.min(MAX_TERMINAL_DISTANCE_KM, radiusM / 1000 + 2)) continue;

    const roleA = a.stationRole || getStationRole(a);
    const roleB = b.stationRole || getStationRole(b);
    let lower = null;
    let higher = null;
    let directionMethod = "altitude";
    let explicitDirection = false;

    // Priorité aux balises déclarées dans OpenStreetMap : elles sont plus utiles que le DEM grossier.
    if (roleA === "bottom" && roleB !== "bottom") {
      lower = a; higher = b; directionMethod = "balise bottom"; explicitDirection = true;
    } else if (roleB === "bottom" && roleA !== "bottom") {
      lower = b; higher = a; directionMethod = "balise bottom"; explicitDirection = true;
    } else if (roleA === "top" && roleB !== "top" && roleB !== "mid") {
      lower = b; higher = a; directionMethod = "opposé balise top"; explicitDirection = true;
    } else if (roleB === "top" && roleA !== "top" && roleA !== "mid") {
      lower = a; higher = b; directionMethod = "opposé balise top"; explicitDirection = true;
    } else {
      if (!Number.isFinite(a.elevation) || !Number.isFinite(b.elevation)) { rejectedForElevation++; continue; }
      lower = a.elevation <= b.elevation ? a : b;
      higher = lower.id === a.id ? b : a;
      const elevationDifference = Math.abs(a.elevation - b.elevation);
      const bothOsmElevations = a.elevationSource === "OpenStreetMap (ele)" && b.elevationSource === "OpenStreetMap (ele)";
      // GLO-90 has ~90 m resolution; small differences are not considered a reliable direction signal.
      if (elevationDifference < (bothOsmElevations ? 3 : 18)) { rejectedForElevation++; continue; }
      elevationInferredFound++;
    }

    if (!Number.isFinite(lower.elevation) && !explicitDirection) { rejectedForElevation++; continue; }
    if (directionMethod === "balise bottom") explicitBottomFound++;
    const elevationDifference = Number.isFinite(lower.elevation) && Number.isFinite(higher.elevation)
      ? Math.abs(lower.elevation - higher.elevation)
      : null;
    terminals.push({
      lat: lower.lat,
      lon: lower.lon,
      elevation: Number.isFinite(lower.elevation) ? lower.elevation : null,
      elevationSource: lower.elevationSource,
      lowerNodeId: lower.id,
      liftId: lift.id,
      liftName: lift.name,
      liftType: lift.type,
      elevationDifference,
      otherEndElevation: Number.isFinite(higher.elevation) ? higher.elevation : null,
      distanceFromInputKm: Math.min(distanceA, distanceB),
      directionMethod,
      explicitDirection,
      stationRole: lower.stationRole || "unknown"
    });
  }

  if (!terminals.length) {
    const suffix = rejectedForElevation ? " Les altitudes et les balises disponibles ne permettent pas de déterminer assez sûrement les extrémités aval." : "";
    throw new Error("Les remontées ont été trouvées, mais les données sont insuffisantes pour calculer le front de neige." + suffix);
  }

  const rawClusters = clusterTerminals(terminals).map(cluster => summarizeCluster(cluster, inputPoint));
  const allScored = rawClusters.map(candidate => scoreCluster(candidate, rawClusters)).sort((a, b) => b.score - a.score || a.distanceFromInputKm - b.distanceFromInputKm || b.count - a.count || (a.meanElevation ?? Infinity) - (b.meanElevation ?? Infinity));
  // A solitary terminal must not beat a coherent multi-terminal group merely because it carries one explicit tag.
  const corroborated = allScored.filter(candidate => candidate.count >= 2);
  const scored = corroborated.length ? [...corroborated, ...allScored.filter(candidate => candidate.count < 2)] : allScored;
  const best = scored[0];
  if (!best || best.distanceFromInputKm > MAX_TERMINAL_DISTANCE_KM) {
    throw new Error("Les remontées trouvées sont trop éloignées du point saisi pour confirmer le domaine.");
  }

  const confidence = best.score >= 78 && best.count >= 3
    ? "Forte convergence d'indices"
    : best.score >= 58 && best.count >= 2
      ? "Estimation plausible"
      : "À vérifier sur la carte";
  const selectionReason = explainCandidate(best, scored);
  const agentEvents = [
    `${ways.length} géométrie(s) de remontée(s) trouvée(s) dans le rayon de ${Math.round(radiusM / 1000)} km.`,
    `${terminals.length} extrémité(s) aval candidate(s) retenue(s), dont ${explicitBottomFound} grâce à la balise bottom et ${elevationInferredFound} orientée(s) par les altitudes.`,
    `${scored.length} groupe(s) géographique(s) comparé(s).`,
    `Le groupe sélectionné obtient ${best.score}/100 selon un score heuristique explicable, pas une probabilité statistique.`,
    `Répartition : soutien ${best.scoreBreakdown.support}/28 ; proximité ${best.scoreBreakdown.proximity}/24 ; cohésion ${best.scoreBreakdown.cohesion}/14 ; balises explicites ${best.scoreBreakdown.explicitTags}/19 ; qualité des altitudes ${best.scoreBreakdown.elevationData}/7 ; comparaison des altitudes ${best.scoreBreakdown.altitudeComparison}/8.`,
    selectionReason
  ];

  return {
    ...best,
    score: best.score,
    confidence,
    selectionReason,
    clusterCandidates: scored.slice(0, 6),
    liftWaysFound: ways.length,
    lowerTerminalsFound: terminals.length,
    rejectedForElevation,
    explicitBottomFound,
    elevationInferredFound,
    radiusM,
    usedDem: best.elevationSources.some(source => String(source).includes("Copernicus GLO-90")),
    agentEvents: [...(lastAgentReport?.events || []), ...agentEvents],
    uniquePositions: best.positions
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

function drawAnalysisEvidence(result, inputPoint) {
  if (!map || !analysisLayer) return;
  const selected = result.clusterCandidates?.[0] || result;
  const candidates = result.clusterCandidates || [result];
  const inputIsSeparate = inputPoint && haversineKm(inputPoint.lat, inputPoint.lon, result.lat, result.lon) > 0.03;
  if (inputIsSeparate) {
    L.circleMarker([inputPoint.lat, inputPoint.lon], {
      radius: 7, color: "#8eb8ff", weight: 2, fillColor: "#152d50", fillOpacity: 0.95
    }).addTo(analysisLayer).bindPopup(`<strong>Point initial saisi</strong><br>${formatCoord(inputPoint.lat)}, ${formatCoord(inputPoint.lon)}`);
  }

  // Selected terminal positions are shown separately from the computed centre.
  (selected.positions || []).forEach(position => {
    const method = position.explicitBottom ? "Balise bottom explicite" : position.explicitDirection ? "Direction appuyée par une balise top" : "Direction déduite de l'altitude";
    const names = [...new Set(position.liftNames || [])].slice(0, 4).join(", ") || "Remontée sans nom";
    L.circleMarker([position.lat, position.lon], {
      radius: 6, color: "#76e2d0", weight: 2, fillColor: "#123b38", fillOpacity: 0.95
    }).addTo(analysisLayer).bindPopup(`<strong>Terminal aval candidat</strong><br>${escapeHtml(method)}<br>${escapeHtml(names)}<br>${formatCoord(position.lat)}, ${formatCoord(position.lon)}${Number.isFinite(position.elevation) ? `<br>Altitude : ${formatNumber(position.elevation)} m` : "<br>Altitude indisponible"}`);
  });

  candidates.slice(1, 6).forEach((candidate, index) => {
    L.circleMarker([candidate.lat, candidate.lon], {
      radius: 7, color: "#f3bd66", weight: 2, fillColor: "#47351c", fillOpacity: 0.85
    }).addTo(analysisLayer).bindPopup(`<strong>Autre groupe candidat n°${index + 2}</strong><br>Score : ${candidate.score}/100<br>${candidate.count} terminal(aux), ${formatNumber(candidate.distanceFromInputKm, 1)} km du point d’analyse<br>${formatCoord(candidate.lat)}, ${formatCoord(candidate.lon)}`);
  });
  const bounds = [[result.lat, result.lon], ...(selected.positions || []).map(point => [point.lat, point.lon])];
  if (inputIsSeparate) bounds.push([inputPoint.lat, inputPoint.lon]);
  if (bounds.length > 1) {
    try { map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 }); } catch { /* The selected center remains visible. */ }
  }
}

function renderAgentReport(result) {
  const section = $("#agent-report");
  if (!section) return;
  section.hidden = false;
  $("#agent-score").textContent = `${result.score}/100`;
  $("#agent-confidence").textContent = result.confidence || "À vérifier sur la carte";
  $("#agent-summary").textContent = result.selectionReason || "Le groupe a été choisi à partir des données disponibles.";

  const events = $("#agent-events");
  events.replaceChildren();
  (result.agentEvents || []).forEach(eventText => {
    const item = document.createElement("li");
    item.textContent = eventText;
    events.append(item);
  });

  const candidates = $("#agent-candidates");
  candidates.replaceChildren();
  (result.clusterCandidates || []).slice(0, 5).forEach((candidate, index) => {
    const item = document.createElement("article");
    item.className = "agent-candidate" + (index === 0 ? " selected" : "");
    const heading = document.createElement("div");
    heading.className = "agent-candidate-heading";
    const title = document.createElement("strong");
    title.textContent = index === 0 ? "Groupe sélectionné" : `Alternative ${index + 1}`;
    const score = document.createElement("span");
    score.textContent = `${candidate.score}/100`;
    heading.append(title, score);
    const details = document.createElement("p");
    details.textContent = `${candidate.count} terminal(aux) distinct(s) · ${candidate.liftCount} remontée(s) · ${formatNumber(candidate.distanceFromInputKm, 1)} km du point d’analyse${Number.isFinite(candidate.meanElevation) ? ` · altitude moyenne ${formatNumber(candidate.meanElevation)} m` : " · altitude inconnue"}`;
    const coordinates = document.createElement("code");
    coordinates.textContent = `${formatCoord(candidate.lat)}, ${formatCoord(candidate.lon)}`;
    item.append(heading, details, coordinates);
    candidates.append(item);
  });
}

function displayResult(result, labelStation, inputPoint, analysisAnchor) {
  currentResult = result;
  const stationName = labelStation?.name || "Front de neige estimé";
  const massif = labelStation?.massif || "Repérage direct OpenStreetMap";
  $("#result-section").hidden = false;
  $("#station-massif").textContent = massif;
  $("#station-name").textContent = stationName;

  const confidence = $("#confidence");
  if (result.score >= 78 && result.count >= 3 && result.maxSpreadKm <= 2.5) {
    confidence.textContent = "Indices convergents";
    confidence.style.color = "var(--accent)";
    confidence.style.borderColor = "#2a5e59";
    confidence.style.background = "#12332f";
  } else if (result.score >= 58 && result.count >= 2) {
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

  $("#station-distance").textContent = `${result.count} position${result.count > 1 ? "s de terminal aval distinctes" : " de terminal aval distincte"} · ${result.liftCount} remontée(s) associée(s)${Number.isFinite(result.meanElevation) ? ` · altitude moyenne ${formatNumber(result.meanElevation)} m` : " · altitude moyenne indisponible"}`;
  $("#output-lat").textContent = formatCoord(result.lat);
  $("#output-lon").textContent = formatCoord(result.lon);
  $("#precision-note").textContent = result.count >= 2
    ? `Centre calculé à partir de ${result.count} positions distinctes, choisies automatiquement.`
    : "Un seul terminal aval exploitable : contrôle manuel indispensable.";

  const averageDistance = formatNumber(result.averagePairDistanceM, 0);
  const spread = formatNumber(result.maxSpreadKm * 1000, 0);
  const sourceLabel = result.elevationSources.some(source => String(source).includes("Copernicus GLO-90"))
    ? "altitudes OSM et/ou modèle de terrain Copernicus GLO-90 (résolution 90 m)"
    : result.elevationSources.includes("OpenStreetMap (ele)")
      ? "altitudes taguées dans OpenStreetMap"
      : "balises OSM de position du terminal, sans altitude fiable pour tous les points";
  const fallbackNote = analysisAnchor && haversineKm(inputPoint.lat, inputPoint.lon, analysisAnchor.lat, analysisAnchor.lon) > 0.2
    ? ` Analyse centrée sur un point de référence voisin (${formatNumber(haversineKm(inputPoint.lat, inputPoint.lon, analysisAnchor.lat, analysisAnchor.lon), 1)} km du point saisi).`
    : "";
  $("#source-note").textContent = `Source : remontées OpenStreetMap ; ${sourceLabel}. ${Number.isFinite(result.meanElevation) ? `Altitude moyenne : ${formatNumber(result.meanElevation)} m. ` : "Aucune altitude moyenne fiable disponible. "}Distance moyenne entre terminaux : ${averageDistance} m ; dispersion maximale : ${spread} m.${fallbackNote} Score ${result.score}/100 : indicateur heuristique, pas une probabilité. Les six décimales sont un format d’affichage, pas une garantie de précision centimétrique.`;
  updateMap(result, stationName);
  drawAnalysisEvidence(result, inputPoint);
  renderAlternatives();
  renderAgentReport(result);
}

async function runAnalysis(primaryPoint, labelStation, fallbackStation = null) {
  const thisRun = ++analysisRunId;
  currentResult = null;
  lastAgentReport = { events: [] };
  const analysisAnchor = { lat: primaryPoint.lat, lon: primaryPoint.lon };
  $("#result-section").hidden = true;
  if ($("#agent-report")) $("#agent-report").hidden = true;
  selectedStation = labelStation || null;
  renderAlternatives();
  setStatus("Agent géographique : recherche des remontées, analyse des terminaux et comparaison des groupes…");
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
    if ($("#agent-report")) $("#agent-report").hidden = true;
    updateMap({ lat: primaryPoint.lat, lon: primaryPoint.lon }, "Point saisi — résultat non confirmé");
    setStatus(firstError?.message || "Impossible d’estimer le front de neige avec les données disponibles. Vérifie les coordonnées et réessaie.", "error");
    return;
  }

  displayResult(result, labelStation, primaryPoint, successfulAnchor);
  const confidenceText = result.count >= 3 ? "résultat basé sur plusieurs remontées" : "résultat à vérifier, peu de remontées exploitables";
  setStatus(`Analyse autonome terminée : ${labelStation?.name || "domaine détecté directement"}. ${confidenceText}. Score heuristique : ${result.score}/100 ; vérification cartographique recommandée.`, result.score >= 58 && result.count >= 2 ? "success" : "error");
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
    throw new Error('Coordonnées hors limites : latitude entre -90 et 90°, longitude entre -180 et 180°.');
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
  const exampleButton = document.querySelector('#format-use-example');
  const copyButton = document.querySelector('#format-copy-button');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const point = parseHemisphereCoordinates(input.value);
      const indentation = ' '.repeat(12);
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
