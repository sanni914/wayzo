(async function() {
    // Short autocomplete using photon.komoot.de (free, OSM database)
    function autocomplete(query, cb) {
      if (!query || query.length < 2) return cb([]);
      fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6`)
        .then(r=>r.json())
        .then(j=>cb(j.features.map(f=>({
          name: f.properties.name,
          label: f.properties.city || f.properties.name,
          display: f.properties.country ? `${f.properties.name}, ${f.properties.country}` : f.properties.name,
          coord: f.geometry.coordinates
        }))))
        .catch(()=>cb([]));
    }
  
    // Auto suggestion UI logic
    function setupAutosuggest(input, listEl) {
      input.addEventListener('input', ()=>{
        const v = input.value.trim();
        autocomplete(v, (results)=>{
          listEl.innerHTML = results.map(r=>`<li>${r.display}</li>`).join('');
          Array.from(listEl.children).forEach((li,idx)=>{
            li.onclick=()=>{input.value=results[idx].display;listEl.innerHTML='';}
          });
        });
      });
      input.addEventListener('focus', ()=>{ if (input.value.length>=2) input.dispatchEvent(new Event('input')); });
      document.addEventListener('click', (e)=>{ if(!listEl.contains(e.target) && e.target!==input) listEl.innerHTML=''; });
    }
    setupAutosuggest(document.getElementById('startInput'), document.getElementById('startSuggest'));
    setupAutosuggest(document.getElementById('destInput'), document.getElementById('destSuggest'));
  
    const startInput = document.getElementById('startInput');
    const destInput = document.getElementById('destInput');
    const findBtn = document.getElementById('findBtn');
    const statusEl = document.getElementById('status');
    const placesList = document.getElementById('placesList');
    const map = L.map('map').setView([20.5937, 78.9629], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  
    let routingControl, markers = [];
  
    async function geocodePlace(placeName) {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(placeName)}`;
      try {
        const res = await fetch(url); const data = await res.json();
        if (data.length > 0) return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
        throw new Error("No results");
      } catch { return null; }
    }
  
    function haversineDistance(lat1, lon1, lat2, lon2) {
      const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return R * c;
    }
    function sampleRoutePoints(routeCoords, intervalKm = 12) {
      if (!routeCoords || routeCoords.length === 0) return [];
      const sampled = []; let distAccum = 0;
      for (let i = 1; i < routeCoords.length; i++) {
        const [lat1, lon1] = routeCoords[i - 1]; const [lat2, lon2] = routeCoords[i];
        const dist = haversineDistance(lat1, lon1, lat2, lon2); distAccum += dist;
        if (distAccum >= intervalKm) { sampled.push([lat2, lon2]); distAccum = 0;}
      } return sampled;
    }
    async function fetchPOIs(lat, lng, radiusKm=20){
      const radius = radiusKm*1000;
      const query = `
        [out:json]; (
          node(around:${radius},${lat},${lng})[tourism~"hotel|guest_house|hostel|motel"];
          node(around:${radius},${lat},${lng})[tourism~"attraction|zoo|viewpoint|museum|gallery|theme_park|aquarium"];
          node(around:${radius},${lat},${lng})[historic];
        ); out center;`;
      const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
      try {
        const res = await fetch(url); const data = await res.json();
        return data.elements.map(el=>({
          id: el.id, name: el.tags.name || 'Unknown', lat: el.lat, lng: el.lon,
          type: el.tags.tourism || el.tags.historic || 'attraction',
          cat: el.tags.tourism && /(hotel|guest_house|hostel|motel)/i.test(el.tags.tourism) ? 'hotel' : 'attraction',
          addr: el.tags['addr:full']||'' })
        );
      } catch{return [];}
    }
  
    async function fetchPlaceImage(name) {
      if (!name) return 'https://upload.wikimedia.org/wikipedia/commons/6/65/No-Image-Placeholder.svg';
      const url=`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=170&titles=${encodeURIComponent(name)}&origin=*`;
      try {
        const res = await fetch(url); const data = await res.json(); const pages = data.query.pages;
        for (let key in pages) if (pages[key].thumbnail) return pages[key].thumbnail.source;
      } catch {}
      return 'https://upload.wikimedia.org/wikipedia/commons/6/65/No-Image-Placeholder.svg';
    }
    function clearMarkers(){ markers.forEach(m => map.removeLayer(m)); markers = []; }
  
    async function renderPOIs(list) {
      placesList.innerHTML = ''; clearMarkers();
      // Separate
      const hotels = [], attractions = [];
      for (const p of list) (p.cat === 'hotel' ? hotels : attractions).push(p);
      const makeCard = async (p, idx, ctype) => {
        const img = await fetchPlaceImage(p.name);
        const desc = ctype === 'hotel'
          ? "Book stays instantly & get best rates via Wayzo."
          : "Discover, click for map & details.";
        const actionLabel = ctype === 'hotel'
          ? "Book Room"
          : "View Details";
        const actionClass = ctype === 'hotel' ? 'place-btn book' : 'place-btn';
        // Booking link: for demo, use WhatsApp or a special modal/route for you
        const bookHref = ctype === 'hotel'
          ? `https://wa.me/?text=I%20want%20to%20book%20${encodeURIComponent(p.name)}%20via%20Wayzo`
          : `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=15/${p.lat}/${p.lng}`;
        return `
          <div class="place-card">
            <img class="place-img" src="${img}" alt="${p.name}" />
            <div class="place-info">
              <div class="place-title">${p.name}</div>
              <div class="place-meta">${desc}</div>
              <div class="place-tags">
                <span class="place-tag ${ctype==='hotel'?'hotel':'attraction'}">
                 ${ctype==='hotel'?'Hotel/Lodge':'Attraction'}
                </span>
              </div>
              <div class="place-actions">
                <a class="${actionClass}" target="_blank" href="${bookHref}">${actionLabel}</a>
              </div>
            </div>
          </div>`;
      };
      const hotelSection = hotels.length
        ? `<div class="places-section"><h4>Hotels & Lodges</h4>${(await Promise.all(hotels.map((p,i)=>makeCard(p,i,'hotel')))).join('')}</div>` : '';
      const attrSection = attractions.length
        ? `<div class="places-section"><h4>Tourist Places</h4>${(await Promise.all(attractions.map((p,i)=>makeCard(p,i,'attraction')))).join('')}</div>` : '';
      placesList.innerHTML = hotelSection+attrSection;
      // Markers
      [...hotels, ...attractions].forEach((p,i)=>{
        const m = L.marker([p.lat,p.lng]).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.type}`);
        markers.push(m);
      });
    }
  
    async function getPlacesAlongRoute(routeCoords, maxDistanceKm=20) {
      const sampled = sampleRoutePoints(routeCoords, 15); let allPOIs = [];
      for(const pt of sampled) allPOIs = allPOIs.concat(await fetchPOIs(pt[0], pt[1], maxDistanceKm));
      const unique = {}; allPOIs.forEach(p=>unique[p.id]=p); return Object.values(unique);
    }
  
    findBtn.addEventListener('click', async () => {
      const start = startInput.value.trim(), dest = destInput.value.trim();
      if (!start || !dest) { statusEl.textContent = "Enter both start and destination."; return; }
      statusEl.innerHTML = '<span class="spinner"></span> Finding route ...';
      const startCoords = await geocodePlace(start), destCoords = await geocodePlace(dest);
      if (!startCoords || !destCoords) { statusEl.textContent = "Could not geocode locations."; return; }
      if(routingControl) map.removeControl(routingControl);
      routingControl = L.Routing.control({
        waypoints: [L.latLng(startCoords[0], startCoords[1]), L.latLng(destCoords[0], destCoords[1])],
        routeWhileDragging:false
      }).addTo(map);
      routingControl.on('routesfound', async function(e){
        const route = e.routes[0];
        const coords = route.coordinates.map(c=>[c.lat, c.lng]);
        statusEl.innerHTML = '<span class="spinner"></span> Fetching places along route...';
        const pois = await getPlacesAlongRoute(coords, 20);
        await renderPOIs(pois);
        statusEl.textContent = `Found ${pois.length} places within 20 km of route.`;
      });
    });
  
  })();
  