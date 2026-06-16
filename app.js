// ─── CONFIG (chargée depuis config.js) ───────────────────────────────────────
const CONFIG = window.SCANVAULT_CONFIG || {};

const CATEGORIES = [
  { id: 'all',    label: 'Tout',           emoji: '✦' },
  { id: 'book',   label: 'Livres',         emoji: '📚' },
  { id: 'vinyl',  label: 'Vinyles',        emoji: '🎵' },
  { id: 'cd',     label: 'CD',             emoji: '💿' },
  { id: 'movie',  label: 'Films & Séries', emoji: '📀' },
  { id: 'game',   label: 'Jeux vidéo',     emoji: '🎮' },
  { id: 'board',  label: 'Jeux de société',emoji: '🎲' },
];

const CAT_EMOJI = Object.fromEntries(CATEGORIES.map(c => [c.id, c.emoji]));

// ─── STATE ────────────────────────────────────────────────────────────────────
let inventory = JSON.parse(localStorage.getItem('scanvault_inventory') || '[]');
let currentTab = 'collection';
let currentFilter = 'all';
let searchQuery = '';
let scanCategory = 'book';
let scannerInstance = null;
let igdbToken = localStorage.getItem('igdb_token') || null;
let igdbTokenExpiry = parseInt(localStorage.getItem('igdb_token_expiry') || '0');

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function save() {
  localStorage.setItem('scanvault_inventory', JSON.stringify(inventory));
}

function addItem(item) {
  const existing = inventory.find(i => i.barcode === item.barcode && item.barcode);
  if (existing) { showToast('Déjà dans ta collection !'); return false; }
  item.id = Date.now().toString();
  item.addedAt = new Date().toISOString();
  inventory.unshift(item);
  save();
  return true;
}

function removeItem(id) {
  inventory = inventory.filter(i => i.id !== id);
  save();
}

// ─── IGDB TOKEN ───────────────────────────────────────────────────────────────
async function getIGDBToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  try {
    const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CONFIG.IGDB_CLIENT_ID}&client_secret=${CONFIG.IGDB_SECRET}&grant_type=client_credentials`, { method: 'POST' });
    const d = await r.json();
    igdbToken = d.access_token;
    igdbTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
    localStorage.setItem('igdb_token', igdbToken);
    localStorage.setItem('igdb_token_expiry', igdbTokenExpiry.toString());
    return igdbToken;
  } catch { return null; }
}

// ─── API LOOKUPS ──────────────────────────────────────────────────────────────
async function lookupBarcode(barcode, category) {
  const fns = {
    book:  () => lookupBook(barcode),
    vinyl: () => lookupDiscogs(barcode, 'vinyl'),
    cd:    () => lookupDiscogs(barcode, 'cd'),
    movie: () => lookupTMDB(barcode),
    game:  () => lookupGame(barcode),
    board: () => lookupBoardGame(barcode),
  };
  const fn = fns[category];
  if (!fn) return null;
  try { return await fn(); } catch (e) { console.error(e); return null; }
}

async function lookupBook(barcode) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${barcode}`);
  const d = await r.json();
  if (d.items && d.items.length > 0) {
    const info = d.items[0].volumeInfo;
    return {
      barcode, category: 'book',
      title: info.title || 'Titre inconnu',
      subtitle: info.authors ? info.authors.join(', ') : '',
      details: {
        'Auteur(s)': info.authors ? info.authors.join(', ') : '—',
        'Éditeur': info.publisher || '—',
        'Année': info.publishedDate ? info.publishedDate.slice(0, 4) : '—',
        'Pages': info.pageCount ? `${info.pageCount} pages` : '—',
        'Genre': info.categories ? info.categories[0] : '—',
      },
      cover: info.imageLinks ? info.imageLinks.thumbnail.replace('http:', 'https:').replace('zoom=1', 'zoom=3') : null,
      description: info.description || '',
    };
  }
  const r2 = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${barcode}&format=json&jscmd=details`);
  const d2 = await r2.json();
  const key = `ISBN:${barcode}`;
  if (d2[key]) {
    const det = d2[key].details;
    return {
      barcode, category: 'book',
      title: det.title || 'Titre inconnu',
      subtitle: det.authors ? det.authors.map(a => a.name).join(', ') : '',
      details: {
        'Auteur(s)': det.authors ? det.authors.map(a => a.name).join(', ') : '—',
        'Éditeur': det.publishers ? det.publishers[0] : '—',
        'Année': det.publish_date || '—',
        'Pages': det.number_of_pages ? `${det.number_of_pages} pages` : '—',
      },
      cover: `https://covers.openlibrary.org/b/isbn/${barcode}-L.jpg`,
      description: '',
    };
  }
  return null;
}

