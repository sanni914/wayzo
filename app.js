/*
  wayzo-app-fixed.js - Mobile-friendly improvements for Wayzo frontend
  ---------------------------------------------------------------
  WHAT I CHANGED (summary):
  - Made map responsive (invalidateSize on resize/orientationchange/keyboard events).
  - Improved touch support for Leaflet (enable touchZoom, disable tap fallback when needed).
  - Debounced heavy events to avoid thrashing on mobile.
  - Avoid blocking UI while fetching many images: render cards first, fetch images async and update card images lazily.
  - Use loading="lazy" on images and set max-width styles so images behave on narrow screens.
  - Reduce default sampling interval (smaller steps) and cap number of sampled points to avoid many Overpass calls on mobile data.
  - Use GOOGLE_API_KEY variable (please replace with your key) — removed hardcoded copies.

  REMINDERS / INTEGRATION NOTES:
  1) Add this in your HTML <head> for mobile responsiveness:
     <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  2) Include a small CSS snippet (make map container full-width and ensure lists scroll on mobile):
     #map{height:60vh;min-height:320px;width:100%;}
     @media (max-width:600px){ #map{height:55vh;} .places-section{padding:8px;} .place-card{flex-direction:column;} .place-img{width:100%;height:auto;} }
  3) Replace the GOOGLE_API_KEY value below with your own and restrict it in Google Cloud Console.

  Paste this file as your app.js (or merge the changes into your existing file).
*/

