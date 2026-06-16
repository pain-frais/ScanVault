// ─── CLÉS API ─────────────────────────────────────────────────────────────────
// Les clés ne sont JAMAIS dans le code source.
// Elles sont saisies par l'utilisateur dans Réglages et stockées dans localStorage.

const STORAGE_KEYS = {
  DISCOGS_KEY:    'sv_discogs_key',
  DISCOGS_SECRET: 'sv_discogs_secret',
  TMDB_TOKEN:     'sv_tmdb_token',
  IGDB_CLIENT_ID: 'sv_igdb_client_id',
  IGDB_SECRET:    'sv_igdb_secret',
};

function getKey(name) {
  return localStorage.getItem(STORAGE_KEYS[name]) || '';
}

function saveKey(name, value) {
  if (value && value.trim()) {
    localStorage.setItem(STORAGE_KEYS[name], value.trim());
  }
}

function keysConfigured() {
  return !!(getKey('DISCOGS_KEY') && getKey('TMDB_TOKEN') && getKey('IGDB_CLIENT_ID'));
}

// ─── CATÉGORIES ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'all',    label: 'Tout',            emoji: '✦' },
  { id: 'book',   label: 'Livres',          emoji: '📚' },
  { id: 'vinyl',  label: 'Vinyles',         emoji: '🎵' },
  { id: 'cd',     label: 'CD',              emoji: '💿' },
  { id: 'movie',  label: 'Films & Séries',  emoji: '📀' },
  { id: 'game',   label: 'Jeux vidéo',      emoji: '🎮' },
  { id: 'board',  label: 'Jeux de société', emoji: '🎲' },
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
  const existing = inventory.find(i => i.barcode && i.barcode === item.barcode);
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
  const clientId = getKey('IGDB_CLIENT_ID');
  const secret = getKey('IGDB_SECRET');
  if (!clientId || !secret) return null;
  try {
    const r = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${secret}&grant_type=client_credentials`,
      { method: 'POST' }
    );
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
  try { return await (fns[category] || (() => null))(); }
  catch (e) { console.error(e); return null; }
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
      cover: info.imageLinks
        ? info.imageLinks.thumbnail.replace('http:', 'https:').replace('zoom=1', 'zoom=3')
        : null,
      description: info.description || '',
    };
  }
  // Fallback Open Library
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
  const key = getKey('DISCOGS_KEY');
  const secret = getKey('DISCOGS_SECRET');
  if (!key) return null;
  const r = await fetch(
    `https://api.discogs.com/database/search?barcode=${barcode}&type=release&key=${key}&secret=${secret}`
  );
  const d = await r.json();
  if (!d.results || d.results.length === 0) return null;
  const res = d.results[0];
  let price = null;
  try {
    const pr = await fetch(`https://api.discogs.com/marketplace/price_suggestions/${res.id}`, {
      headers: { 'Authorization': `Discogs key=${key}, secret=${secret}` }
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
  const token = getKey('TMDB_TOKEN');
  if (!token) return null;
  try {
    const upcR = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcD = await upcR.json();
    if (upcD.items && upcD.items.length > 0) {
      const title = upcD.items[0].title || '';
      const searchR = await fetch(
        `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(title)}&language=fr-FR`,
        { headers: { 'Authorization': `Bearer ${token}` } }
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
      const title = upcD.items[0].title || '';
      const token = await getIGDBToken();
      if (token && title) {
        const igdbR = await fetch('https://api.igdb.com/v4/games', {
          method: 'POST',
          headers: {
            'Client-ID': getKey('IGDB_CLIENT_ID'),
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'text/plain',
          },
          body: `search "${title.replace(/"/g, '')}"; fields name,cover.url,first_release_date,genres.name,platforms.name,summary,rating; limit 5;`,
        });
        const igdbD = await igdbR.json();
        if (igdbD && igdbD.length > 0) {
          const g = igdbD[0];
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
            cover: g.cover ? g.cover.url.replace('t_thumb', 't_cover_big').replace('http:', 'https:') : null,
            description: g.summary || '',
          };
        }
      }
      return {
        barcode, category: 'game',
        title: upcD.items[0].title || 'Jeu inconnu',
        subtitle: upcD.items[0].brand || '',
        details: { 'Marque': upcD.items[0].brand || '—' },
        cover: upcD.items[0].images?.[0] || null,
        description: upcD.items[0].description || '',
      };
    }
  } catch (e) { console.error(e); }
  return null;
}

async function lookupBoardGame(barcode) {
  try {
    const upcR = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcD = await upcR.json();
    const title = upcD.items?.[0]?.title || null;
    if (title) {
      const bggR = await fetch(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(title)}&type=boardgame`);
      const xml = new DOMParser().parseFromString(await bggR.text(), 'text/xml');
      const items = xml.querySelectorAll('item');
      if (items.length > 0) {
        const id = items[0].getAttribute('id');
        const detXml = new DOMParser().parseFromString(
          await (await fetch(`https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`)).text(),
          'text/xml'
        );
        const item = detXml.querySelector('item');
        if (item) {
          const g = (sel) => item.querySelector(sel);
          const cats = Array.from(item.querySelectorAll('link[type="boardgamecategory"]'))
            .slice(0, 2).map(l => l.getAttribute('value')).join(', ');
          return {
            barcode, category: 'board',
            title: g('name[type="primary"]')?.getAttribute('value') || title,
            subtitle: cats || '',
            details: {
              'Année': g('yearpublished')?.getAttribute('value') || '—',
              'Joueurs': (g('minplayers') && g('maxplayers'))
                ? `${g('minplayers').getAttribute('value')}–${g('maxplayers').getAttribute('value')}`
                : '—',
              'Âge minimum': g('minage') ? `${g('minage').getAttribute('value')}+` : '—',
              'Note BGG': g('average') ? `${parseFloat(g('average').getAttribute('value')).toFixed(1)}/10` : '—',
              'Catégorie': cats || '—',
            },
            cover: g('image')?.textContent?.trim()?.replace('http:', 'https:') || null,
            description: g('description')?.textContent?.replace(/<[^>]*>/g, '').slice(0, 300) || '',
          };
        }
      }
    }
  } catch (e) { console.error(e); }
  return null;
}

// ─── RENDER COLLECTION ────────────────────────────────────────────────────────
function getThumb(item) {
  const isSquare = ['vinyl', 'cd', 'movie', 'game', 'board'].includes(item.category);
  const cls = `item-thumb${isSquare ? ' square' : ''}`;
  const plcls = `item-thumb-placeholder${isSquare ? ' square' : ''}`;
  if (item.cover) {
    return `<img class="${cls}" src="${item.cover}" alt="" loading="lazy"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="${plcls}" style="display:none">${CAT_EMOJI[item.category] || '📦'}</div>`;
  }
  return `<div class="${plcls}">${CAT_EMOJI[item.category] || '📦'}</div>`;
}

function renderCollection() {
  const filtered = inventory.filter(item => {
    const matchCat = currentFilter === 'all' || item.category === currentFilter;
    const q = searchQuery.toLowerCase();
    const matchSearch = !q
      || item.title.toLowerCase().includes(q)
      || (item.subtitle || '').toLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  const grid = document.getElementById('collection-grid');
  const empty = document.getElementById('collection-empty');
  const countEl = document.getElementById('collection-count');
  const n = inventory.length;
  if (countEl) countEl.textContent = n === 0 ? 'Aucun article' : n === 1 ? '1 article' : `${n} articles`;

  if (filtered.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    empty.innerHTML = inventory.length === 0
      ? `<div class="empty-icon">📦</div>
         <div class="empty-title">Collection vide</div>
         <div class="empty-desc">Scanne un code-barres pour ajouter ton premier article.</div>`
      : `<div class="empty-icon">🔍</div>
         <div class="empty-title">Aucun résultat</div>
         <div class="empty-desc">Essaie un autre filtre ou terme de recherche.</div>`;
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
    </div>`).join('');
}

// ─── RENDER STATS ─────────────────────────────────────────────────────────────
function renderStats() {
  const total = inventory.length;
  const cats = {};
  inventory.forEach(i => { cats[i.category] = (cats[i.category] || 0) + 1; });
  const vinylPrice = inventory
    .filter(i => ['vinyl', 'cd'].includes(i.category) && i.price)
    .reduce((s, i) => s + (parseFloat((i.price || '').replace(/[^0-9.]/g, '')) || 0), 0);

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-cats').textContent = Object.keys(cats).length;
  document.getElementById('stat-vinyl-val').textContent = vinylPrice > 0 ? `~${vinylPrice.toFixed(0)} €` : '—';
  document.getElementById('stat-recent').textContent = total > 0
    ? new Date(inventory[0].addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    : '—';

  document.getElementById('cat-breakdown').innerHTML = CATEGORIES.filter(c => c.id !== 'all').map(c => {
    const count = cats[c.id] || 0;
    const pct = total > 0 ? count / total * 100 : 0;
    return `<div class="cat-row">
      <span class="cat-row-emoji">${c.emoji}</span>
      <span class="cat-row-name">${c.label}</span>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%"></div></div>
      <span class="cat-row-count">${count}</span>
    </div>`;
  }).join('');
}

// ─── RENDER SETTINGS ──────────────────────────────────────────────────────────
function renderSettings() {
  const configured = keysConfigured();
  const fields = [
    { key: 'DISCOGS_KEY',    label: 'Discogs — Consumer Key',    desc: 'Pour les vinyles et CD' },
    { key: 'DISCOGS_SECRET', label: 'Discogs — Consumer Secret', desc: 'Pour les vinyles et CD' },
    { key: 'TMDB_TOKEN',     label: 'TMDB — API Read Access Token', desc: 'Pour les films et séries' },
    { key: 'IGDB_CLIENT_ID', label: 'IGDB — Client ID (Twitch)',  desc: 'Pour les jeux vidéo' },
    { key: 'IGDB_SECRET',    label: 'IGDB — Client Secret (Twitch)', desc: 'Pour les jeux vidéo' },
  ];

  document.getElementById('settings-content').innerHTML = `
    ${!configured ? `
    <div class="setup-banner">
      <div class="setup-banner-icon">🔑</div>
      <div class="setup-banner-text">Saisis tes clés API ci-dessous pour activer toutes les fonctionnalités. Elles sont stockées uniquement sur cet appareil.</div>
    </div>` : `
    <div class="settings-status ok" style="margin-bottom:20px">
      ✓ Clés configurées — l'app est prête
    </div>`}

    <div class="settings-section">
      <div class="settings-section-title">Clés API</div>
      <div class="settings-card">
        ${fields.map(f => `
          <div class="settings-row">
            <div class="settings-row-label">${f.label}</div>
            <div class="settings-row-desc">${f.desc}</div>
            <div class="settings-key-visible">
              <input class="settings-input${getKey(f.key) ? ' saved' : ''}"
                     type="password"
                     id="field-${f.key}"
                     value="${escHtml(getKey(f.key))}"
                     placeholder="Colle ta clé ici"
                     autocomplete="off"
                     autocorrect="off"
                     spellcheck="false">
              <button class="toggle-visibility" onclick="toggleVisibility('field-${f.key}', this)">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
            </div>
          </div>`).join('')}
      </div>
      <button class="settings-save-btn" onclick="saveAllKeys()">Enregistrer les clés</button>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Données</div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-label">Collection</div>
          <div class="settings-row-desc">${inventory.length} article${inventory.length > 1 ? 's' : ''} stocké${inventory.length > 1 ? 's' : ''} sur cet appareil</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label" style="color:#ff3b30">Effacer toute la collection</div>
          <div class="settings-row-desc">Supprime tous les articles. Irréversible.</div>
          <button class="btn-danger" style="margin-top:8px;width:100%" onclick="clearCollection()">Effacer la collection</button>
        </div>
      </div>
    </div>

    <div style="font-size:12px;color:var(--text-tertiary);text-align:center;padding:8px 0 16px;line-height:1.6">
      ScanVault — tes clés et ta collection restent<br>uniquement sur cet appareil.
    </div>
  `;
}

function toggleVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.style.opacity = isHidden ? '1' : '0.4';
}

function saveAllKeys() {
  const fields = ['DISCOGS_KEY', 'DISCOGS_SECRET', 'TMDB_TOKEN', 'IGDB_CLIENT_ID', 'IGDB_SECRET'];
  let saved = 0;
  fields.forEach(key => {
    const el = document.getElementById(`field-${key}`);
    if (el && el.value.trim()) {
      saveKey(key, el.value.trim());
      el.classList.add('saved');
      saved++;
    }
  });
  // Reset IGDB token pour forcer un refresh avec les nouvelles clés
  localStorage.removeItem('igdb_token');
  localStorage.removeItem('igdb_token_expiry');
  igdbToken = null;
  igdbTokenExpiry = 0;
  showToast(saved > 0 ? '✓ Clés enregistrées !' : 'Aucune clé saisie');
  setTimeout(() => renderSettings(), 500);
}

function clearCollection() {
  if (confirm(`Supprimer les ${inventory.length} articles de ta collection ? Cette action est irréversible.`)) {
    inventory = [];
    save();
    renderSettings();
    showToast('Collection effacée');
  }
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function openDetail(id) {
  const item = inventory.find(i => i.id === id);
  if (!item) return;
  const isSquare = ['vinyl', 'cd', 'movie', 'game', 'board'].includes(item.category);
  const catLabel = CATEGORIES.find(c => c.id === item.category)?.label || item.category;
  const addedDate = new Date(item.addedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  const coverHtml = item.cover
    ? `<img class="modal-cover" style="${isSquare ? 'max-height:260px;object-fit:contain;background:var(--bg-secondary)' : ''}"
         src="${item.cover}" alt=""
         onerror="this.outerHTML='<div class=modal-cover-placeholder>${CAT_EMOJI[item.category]}</div>'">`
    : `<div class="modal-cover-placeholder">${CAT_EMOJI[item.category] || '📦'}</div>`;

  const rows = Object.entries(item.details || {})
    .filter(([, v]) => v && v !== '—')
    .map(([k, v]) => `<div class="modal-row">
      <span class="modal-row-label">${escHtml(k)}</span>
      <span class="modal-row-value">${escHtml(v)}</span>
    </div>`).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-handle"></div>
    ${coverHtml}
    <div class="modal-body">
      <div class="modal-category">${CAT_EMOJI[item.category]} ${catLabel}</div>
      <div class="modal-title">${escHtml(item.title)}</div>
      ${item.subtitle ? `<div class="modal-sub">${escHtml(item.subtitle)}</div>` : ''}
      ${item.price ? `<div class="modal-price">${escHtml(item.price)}</div>` : ''}
      ${rows ? `<div class="modal-divider"></div>${rows}` : ''}
      ${item.description ? `<div class="modal-divider"></div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
          ${escHtml(item.description.slice(0, 280))}${item.description.length > 280 ? '…' : ''}
        </div>` : ''}
      <div class="modal-divider"></div>
      <div class="modal-row">
        <span class="modal-row-label">Ajouté le</span>
        <span class="modal-row-value">${addedDate}</span>
      </div>
      <div class="modal-actions">
        <button class="btn-danger" onclick="confirmDelete('${id}')">Supprimer</button>
        <button class="btn-primary" onclick="closeModal()">Fermer</button>
      </div>
    </div>`;
  document.getElementById('modal').classList.add('open');
}

function closeModal() { document.getElementById('modal').classList.remove('open'); }

function confirmDelete(id) {
  if (confirm('Supprimer cet article de ta collection ?')) {
    removeItem(id);
    closeModal();
    renderCollection();
    showToast('Article supprimé');
  }
}

// ─── SCANNER ──────────────────────────────────────────────────────────────────
async function startScan() {
  if (scannerInstance) return;
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
    await scannerInstance.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        qrbox: { width: 270, height: 130 },
        aspectRatio: window.innerHeight / window.innerWidth,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
        ],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      },
      async (decodedText) => {
        await stopScan();
        await handleBarcode(decodedText);
      },
      () => {}
    );
  } catch (e) {
    console.error('Scanner error:', e);
    showToast('Autorise l\'accès à la caméra dans Réglages iOS');
    scannerInstance = null;
  }
}

async function stopScan() {
  if (scannerInstance) {
    try { await scannerInstance.stop(); } catch {}
    scannerInstance = null;
  }
}

async function handleBarcode(barcode) {
  showScanResult('loading');
  const item = await lookupBarcode(barcode, scanCategory);
  showScanResult(item ? 'found' : 'notfound', item || { barcode });
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
  const isSquare = ['vinyl', 'cd', 'movie', 'game', 'board'].includes(item.category);
  const catLabel = CATEGORIES.find(c => c.id === item.category)?.label || item.category;
  const coverHtml = item.cover
    ? `<img src="${item.cover}" style="width:100%;max-height:280px;object-fit:${isSquare ? 'contain' : 'cover'};background:var(--bg-secondary)" alt="">`
    : `<div style="height:160px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:72px">${CAT_EMOJI[item.category] || '📦'}</div>`;
  const rows = Object.entries(item.details || {})
    .filter(([, v]) => v && v !== '—')
    .map(([k, v]) => `<div class="modal-row"><span class="modal-row-label">${escHtml(k)}</span><span class="modal-row-value">${escHtml(v)}</span></div>`)
    .join('');

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
        ${item.description ? `<div class="modal-divider"></div>
          <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
            ${escHtml(item.description.slice(0, 300))}${item.description.length > 300 ? '…' : ''}
          </div>` : ''}
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
  if (addItem(item)) {
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

function openManualEntry() { document.getElementById('manual-modal').classList.add('open'); }
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
  if (tab === 'scan') startScan();
  else stopScan();
  if (tab === 'collection') renderCollection();
  if (tab === 'stats') renderStats();
  if (tab === 'settings') renderSettings();
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

// ─── UTILS ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Chips de filtre
  document.getElementById('filter-bar').innerHTML = CATEGORIES.map(c =>
    `<button class="chip${c.id === 'all' ? ' active' : ''}" data-cat="${c.id}" onclick="setFilter('${c.id}')">
      <span class="chip-emoji">${c.emoji}</span>${c.label}
    </button>`).join('');

  // Barre de catégories scanner
  document.getElementById('scan-cat-bar').innerHTML = CATEGORIES
    .filter(c => c.id !== 'all')
    .map(c => `<button class="scan-cat-btn${c.id === 'book' ? ' active' : ''}" data-scat="${c.id}" onclick="setScanCat('${c.id}')">${c.emoji} ${c.label}</button>`)
    .join('');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  renderCollection();

  // Si aucune clé configurée, ouvrir directement les réglages
  if (!keysConfigured()) {
    setTimeout(() => switchTab('settings'), 300);
  }

  document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });
  document.getElementById('manual-modal').addEventListener('click', e => { if (e.target === document.getElementById('manual-modal')) closeManualEntry(); });
  document.getElementById('search-input').addEventListener('input', e => { searchQuery = e.target.value; renderCollection(); });
  document.getElementById('manual-barcode-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitManualBarcode(); });
});