async function lookupDiscogs(barcode, type) {
  const r = await fetch(
    `https://api.discogs.com/database/search?barcode=${barcode}&type=release&key=${CONFIG.DISCOGS_KEY}&secret=${CONFIG.DISCOGS_SECRET}`
  );
  const d = await r.json();
  if (!d.results || d.results.length === 0) return null;
  const res = d.results[0];

  let price = null;
  try {
    const pr = await fetch(`https://api.discogs.com/marketplace/price_suggestions/${res.id}`, {
      headers: { 'Authorization': `Discogs key=${CONFIG.DISCOGS_KEY}, secret=${CONFIG.DISCOGS_SECRET}` }
    });
    if (pr.ok) {
      const pd = await pr.json();
      const vals = Object.values(pd);
      if (vals.length > 0 && vals[0].suggested_price) {
        price = `~${vals[0].suggested_price.toFixed(2)} €`;
      }
    }
  } catch {}

  return {
    barcode, category: type,
    title: res.title ? res.title.split(' - ').slice(1).join(' - ') || res.title : 'Titre inconnu',
    subtitle: res.title ? res.title.split(' - ')[0] : '',
    details: {
      'Artiste': res.title ? res.title.split(' - ')[0] : '—',
      'Label': res.label ? res.label[0] : '—',
      'Année': res.year ? res.year.toString() : '—',
      'Genre': res.genre ? res.genre[0] : '—',
      'Style': res.style ? res.style.slice(0, 2).join(', ') : '—',
      'Format': res.format ? res.format.join(', ') : (type === 'vinyl' ? 'Vinyle' : 'CD'),
      'Pays': res.country || '—',
    },
    cover: res.cover_image || null,
    price,
    description: '',
  };
}

async function lookupTMDB(barcode) {
  try {
    const upcR = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcD = await upcR.json();
    if (upcD.items && upcD.items.length > 0) {
      const item = upcD.items[0];
      const title = item.title || '';
      const searchR = await fetch(
        `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(title)}&language=fr-FR`,
        { headers: { 'Authorization': `Bearer ${CONFIG.TMDB_TOKEN}` } }
      );
      const searchD = await searchR.json();
      if (searchD.results && searchD.results.length > 0) {
        const res = searchD.results[0];
        const isTV = res.media_type === 'tv';
        return {
          barcode, category: 'movie',
          title: res.title || res.name || title,
          subtitle: isTV ? 'Série' : 'Film',
          details: {
            'Type': isTV ? 'Série' : 'Film',
            'Année': (res.release_date || res.first_air_date || '').slice(0, 4) || '—',
            'Note': res.vote_average ? `${res.vote_average.toFixed(1)}/10` : '—',
            'Langue originale': res.original_language ? res.original_language.toUpperCase() : '—',
          },
          cover: res.poster_path ? `https://image.tmdb.org/t/p/w500${res.poster_path}` : null,
          description: res.overview || '',
        };
      }
    }
  } catch {}
  return null;
}