(async function () {
  // ---------- CONFIG ----------
  const GOOGLE_API_KEY = " "; // <<-- REPLACE
  const OSRM_ROUTER = 'https://router.project-osrm.org/route/v1';
  const overpassBase = 'https://overpass-api.de/api/interpreter';
  const placeholderImg = 'https://upload.wikimedia.org/wikipedia/commons/6/65/No-Image-Placeholder.svg';
  const defaultSampleIntervalKm = 10; // smaller by default (more granular on mobile)
  const maxSamplePoints = 40; // cap the number of sampled points to avoid spamming Overpass for mobile

  // ---------- DOM ----------
  const startInput = document.getElementById('startInput');
  const destInput = document.getElementById('destInput');
  const startSuggest = document.getElementById('startSuggest');
  const destSuggest = document.getElementById('destSuggest');
  const findBtn = document.getElementById('findBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');
  const placesList = document.getElementById('placesList');
  const distanceSelect = document.getElementById('distanceFilter');
  const toggleFuel = document.getElementById('toggleFuel');
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ---------- MAP ----------
  const map = L.map('map', { tap: false, detectRetina: true }).setView([20.5937, 78.9629], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

  // improve touch
  if (map.touchZoom) map.touchZoom.enable();
  if (map.dragging && L.Browser.touch) map.dragging.enable();

  const markersCluster = L.markerClusterGroup();
  map.addLayer(markersCluster);

  let routingControl = null;
  let fuelLayer = L.layerGroup().addTo(map);

  // ---------- helper functions ----------
  function setStatus(msg, isHTML) { if (!statusEl) return; statusEl[isHTML ? 'innerHTML' : 'textContent'] = msg; }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return R * c;
  }

  function sampleRoutePoints(routeCoords, intervalKm = defaultSampleIntervalKm) {
    if (!routeCoords || routeCoords.length === 0) return [];
    const sampled = [];
    let distAccum = 0;
    for (let i = 1; i < routeCoords.length; i++) {
      const [lat1, lon1] = routeCoords[i - 1];
      const [lat2, lon2] = routeCoords[i];
      const dist = haversineDistance(lat1, lon1, lat2, lon2);
      distAccum += dist;
      if (distAccum >= intervalKm) {
        sampled.push([lat2, lon2]);
        distAccum = 0;
        if (sampled.length >= maxSamplePoints) break; // don't sample too many points
      }
    }
    // ensure at least start and end
    if (sampled.length === 0 && routeCoords.length) sampled.push(routeCoords[Math.floor(routeCoords.length/2)]);
    return sampled;
  }

  function clearClusters() { markersCluster.clearLayers(); fuelLayer.clearLayers(); if (placesList) placesList.innerHTML = ''; }

  // ---------- AUTOCOMPLETE (Photon Komoot) ----------
  async function autocomplete(query) {
    if (!query || query.length < 2) return [];
    try {
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`);
      const j = await res.json();
      return j.features.map(f => ({
        display: (f.properties.name ? f.properties.name : '') + (f.properties.city ? ', ' + f.properties.city : '') + (f.properties.country ? ', ' + f.properties.country : ''),
        coord: f.geometry.coordinates // [lng, lat]
      }));
    } catch (e) { return []; }
  }

  // Make suggestions touch friendly and keyboard friendly.
  function setupAutosuggest(input, listEl) {
    let lastResults = [];
    input.addEventListener('input', async () => {
      const v = input.value.trim();
      if (v.length < 2) { listEl.innerHTML = ''; return; }
      const results = await autocomplete(v);
      lastResults = results;
      // Render as button-like list (touch friendly)
      listEl.innerHTML = results.map((r, i) => `<li class="suggest-item" data-idx="${i}">${escapeHtml(r.display)}</li>`).join('');
      Array.from(listEl.querySelectorAll('.suggest-item')).forEach(li => {
        li.addEventListener('click', (ev) => {
          const idx = parseInt(li.getAttribute('data-idx'));
          if (lastResults[idx]) input.value = lastResults[idx].display;
          listEl.innerHTML = '';
          input.blur();
        });
      });
    });
    input.addEventListener('focus', () => { if (input.value.length >= 2) input.dispatchEvent(new Event('input')); });
    // close when clicking outside (touch-friendly)
    document.addEventListener('touchstart', (e) => { if (!listEl.contains(e.target) && e.target !== input) listEl.innerHTML = ''; });
    document.addEventListener('click', (e) => { if (!listEl.contains(e.target) && e.target !== input) listEl.innerHTML = ''; });
  }
  setupAutosuggest(startInput, startSuggest);
  setupAutosuggest(destInput, destSuggest);

  // ---------- GEOCODE (Nominatim) ----------
  async function geocodePlace(placeName) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(placeName)}&limit=1`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.length > 0) return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
      return null;
    } catch (e) { return null; }
  }

  // ---------- OVERPASS QUERIES ----------
  async function fetchPOIs(lat, lng, radiusKm = 20) {
    const radius = Math.min(radiusKm * 1000, 50000); // cap radius
    const query = `\n[out:json][timeout:60];\n(\n  node(around:${radius},${lat},${lng})[tourism~"hotel|guest_house|hostel|motel"];\n  node(around:${radius},${lat},${lng})[tourism~"attraction|viewpoint|museum|gallery|theme_park|aquarium|zoo"];\n  node(around:${radius},${lat},${lng})[historic];\n);\nout center;\n`;
    try {
      const url = `${overpassBase}?data=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const j = await res.json();
      if (!j.elements) return [];
      return j.elements.map(el => ({
        id: el.id,
        name: (el.tags && (el.tags.name || el.tags['name:en'])) ? (el.tags.name || el.tags['name:en']) : 'Unknown',
        lat: el.lat,
        lng: el.lon,
        type: el.tags && el.tags.tourism ? el.tags.tourism : (el.tags && el.tags.historic ? el.tags.historic : 'attraction'),
        cat: el.tags && el.tags.tourism && /(hotel|guest_house|hostel|motel)/i.test(el.tags.tourism) ? 'hotel' : 'attraction',
        addr: (el.tags && (el.tags['addr:full'] || el.tags['addr:street'])) || ''
      }));
    } catch (e) { console.error('Overpass POI error', e); return []; }
  }

  async function fetchFuelPumps(lat, lng, radiusKm = 10) {
    const radius = Math.min(radiusKm * 1000, 30000);
    const query = `\n[out:json][timeout:60];\nnode(around:${radius},${lat},${lng})[amenity=fuel];\nout center;`;
    try {
      const url = `${overpassBase}?data=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const j = await res.json();
      if (!j.elements) return [];
      return j.elements.map(el => ({ id: el.id, name: (el.tags && el.tags.name) ? el.tags.name : 'Fuel Pump', lat: el.lat, lng: el.lon }));
    } catch (e) { return []; }
  }

  // ---------- IMAGE LOOKUP (non-blocking) ----------
  async function fetchGooglePhotoForPlace(name, lat, lng) {
    if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'YOUR_GOOGLE_API_KEY_HERE') return null;
    try {
      const q = `${encodeURIComponent(name)}`;
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?keyword=${q}&location=${lat},${lng}&rankby=distance&key=${GOOGLE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      if (j.results && j.results.length > 0 && j.results[0].photos && j.results[0].photos.length > 0) {
        const photoRef = j.results[0].photos[0].photo_reference;
        return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoRef}&key=${GOOGLE_API_KEY}`;
      }
      return null;
    } catch (e) {
      console.warn('Google photo lookup failed', e);
      return null;
    }
  }

  async function fetchWikiThumbnail(name) {
    if (!name) return null;
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=300&titles=${encodeURIComponent(name)}&origin=*`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      const pages = j.query && j.query.pages;
      for (const k in pages) { if (pages[k].thumbnail && pages[k].thumbnail.source) return pages[k].thumbnail.source; }
      return null;
    } catch (e) { return null; }
  }

  async function getBestImageForPlace(p) {
    const g = await fetchGooglePhotoForPlace(p.name, p.lat, p.lng);
    if (g) return g;
    const w = await fetchWikiThumbnail(p.name);
    if (w) return w;
    return placeholderImg;
  }

  // ---------- CORE: get places along route ----------
  async function getPlacesAlongRoute(routeCoords, maxDistanceKm = 20) {
    const sampled = sampleRoutePoints(routeCoords, defaultSampleIntervalKm);
    let all = [];
    // fetch POIs sequentially but limited; we already capped sampled points
    for (const pt of sampled) {
      const pois = await fetchPOIs(pt[0], pt[1], maxDistanceKm);
      all = all.concat(pois);
    }
    // dedupe by id
    const mapById = {};
    all.forEach(p => mapById[p.id] = p);
    return Object.values(mapById);
  }

  // ---------- RENDER ----------
  async function renderPOIs(list) {
    if (!placesList) return;
    placesList.innerHTML = '';
    markersCluster.clearLayers();

    const hotels = list.filter(p => p.cat === 'hotel');
    const attractions = list.filter(p => p.cat !== 'hotel');

    // helper to create card container quickly
    function createSection(title) {
      const section = document.createElement('div');
      section.className = 'places-section';
      const h = document.createElement('h4'); h.style.margin = '6px 0 10px'; h.textContent = `${title}`;
      section.appendChild(h);
      placesList.appendChild(section);
      return section;
    }

    if (attractions.length) {
      const section = createSection(`Tourist & Temple Places (${attractions.length})`);
      for (const p of attractions) {
        // create lightweight card first with placeholder image
        const card = makePlaceCard(p, placeholderImg, 'View Details', 'place-btn');
        section.appendChild(card);
        const m = L.marker([p.lat, p.lng]).bindPopup(`<b>${p.name}</b><div style="font-size:12px;color:#666">${p.type}</div>`);
        markersCluster.addLayer(m);
        // fetch best image async and update the card's img.src when ready
        (async () => { const img = await getBestImageForPlace(p); const el = card.querySelector('img.place-img'); if (el) el.src = img || placeholderImg; })();
      }
    }

    if (hotels.length) {
      const section2 = createSection(`Hotels & Lodges (${hotels.length})`);
      for (const p of hotels) {
        const card = makePlaceCard(p, placeholderImg, 'Book Room', 'place-btn book');
        section2.appendChild(card);
        const m = L.marker([p.lat, p.lng]).bindPopup(`<b>${p.name}</b><div style="font-size:12px;color:#666">${p.type}</div>`);
        markersCluster.addLayer(m);
        (async () => { const img = await getBestImageForPlace(p); const el = card.querySelector('img.place-img'); if (el) el.src = img || placeholderImg; })();
      }
    }

    // zoom map to cluster bounds (with padding suited for mobile)
    if (markersCluster.getLayers().length) map.fitBounds(markersCluster.getBounds(), { padding: [40, 40] });

    // ensure leafet layout is updated on mobile after DOM changes
    setTimeout(() => { safeInvalidateMap(); }, 300);
  }

  function makePlaceCard(p, imgUrl, actionLabel, actionClass) {
    const div = document.createElement('div');
    div.className = 'place-card';
    // ensure image is responsive and lazy loaded
    div.innerHTML = `\n      <img class="place-img" src="${imgUrl}" alt="${escapeHtml(p.name)}" loading="lazy" style="max-width:100%;height:auto;object-fit:cover;" onerror="this.src='${placeholderImg}'" />\n      <div class="place-info">\n        <div class="place-title">${escapeHtml(p.name)}</div>\n        <div class="place-meta">${escapeHtml(p.addr || p.type || '')}</div>\n        <div class="place-tags"><span class="place-tag ${p.cat === 'hotel' ? 'hotel' : 'attraction'}">${p.cat === 'hotel' ? 'Hotel/Lodge' : 'Attraction'}</span></div>\n        <div class="place-actions">\n          <a class="${actionClass}" target="_blank" rel="noopener noreferrer" href="${p.cat === 'hotel' ? `https://wa.me/?text=I%20want%20to%20book%20${encodeURIComponent(p.name)}%20via%20Wayzo` : `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`}"">${actionLabel}</a>\n          <a class="place-btn" target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/directions?from=${encodeURIComponent(startInput.value)}&to=${p.lat},${p.lng}">Navigate</a>\n        </div>\n      </div>\n    `;
    return div;
  }

  function escapeHtml(s) { if (!s) return ''; return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  // ---------- FUEL LAYER ----------
  async function showFuelAlongRoute(routeCoords, radiusKm = 10) {
    fuelLayer.clearLayers();
    const sampled = sampleRoutePoints(routeCoords, 20);
    const seen = {};
    for (const pt of sampled) {
      const pumps = await fetchFuelPumps(pt[0], pt[1], radiusKm);
      pumps.forEach(p => {
        if (!seen[p.id]) {
          seen[p.id] = true;
          const m = L.marker([p.lat, p.lng], { icon: L.icon({ iconUrl: 'https://cdn-icons-png.flaticon.com/512/2972/2972292.png', iconSize: [28,28] }) })
                      .bindPopup(`<b>${p.name}</b>`);
          fuelLayer.addLayer(m);
        }
      });
    }
  }

  // ---------- MAIN flow: compute route & query POIs ----------
  async function computeRouteAndFetch(startCoords, destCoords) {
    setStatus('<span class="spinner"></span> Computing shortest route...', true);

    if (routingControl) {
      try { map.removeControl(routingControl); } catch (e) {}
    }

    routingControl = L.Routing.control({
      waypoints: [L.latLng(startCoords[0], startCoords[1]), L.latLng(destCoords[0], destCoords[1])],
      router: L.Routing.osrmv1({ serviceUrl: OSRM_ROUTER }),
      show: false,
      fitSelectedRoute: true,
      lineOptions: { styles: [{ color: '#2563eb', opacity: 0.9, weight: 6 }] },
      createMarker: function(i, wp) { return L.marker(wp.latLng); }
    }).addTo(map);

    // ensure map paints correctly after route added (mobile quirk)
    setTimeout(() => safeInvalidateMap(), 400);

    routingControl.on('routesfound', async function (e) {
      const route = e.routes[0];
      const coords = route.coordinates.map(c => [c.lat, c.lng]);
      setStatus('<span class="spinner"></span> Searching places along route...', true);
      const radiusKm = parseInt(distanceSelect.value, 10) || 20;
      const pois = await getPlacesAlongRoute(coords, radiusKm);
      await renderPOIs(pois);
      setStatus(`Found ${pois.length} places within ${radiusKm} km of route.`);
      if (toggleFuel.checked) {
        setStatus('<span class="spinner"></span> Fetching fuel pumps...', true);
        await showFuelAlongRoute(coords, 10);
        setStatus(`Found ${pois.length} places. Fuel pumps are shown.`);
      } else {
        fuelLayer.clearLayers();
      }
    });

    routingControl.on('routingerror', function() {
      setStatus('Routing service error. Try again later.');
    });
  }

  // ---------- UI actions ----------
  findBtn.addEventListener('click', async () => {
    const start = startInput.value.trim(); const dest = destInput.value.trim();
    if (!start || !dest) { setStatus('Please enter both start and destination.'); return; }
    setStatus('<span class="spinner"></span> Geocoding...', true);
    const startCoords = await geocodePlace(start);
    const destCoords = await geocodePlace(dest);
    if (!startCoords || !destCoords) { setStatus('Could not geocode one of the locations. Try different names.'); return; }
    clearClusters();
    await computeRouteAndFetch(startCoords, destCoords);
  });

  clearBtn.addEventListener('click', () => {
    startInput.value = ''; destInput.value = '';
    startSuggest.innerHTML = ''; destSuggest.innerHTML = '';
    clearClusters();
    if (routingControl) try { map.removeControl(routingControl); } catch (e) {}
    setStatus('Cleared. Enter new route.');
  });

  toggleFuel.addEventListener('change', async () => {
    if (!routingControl) return;
    const routes = routingControl.getRoutes && routingControl.getRoutes();
    if (!routes || !routes.length) return;
    const route = routes[0];
    const coords = route.coordinates.map(c => [c.lat, c.lng]);
    if (toggleFuel.checked) { setStatus('<span class="spinner"></span> Fetching fuel pumps...', true); await showFuelAlongRoute(coords, 10); setStatus('Fuel pumps displayed.'); }
    else { fuelLayer.clearLayers(); setStatus('Fuel pumps hidden.'); }
  });

  // ---------- MAP resize / mobile quirks handling ----------
  function safeInvalidateMap() {
    try { map.invalidateSize({ animate: false }); } catch (e) { /* ignore */ }
  }

  // Debounce helper
  function debounce(fn, wait = 250) {
    let t = null; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  }

  const handleResize = debounce(() => { safeInvalidateMap(); }, 300);
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);

  // In some mobile browsers, when the virtual keyboard opens map size may be wrong.
  // Invalidate map when inputs lose focus so layout stabilizes.
  [startInput, destInput].forEach(inp => {
    inp.addEventListener('blur', () => setTimeout(() => safeInvalidateMap(), 300));
  });

  // Also attempt to invalidate initially after short delay (ensures map fits container)
  setTimeout(() => safeInvalidateMap(), 400);

  // ---------- initialization ----------
  setStatus('Ready. Enter start & destination.');
})();

/* DARK MODE */

const themeToggle = document.getElementById("themeToggle");

themeToggle.addEventListener("click",()=>{

  document.body.classList.toggle("dark-mode");

  if(document.body.classList.contains("dark-mode")){

    localStorage.setItem("theme","dark");

    themeToggle.innerHTML="☀️ Light Mode";

  }else{

    localStorage.setItem("theme","light");

    themeToggle.innerHTML="🌙 Dark Mode";
  }

});

/* SAVE THEME */

if(localStorage.getItem("theme")==="dark"){

  document.body.classList.add("dark-mode");

  themeToggle.innerHTML="☀️ Light Mode";
}