async function lookupGame(barcode) {
  try {
    const upcR = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcD = await upcR.json();
    if (upcD.items && upcD.items.length > 0) {
      const item = upcD.items[0];
      const title = item.title || '';
      const token = await getIGDBToken();
      if (token && title) {
        const igdbR = await fetch('https://api.igdb.com/v4/games', {
          method: 'POST',
          headers: {
            'Client-ID': CONFIG.IGDB_CLIENT_ID,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'text/plain',
          },
          body: `search "${title.replace(/"/g, '')}"; fields name,cover.url,first_release_date,genres.name,platforms.name,summary,rating; limit 5;`,
        });
        const igdbD = await igdbR.json();
        if (igdbD && igdbD.length > 0) {
          const g = igdbD[0];
          const coverUrl = g.cover ? g.cover.url.replace('t_thumb', 't_cover_big').replace('http:', 'https:') : null;
          return {
            barcode, category: 'game',
            title: g.name,
            subtitle: g.platforms ? g.platforms.map(p => p.name).join(', ') : '',
            details: {
              'Plateforme': g.platforms ? g.platforms.map(p => p.name).join(', ') : '—',
              'Année': g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear().toString() : '—',
              'Genre': g.genres ? g.genres.map(g => g.name).join(', ') : '—',
              'Note IGDB': g.rating ? `${Math.round(g.rating)}/100` : '—',
            },
            cover: coverUrl,
            description: g.summary || '',
          };
        }
      }
      return {
        barcode, category: 'game',
        title: item.title || 'Jeu inconnu',
        subtitle: item.brand || '',
        details: { 'Marque': item.brand || '—' },
        cover: item.images && item.images[0] ? item.images[0] : null,
        description: item.description || '',
      };
    }
  } catch (e) { console.error(e); }
  return null;
}

async function lookupBoardGame(barcode) {
  try {
    const upcR = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcD = await upcR.json();
    let title = null;
    if (upcD.items && upcD.items.length > 0) title = upcD.items[0].title;

    if (title) {
      const bggR = await fetch(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(title)}&type=boardgame`);
      const bggText = await bggR.text();
      const parser = new DOMParser();
      const xml = parser.parseFromString(bggText, 'text/xml');
      const items = xml.querySelectorAll('item');
      if (items.length > 0) {
        const id = items[0].getAttribute('id');
        const detR = await fetch(`https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`);
        const detText = await detR.text();
        const detXml = parser.parseFromString(detText, 'text/xml');
        const item = detXml.querySelector('item');
        if (item) {
          const nameEl = item.querySelector('name[type="primary"]');
          const img = item.querySelector('image');
          const yearEl = item.querySelector('yearpublished');
          const ratingEl = item.querySelector('average');
          const minP = item.querySelector('minplayers');
          const maxP = item.querySelector('maxplayers');
          const minAge = item.querySelector('minage');
          const desc = item.querySelector('description');
          const cats = Array.from(item.querySelectorAll('link[type="boardgamecategory"]')).slice(0, 2).map(l => l.getAttribute('value')).join(', ');
          return {
            barcode, category: 'board',
            title: nameEl ? nameEl.getAttribute('value') : title,
            subtitle: cats || '',
            details: {
              'Année': yearEl ? yearEl.getAttribute('value') : '—',
              'Joueurs': (minP && maxP) ? `${minP.getAttribute('value')}–${maxP.getAttribute('value')}` : '—',
              'Âge minimum': minAge ? `${minAge.getAttribute('value')}+` : '—',
              'Note BGG': ratingEl ? `${parseFloat(ratingEl.getAttribute('value')).toFixed(1)}/10` : '—',
              'Catégorie': cats || '—',
            },
            cover: img ? img.textContent.trim().replace('http:', 'https:') : null,
            description: desc ? desc.textContent.replace(/<[^>]*>/g, '').slice(0, 300) : '',
          };
        }
      }
    }
  } catch (e) { console.error(e); }
  return null;
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function getThumb(item) {
  const squareCats = ['vinyl', 'cd', 'movie', 'game', 'board'];
  const isSquare = squareCats.includes(item.category);
  if (item.cover) {
    return `<img class="item-thumb${isSquare ? ' square' : ''}" src="${item.cover}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="item-thumb-placeholder${isSquare ? ' square' : ''}" style="display:none">${CAT_EMOJI[item.category] || '📦'}</div>`;
  }
  return `<div class="item-thumb-placeholder${isSquare ? ' square' : ''}">${CAT_EMOJI[item.category] || '📦'}</div>`;
}

function renderCollection() {
  const filtered = inventory.filter(item => {
    const matchCat = currentFilter === 'all' || item.category === currentFilter;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q || item.title.toLowerCase().includes(q) || (item.subtitle || '').toLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  const grid = document.getElementById('collection-grid');
  const empty = document.getElementById('collection-empty');
  const countEl = document.getElementById('collection-count');
  if (countEl) {
    const n = inventory.length;
    countEl.textContent = n === 0 ? 'Aucun article' : n === 1 ? '1 article' : `${n} articles`;
  }

  if (filtered.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    empty.innerHTML = inventory.length === 0
      ? `<div class="empty-icon">📦</div><div class="empty-title">Collection vide</div><div class="empty-desc">Scanne un code-barres pour ajouter ton premier article.</div>`
      : `<div class="empty-icon">🔍</div><div class="empty-title">Aucun résultat</div><div class="empty-desc">Essaie un autre filtre ou terme de recherche.</div>`;
    return;
  }

  empty.style.display = 'none';
  grid.innerHTML = filtered.map(item => `
    <div class="item-card" onclick="openDetail('${item.id}')">
      ${getThumb(item)}
      <div class="item-info">
        <div class="item-title">${escHtml(item.title)}</div>
        ${item.subtitle ? `<div class="item-sub">${escHtml(item.subtitle)}</div>` : ''}
        ${item.price ? `<div class="item-badge">${escHtml(item.price)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function renderStats() {
  const total = inventory.length;
  const cats = {};
  inventory.forEach(i => { cats[i.category] = (cats[i.category] || 0) + 1; });

  const vinylPrice = inventory
    .filter(i => (i.category === 'vinyl' || i.category === 'cd') && i.price)
    .reduce((sum, i) => {
      const val = parseFloat((i.price || '').replace(/[^0-9.]/g, ''));
      return sum + (isNaN(val) ? 0 : val);
    }, 0);

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-cats').textContent = Object.keys(cats).length;
  document.getElementById('stat-vinyl-val').textContent = vinylPrice > 0 ? `~${vinylPrice.toFixed(0)} €` : '—';
  document.getElementById('stat-recent').textContent = total > 0
    ? new Date(inventory[0].addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    : '—';

  const breakdown = document.getElementById('cat-breakdown');
  breakdown.innerHTML = CATEGORIES.filter(c => c.id !== 'all').map(c => {
    const count = cats[c.id] || 0;
    const pct = total > 0 ? (count / total * 100) : 0;
    return `<div class="cat-row">
      <span class="cat-row-emoji">${c.emoji}</span>
      <span class="cat-row-name">${c.label}</span>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%"></div></div>
      <span class="cat-row-count">${count}</span>
    </div>`;
  }).join('');
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function openDetail(id) {
  const item = inventory.find(i => i.id === id);
  if (!item) return;

  const squareCats = ['vinyl', 'cd', 'movie', 'game', 'board'];
  const isSquare = squareCats.includes(item.category);

  let coverHtml = item.cover
    ? `<img class="modal-cover" style="${isSquare ? 'max-height:260px;object-fit:contain;background:var(--bg-secondary)' : ''}" src="${item.cover}" alt="" onerror="this.outerHTML='<div class=modal-cover-placeholder>${CAT_EMOJI[item.category]}</div>'">`
    : `<div class="modal-cover-placeholder">${CAT_EMOJI[item.category] || '📦'}</div>`;

  const rows = Object.entries(item.details || {})
    .filter(([,v]) => v && v !== '—')
    .map(([k, v]) => `<div class="modal-row"><span class="modal-row-label">${escHtml(k)}</span><span class="modal-row-value">${escHtml(v)}</span></div>`)
    .join('');

  const catLabel = CATEGORIES.find(c => c.id === item.category)?.label || item.category;
  const addedDate = new Date(item.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-handle"></div>
    ${coverHtml}
    <div class="modal-body">
      <div class="modal-category">${CAT_EMOJI[item.category]} ${catLabel}</div>
      <div class="modal-title">${escHtml(item.title)}</div>
      ${item.subtitle ? `<div class="modal-sub">${escHtml(item.subtitle)}</div>` : ''}
      ${item.price ? `<div class="modal-price">${escHtml(item.price)}</div>` : ''}
      ${rows ? `<div class="modal-divider"></div>${rows}` : ''}
      ${item.description ? `<div class="modal-divider"></div><div style="font-size:13px;color:var(--text-secondary);line-height:1.6">${escHtml(item.description.slice(0, 280))}${item.description.length > 280 ? '…' : ''}</div>` : ''}
      <div class="modal-divider"></div>
      <div class="modal-row"><span class="modal-row-label">Ajouté le</span><span class="modal-row-value">${addedDate}</span></div>
      <div class="modal-actions">
        <button class="btn-danger" onclick="confirmDelete('${id}')">Supprimer</button>
        <button class="btn-primary" onclick="closeModal()">Fermer</button>
      </div>
    </div>
  `;
  document.getElementById('modal').classList.add('open');
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }

function confirmDelete(id) {
  if (confirm('Supprimer cet article de ta collection ?')) {
    removeItem(id);
    closeModal();
    renderCollection();
    if (currentTab === 'stats') renderStats();
    showToast('Article supprimé');
  }
}

// ─── SCANNER (html5-qrcode) ───────────────────────────────────────────────────
async function startScan() {
  if (scannerInstance) return;

  // Charger html5-qrcode si pas encore chargé
  if (!window.Html5Qrcode) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  const container = document.getElementById('qr-reader');
  if (!container) return;

  try {
    scannerInstance = new Html5Qrcode('qr-reader');
    const config = {
      fps: 15,
      qrbox: { width: 280, height: 140 },
      aspectRatio: window.innerHeight / window.innerWidth,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
      ],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    };

    await scannerInstance.start(
      { facingMode: 'environment' },
      config,
      async (decodedText) => {
        if (scannerInstance) {
          await stopScan();
          await handleBarcode(decodedText);
        }
      },
      () => {} // Ignore erreurs de frame
    );
  } catch (e) {
    console.error('Scanner error:', e);
    showToast('Caméra non disponible — autorise l\'accès dans Réglages');
    scannerInstance = null;
  }
}

async function stopScan() {
  if (scannerInstance) {
    try { await scannerInstance.stop(); } catch {}
    scannerInstance = null;
  }
}

// ─── HANDLE BARCODE ───────────────────────────────────────────────────────────
async function handleBarcode(barcode) {
  showScanResult('loading');
  const item = await lookupBarcode(barcode, scanCategory);
  if (item) {
    showScanResult('found', item);
  } else {
    showScanResult('notfound', { barcode });
  }
}

function showScanResult(state, data = {}) {
  const el = document.getElementById('scan-result');
  el.classList.add('open');

  if (state === 'loading') {
    el.innerHTML = `
      <div class="scan-result-topbar">
        <button class="icon-btn" onclick="closeScanResult()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <span style="font-weight:600">Recherche en cours…</span>
      </div>
      <div class="loading-dots"><span></span><span></span><span></span></div>`;
    return;
  }

  if (state === 'notfound') {
    el.innerHTML = `
      <div class="scan-result-topbar">
        <button class="icon-btn" onclick="closeScanResult()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <span style="font-weight:600">Introuvable</span>
      </div>
      <div class="empty-state">
        <div class="empty-icon">🤷</div>
        <div class="empty-title">Code-barres non reconnu</div>
        <div class="empty-desc">Code : ${escHtml(data.barcode || '')}<br>Essaie une autre catégorie ou saisis manuellement.</div>
      </div>
      <div style="padding:0 24px 24px;display:flex;gap:10px">
        <button class="btn-secondary" onclick="closeScanResult()">Retour</button>
        <button class="btn-primary" onclick="addManual('${escHtml(data.barcode || '')}')">Ajouter manuellement</button>
      </div>`;
    return;
  }

  const item = data;
  const squareCats = ['vinyl', 'cd', 'movie', 'game', 'board'];
  const isSquare = squareCats.includes(item.category);
  const catLabel = CATEGORIES.find(c => c.id === item.category)?.label || item.category;

  let coverHtml = item.cover
    ? `<img src="${item.cover}" style="width:100%;max-height:280px;object-fit:${isSquare ? 'contain' : 'cover'};background:var(--bg-secondary)" alt="">`
    : `<div style="height:160px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:72px">${CAT_EMOJI[item.category] || '📦'}</div>`;

  const rows = Object.entries(item.details || {})
    .filter(([,v]) => v && v !== '—')
    .map(([k, v]) => `<div class="modal-row"><span class="modal-row-label">${escHtml(k)}</span><span class="modal-row-value">${escHtml(v)}</span></div>`)
    .join('');

  // Sérialiser proprement l'item pour le bouton
  const itemJson = JSON.stringify(item).replace(/'/g, '&#39;');

  el.innerHTML = `
    <div class="scan-result-topbar">
      <button class="icon-btn" onclick="closeScanResult()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
      </button>
      <span style="font-weight:600">Article trouvé !</span>
    </div>
    <div style="overflow-y:auto;flex:1;-webkit-overflow-scrolling:touch">
      ${coverHtml}
      <div class="modal-body">
        <div class="modal-category">${CAT_EMOJI[item.category]} ${catLabel}</div>
        <div class="modal-title">${escHtml(item.title)}</div>
        ${item.subtitle ? `<div class="modal-sub">${escHtml(item.subtitle)}</div>` : ''}
        ${item.price ? `<div class="modal-price">${escHtml(item.price)}</div>` : ''}
        ${rows ? `<div class="modal-divider"></div>${rows}` : ''}
        ${item.description ? `<div class="modal-divider"></div><div style="font-size:13px;color:var(--text-secondary);line-height:1.6">${escHtml(item.description.slice(0, 300))}${item.description.length > 300 ? '…' : ''}</div>` : ''}
        <div class="modal-actions" style="padding-bottom:8px">
          <button class="btn-secondary" onclick="closeScanResult()">Annuler</button>
          <button class="btn-primary" id="add-btn">Ajouter à ma collection</button>
        </div>
      </div>
    </div>`;

  document.getElementById('add-btn').addEventListener('click', () => confirmAdd(item));
}

function closeScanResult() {
  const el = document.getElementById('scan-result');
  el.classList.remove('open');
  el.innerHTML = '';
  setTimeout(() => startScan(), 400);
}

function confirmAdd(item) {
  const added = addItem(item);
  if (added) {
    showToast(`"${item.title}" ajouté !`);
    closeScanResult();
    renderCollection();
  }
}

function addManual(barcode) {
  const title = prompt('Titre de l\'article :');
  if (!title) return;
  const item = { barcode: barcode || null, category: scanCategory, title, subtitle: '', details: {}, cover: null, description: '' };
  if (addItem(item)) {
    showToast(`"${title}" ajouté !`);
    closeScanResult();
    renderCollection();
  }
}

function openManualEntry() {
  document.getElementById('manual-modal').classList.add('open');
}
function closeManualEntry() {
  document.getElementById('manual-modal').classList.remove('open');
  document.getElementById('manual-barcode-input').value = '';
}
async function submitManualBarcode() {
  const val = document.getElementById('manual-barcode-input').value.trim();
  if (!val) return;
  closeManualEntry();
  await stopScan();
  await handleBarcode(val);
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${tab}`).classList.add('active');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'scan') {
    startScan();
  } else {
    stopScan();
    if (tab === 'collection') renderCollection();
    if (tab === 'stats') renderStats();
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function setFilter(cat) {
  currentFilter = cat;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-cat="${cat}"]`).classList.add('active');
  renderCollection();
}

function setScanCat(cat) {
  scanCategory = cat;
  document.querySelectorAll('.scan-cat-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-scat="${cat}"]`).classList.add('active');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const filterBar = document.getElementById('filter-bar');
  filterBar.innerHTML = CATEGORIES.map(c =>
    `<button class="chip${c.id === 'all' ? ' active' : ''}" data-cat="${c.id}" onclick="setFilter('${c.id}')">
      <span class="chip-emoji">${c.emoji}</span>${c.label}
    </button>`
  ).join('');

  const scanBar = document.getElementById('scan-cat-bar');
  scanBar.innerHTML = CATEGORIES.filter(c => c.id !== 'all').map(c =>
    `<button class="scan-cat-btn${c.id === 'book' ? ' active' : ''}" data-scat="${c.id}" onclick="setScanCat('${c.id}')">${c.emoji} ${c.label}</button>`
  ).join('');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  renderCollection();

  document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });
  document.getElementById('manual-modal').addEventListener('click', function(e) {
    if (e.target === this) closeManualEntry();
  });

  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderCollection();
  });

  document.getElementById('manual-barcode-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitManualBarcode();
  });
});
