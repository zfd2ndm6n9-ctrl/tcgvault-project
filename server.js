require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

const IS_SANDBOX = String(process.env.APP_ENV || '').toLowerCase() === 'sandbox';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, IS_SANDBOX ? 'data-sandbox' : 'data');
function dataFile(name) {
    return path.join(DATA_DIR, name);
}

const stripe = process.env.STRIPE_SECRET_KEY
    ? require('stripe')(process.env.STRIPE_SECRET_KEY)
    : null;

const corsMiddleware = require('cors');
app.use(corsMiddleware({ origin: true }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

function persistOrdersToDisk() {
    try {
        const file = dataFile('orders.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(ordersDB, null, 2));
    } catch (err) {
        console.error('Salvataggio ordini fallito:', err.message);
    }
    persistOrdersToSupabase().catch(err => console.error('Salvataggio ordini Supabase:', err.message));
}

function loadOrdersFromDisk() {
    try {
        const file = dataFile('orders.json');
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) ordersDB = parsed;
    } catch (err) {
        console.error('Lettura ordini persistiti fallita:', err.message);
    }
}

async function markCardsSold(cardIds) {
    const ids = [...new Set((cardIds || []).map(id => String(id).trim()).filter(id => id && id !== 'undefined' && id !== 'null'))];
    if (!ids.length) return;
    const filter = ids.every(id => /^\d+$/.test(id))
        ? 'id=in.(' + ids.join(',') + ')'
        : 'id=in.(' + ids.map(id => '"' + id.replace(/"/g, '') + '"').join(',') + ')';
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/cards?' + filter, {
            method: 'PATCH',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal'
            },
            body: JSON.stringify({ is_sold: true })
        });
        if (!res.ok) {
            console.error('Marcatura venduto fallita:', res.status, await res.text());
        }
    } catch (err) {
        console.error('Marcatura venduto fallita:', err.message);
    }
}

function generateMeetupCode() {
    return 'TCG-meet-' + crypto.randomBytes(8).toString('hex');
}

function meetupQrImageUrl(token) {
    if (!token) return '';
    return 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(String(token));
}

function meetupTokenMatch(order, raw) {
    const token = String(raw || '').trim();
    if (!token || !order) return false;
    return token === String(order.meetupCode || '') || token === String(order.meetupQrToken || '');
}

function assertMeetupAllowed(auth, amount) {
    if (Number(amount) > MEETUP_MAX_AMOUNT) {
        return 'Sopra €' + MEETUP_MAX_AMOUNT + ' l\'incontro non è consentito: solo spedizione tracciata.';
    }
    return null;
}

function publicOrderFor(order, viewerId) {
    const row = Object.assign({}, order);
    const isSeller = String(order.sellerId) === String(viewerId);
    const isBuyer = String(order.buyerId) === String(viewerId);
    if (isSeller) {
        delete row.meetupCode;
        delete row.meetupQrToken;
        delete row.meetupQrUrl;
    } else if (isBuyer && (row.meetupCode || row.meetupQrToken)) {
        const token = row.meetupQrToken || row.meetupCode;
        row.meetupQrToken = token;
        row.meetupQrUrl = meetupQrImageUrl(token);
    } else {
        delete row.meetupCode;
        delete row.meetupQrToken;
        delete row.meetupQrUrl;
    }
    return row;
}

function escrowSenderName(order, step) {
    const parts = ['escrow', step, String(order.sellerId || ''), String(order.buyerId || ''), order.deliveryMethod === 'meetup' ? 'meetup' : 'shipping'];
    if (order.trackingLink) {
        parts.push(encodeURIComponent(order.carrier || ''), encodeURIComponent(order.trackingNumber || ''), encodeURIComponent(order.trackingLink));
    }
    return parts.join('|');
}

function pushOrderEscrowMessages(order, step, sellerText, buyerText) {
    const title = order.cardTitle || 'Articolo TCG';
    const base = {
        senderId: 'SYSTEM_ESCROW',
        cardId: order.cardId || null,
        isEscrowAlert: true,
        deliveryMethod: order.deliveryMethod || 'shipping',
        orderId: order.id,
        sellerId: order.sellerId,
        buyerId: order.buyerId,
        escrowStep: step,
        senderName: escrowSenderName(order, step)
    };
    if (sellerText && order.sellerId && order.sellerId !== 'unknown') {
        messagesDB.push({
            ...base,
            id: 'msg-' + Date.now() + '-s-' + Math.random().toString(36).slice(2, 8),
            receiverId: String(order.sellerId),
            text: String(sellerText).replace(/\{title\}/g, title),
            timestamp: new Date().toISOString()
        });
    }
    if (buyerText && order.buyerId) {
        messagesDB.push({
            ...base,
            id: 'msg-' + Date.now() + '-b-' + Math.random().toString(36).slice(2, 8),
            receiverId: String(order.buyerId),
            text: String(buyerText).replace(/\{title\}/g, title),
            timestamp: new Date().toISOString()
        });
    }
    persistMessagesToDisk();
}

async function fulfillPaidOrder(order) {
    if (!order || order.escrowNotified) return order;
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.escrowNotified = true;
    const isMeetup = order.deliveryMethod === 'meetup';
    if (isMeetup) {
        if (!order.meetupCode) order.meetupCode = generateMeetupCode();
        order.meetupQrToken = order.meetupQrToken || order.meetupCode;
    }
    const euro = Number(order.amount).toFixed(2);
    if (isMeetup) {
        pushOrderEscrowMessages(
            order,
            'paid_meetup',
            `Incontro pagato · {title} · €${euro}. Proponi un luogo pubblico, poi scansiona il QR del compratore.`,
            `Hai pagato {title} · €${euro} (incontro). Aspetta luogo e orario, ispeziona, poi mostra il QR.`
        );
    } else {
        pushOrderEscrowMessages(
            order,
            'paid_shipping',
            `Vendita pagata · {title} · €${euro}. I fondi sono in escrow. Inserisci corriere e tracking.`,
            `Hai pagato {title} · €${euro}. Aspetta il tracking, poi conferma quando arriva il pacco.`
        );
    }
    persistOrdersToDisk();
    await markCardsSold(order.cardIds && order.cardIds.length ? order.cardIds : [order.cardId]);
    return order;
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe non configurato.' });
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    let event = null;
    try {
        if (secret && req.headers['stripe-signature']) {
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
        } else {
            return res.status(400).json({ error: 'Webhook non verificato.' });
        }
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        const order = ordersDB.find(o => o.paymentIntentId === pi.id);
        if (order) await fulfillPaidOrder(order);
    }
    res.json({ received: true });
});

app.use(express.json({ limit: '256kb' }));

const SANDBOX_BANNER = '<div id="tcg-sandbox-banner" style="position:sticky;top:0;z-index:99999;background:#f5c518;color:#111;text-align:center;font:600 13px/1.45 system-ui,sans-serif;padding:8px 12px">SANDBOX — ambiente di prova, non il sito live</div>';

app.use((req, res, next) => {
    if (!IS_SANDBOX || req.method !== 'GET') return next();
    const rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
    if (!rel.endsWith('.html')) return next();
    const publicRoot = path.resolve(path.join(__dirname, 'public'));
    const file = path.resolve(path.join(publicRoot, rel));
    if (!file.startsWith(publicRoot + path.sep) && file !== publicRoot) return next();
    if (!fs.existsSync(file)) return next();
    let html = fs.readFileSync(file, 'utf8');
    if (/<body[\s>]/i.test(html)) html = html.replace(/<body([^>]*)>/i, '<body$1>' + SANDBOX_BANNER);
    else html = SANDBOX_BANNER + html;
    res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, 'public')));

let messagesDB = [];
let reviewsDB = [];
let ordersDB = [];
let usersDB = []; 
let userPresenceDB = {};
let shopSubsDB = [];
let tournamentsDB = [];
let promoCodesDB = [];
let accountsDB = [];

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || 'francesco_delduca@icloud.com')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

const MESSAGES_FILE = dataFile('messages.json');

function loadMessagesFromDisk() {
    try {
        if (!fs.existsSync(MESSAGES_FILE)) return;
        const parsed = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
        messagesDB = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Lettura messaggi persistiti fallita:', err.message);
        messagesDB = [];
    }
}

function persistMessagesToDisk() {
    persistJsonFile('messages.json', messagesDB);
    persistMessagesToSupabase().catch(err => console.error('Salvataggio messaggi Supabase:', err.message));
}

function idsMatch(a, b) {
    return String(a || '') === String(b || '');
}

function extractCityFromProfile(row) {
    if (!row) return '';
    const dedicated = String(row.city || row.citta || '').trim();
    if (dedicated) return dedicated;
    const raw = String(row.location || row.address || '').trim();
    if (!raw) return '';
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : '';
}

function extractStreetFromProfile(row) {
    if (!row) return '';
    const city = extractCityFromProfile(row).toLowerCase();
    const raw = String(row.address || row.location || '').trim();
    if (!raw) return '';
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (city && parts.length > 1 && parts[parts.length - 1].toLowerCase() === city) {
        return parts.slice(0, -1).join(', ');
    }
    return raw;
}

function formatProfilePlace(row) {
    const street = extractStreetFromProfile(row);
    const city = extractCityFromProfile(row);
    if (street && city && street.toLowerCase() !== city.toLowerCase()) return street + ', ' + city;
    return street || city || '';
}

function mapsEmbedUrl(query) {
    const q = String(query || '').trim();
    if (!q) return '';
    return 'https://maps.google.com/maps?q=' + encodeURIComponent(q) + '&z=14&output=embed';
}

const geoCache = Object.create(null);
let geoChain = Promise.resolve();
let lastGeoAt = 0;

function haversineKm(aLat, aLng, bLat, bLng) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function geoTokens(text) {
    return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(t => t.length > 1);
}

function scoreGeoHit(hit, street, city, tokens) {
    const name = String(hit.display_name || '').toLowerCase();
    const addr = hit.address || {};
    let score = Number(hit.importance) || 0;
    const cityNeed = String(city || '').toLowerCase().trim();
    const cityNames = [addr.city, addr.town, addr.village, addr.municipality, addr.suburb, addr.county]
        .filter(Boolean).map(v => String(v).toLowerCase());
    if (cityNeed) {
        if (cityNames.some(n => n === cityNeed || n.includes(cityNeed) || cityNeed.includes(n))) score += 10;
        else if (name.includes(cityNeed)) score += 3;
        else score -= 8;
    }
    const streetNeed = String(street || '').toLowerCase().trim();
    if (streetNeed) {
        const road = String(addr.road || '').toLowerCase();
        const house = String(addr.house_number || '');
        const streetCore = streetNeed.replace(/\b(via|viale|piazza|corso|largo|vicolo|strada)\b/g, '').trim();
        if (road && (streetNeed.includes(road) || road.includes(streetCore.split(/\s+/)[0] || '___'))) score += 7;
        const num = streetNeed.match(/\d+[a-z]?/i);
        if (num && house && house.toLowerCase() === num[0].toLowerCase()) score += 5;
        else if (num && name.includes(num[0].toLowerCase())) score += 2;
    }
    tokens.forEach(t => { if (name.includes(t)) score += 0.6; });
    if (hit.class === 'building' || hit.type === 'house' || hit.type === 'yes') score += 1.5;
    return score;
}

function hitToGeo(hit) {
    return {
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        label: hit.display_name || ''
    };
}

async function nominatimSearch(params) {
    const url = 'https://nominatim.openstreetmap.org/search?' + params.toString();
    const res = await fetch(url, { headers: { 'User-Agent': 'TCGVault/1.0 (https://tcg-vault.it)', Accept: 'application/json' } });
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
}

function geocodePlace(query, street, city) {
    const q = String(query || '').trim();
    const st = String(street || '').trim();
    const ct = String(city || '').trim();
    if (q.length < 2 && !(st && ct) && ct.length < 2) return Promise.resolve(null);
    const key = [st, ct, q].join('|').toLowerCase();
    if (geoCache[key]) return Promise.resolve(geoCache[key]);
    geoChain = geoChain.then(async () => {
        if (geoCache[key]) return geoCache[key];
        const wait = 1100 - (Date.now() - lastGeoAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastGeoAt = Date.now();
        try {
            const tokens = geoTokens([st, ct, q].join(' '));
            let hits = [];
            if (st && ct) {
                const structured = new URLSearchParams({
                    format: 'json',
                    addressdetails: '1',
                    limit: '8',
                    countrycodes: 'it',
                    country: 'Italia',
                    street: st,
                    city: ct
                });
                hits = await nominatimSearch(structured);
                lastGeoAt = Date.now();
            }
            if (!hits.length) {
                const wait2 = 1100 - (Date.now() - lastGeoAt);
                if (wait2 > 0) await new Promise(r => setTimeout(r, wait2));
                lastGeoAt = Date.now();
                const free = new URLSearchParams({
                    format: 'json',
                    addressdetails: '1',
                    limit: '8',
                    countrycodes: 'it',
                    q: (st && ct ? (st + ', ' + ct + ', Italia') : (q || [st, ct].filter(Boolean).join(', ') + ', Italia'))
                });
                hits = await nominatimSearch(free);
            }
            if (!hits.length) return null;
            hits.sort((a, b) => scoreGeoHit(b, st, ct, tokens) - scoreGeoHit(a, st, ct, tokens));
            const best = hits[0];
            if (!best) return null;
            geoCache[key] = hitToGeo(best);
            return geoCache[key];
        } catch (err) {
            console.error('Geocode:', err.message);
            return null;
        }
    });
    return geoChain;
}

function loadJsonObject(fileName) {
    try {
        const file = dataFile(fileName);
        if (!fs.existsSync(file)) return {};
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        return {};
    }
}

let profileExtras = loadJsonObject('profile-extras.json');

function extraFor(userId) {
    return profileExtras[String(userId)] || {};
}

function saveProfileExtra(userId, patch) {
    const id = String(userId);
    profileExtras[id] = { ...extraFor(id), ...patch };
    persistJsonFile('profile-extras.json', profileExtras);
}

function mergeProfileRow(row) {
    if (!row || !row.id) return row;
    const extra = extraFor(row.id);
    return {
        ...extra,
        ...row,
        address: row.address || extra.address || '',
        city: row.city || extra.city || '',
        avatar_url: row.avatar_url || extra.avatar_url || '',
        lat: row.lat != null && row.lat !== '' ? Number(row.lat) : extra.lat,
        lng: row.lng != null && row.lng !== '' ? Number(row.lng) : extra.lng,
        radius_km: row.radius_km != null && row.radius_km !== '' ? Number(row.radius_km) : extra.radius_km
    };
}

function publicProfilePayload(row) {
    const merged = mergeProfileRow(row) || {};
    const flags = publicAccountMeta(merged.id);
    const city = extractCityFromProfile(merged);
    const address = extractStreetFromProfile(merged);
    const place = formatProfilePlace(merged);
    return {
        success: true,
        found: true,
        id: merged.id,
        name: merged.name || '',
        address,
        city,
        place,
        avatar_url: merged.avatar_url || '',
        lat: Number(merged.lat) || null,
        lng: Number(merged.lng) || null,
        radius_km: Number(merged.radius_km) || 20,
        mapsEmbed: mapsEmbedUrl(place || city),
        accountType: flags.accountType,
        partner: flags.partner
    };
}

async function attachGeoToUser(user) {
    if (!user) return user;
    if (Number(user.lat) && Number(user.lng)) return user;
    const place = formatProfilePlace(user) || user.city || user.address;
    const geo = await geocodePlace(place);
    if (geo) {
        user.lat = geo.lat;
        user.lng = geo.lng;
        saveProfileExtra(user.id, { lat: geo.lat, lng: geo.lng, address: user.address || '', city: user.city || '', avatar_url: user.avatar_url || '' });
    }
    return user;
}

const persistTimers = {};
function persistJsonFile(fileName, data, immediate) {
    if (!persistTimers[fileName]) persistTimers[fileName] = {};
    const slot = persistTimers[fileName];
    slot.data = data;
    const flush = () => {
        slot.timer = null;
        try {
            const file = dataFile(fileName);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(slot.data, null, 2));
        } catch (err) {
            console.error('Salvataggio ' + fileName + ' fallito:', err.message);
        }
    };
    if (immediate) {
        if (slot.timer) clearTimeout(slot.timer);
        flush();
        return;
    }
    if (slot.timer) return;
    slot.timer = setTimeout(flush, 400);
}

function loadJsonArray(fileName) {
    try {
        const file = dataFile(fileName);
        if (!fs.existsSync(file)) return [];
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('Lettura ' + fileName + ' fallita:', err.message);
        return [];
    }
}

function persistShopsToDisk() {
    persistJsonFile('shops.json', shopSubsDB);
    persistShopsToSupabase().catch(err => console.error('Salvataggio shops Supabase:', err.message));
}
function persistTournamentsToDisk() {
    persistJsonFile('tournaments.json', tournamentsDB);
    persistTournamentsToSupabase().catch(err => console.error('Salvataggio tornei Supabase:', err.message));
}
function persistPromoCodesToDisk() {
    persistJsonFile('promo-codes.json', promoCodesDB);
    persistPromoCodesToSupabase().catch(err => console.error('Salvataggio promo Supabase:', err.message));
}
function persistAccountsToDisk() { persistJsonFile('accounts.json', accountsDB); }
function persistWalletsToDisk() {
    persistJsonFile('wallets.json', usersDB.filter(u => u && u.id).map(walletToRow));
    persistWalletsToSupabase().catch(err => console.error('Salvataggio wallet Supabase:', err.message));
}

function normalizeAccountType(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (v.includes('negozio') || v.includes('azienda') || v === 'shop' || v === 'store') return 'negozio';
    return 'privato';
}

function getAccountType(userId) {
    const row = accountsDB.find(a => String(a.userId) === String(userId));
    return row ? normalizeAccountType(row.accountType) : 'privato';
}

function setAccountType(userId, raw) {
    const accountType = normalizeAccountType(raw);
    let row = accountsDB.find(a => String(a.userId) === String(userId));
    if (!row) {
        row = { userId: String(userId), accountType, updatedAt: new Date().toISOString() };
        accountsDB.push(row);
    } else {
        row.accountType = accountType;
        row.updatedAt = new Date().toISOString();
    }
    persistAccountsToDisk();
    return accountType;
}

function publicAccountMeta(userId) {
    return {
        accountType: getAccountType(userId),
        partner: isShopActive(userId)
    };
}

function isAdminEmail(email) {
    return ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

function normalizePromoCode(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isValidPromoFormat(code) {
    return /^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(code);
}

function findPromoByCode(raw) {
    const code = normalizePromoCode(raw);
    return promoCodesDB.find(p => p.enabled !== false && normalizePromoCode(p.code) === code);
}

function ensureDefaultPromoCodes() {
    const hasTest = promoCodesDB.some(p => normalizePromoCode(p.code) === 'TESTFREE2026');
    if (!hasTest) {
        promoCodesDB.push({
            id: 'promo-testfree2026',
            code: 'TESTFREE2026',
            label: 'Test interno SaaS negozio',
            maxUses: null,
            durationDays: null,
            enabled: true,
            createdBy: 'system',
            createdAt: new Date().toISOString(),
            redemptions: []
        });
        persistPromoCodesToDisk();
    }
}

function getOrCreateShopSub(userId, shopName, email) {
    let sub = shopSubsDB.find(s => String(s.userId) === String(userId));
    const name = String(shopName || '').trim() || 'Negozio TCG';
    if (!sub) {
        sub = {
            userId: String(userId),
            shopName: name,
            email: email || '',
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        shopSubsDB.push(sub);
    } else {
        if (shopName) sub.shopName = name;
        if (email) sub.email = email;
    }
    return sub;
}

function activateShopFromPromo(sub, promo) {
    sub.status = 'active';
    sub.planSource = 'promo';
    sub.promoCode = promo.code;
    sub.pricePaid = 0;
    const days = Number(promo.durationDays);
    if (!days || days <= 0) {
        sub.activeUntil = null;
        sub.unlimited = true;
    } else {
        sub.unlimited = false;
        sub.activeUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }
}

function publicPromo(p) {
    return {
        id: p.id,
        code: p.code,
        label: p.label || '',
        maxUses: p.maxUses == null ? null : Number(p.maxUses),
        durationDays: p.durationDays == null ? null : Number(p.durationDays),
        enabled: p.enabled !== false,
        createdBy: p.createdBy || '',
        createdAt: p.createdAt,
        uses: (p.redemptions || []).length,
        redemptions: (p.redemptions || []).map(r => ({
            userId: r.userId,
            email: r.email || '',
            at: r.at
        }))
    };
}

function isShopActive(userId) {
    const sub = shopSubsDB.find(s => String(s.userId) === String(userId));
    if (!sub || sub.status !== 'active') return false;
    if (sub.unlimited) return true;
    if (sub.activeUntil && new Date(sub.activeUntil).getTime() < Date.now()) return false;
    return true;
}

function publicTournament(t) {
    return {
        id: t.id,
        shopId: t.shopId,
        shopName: t.shopName,
        title: t.title,
        game: t.game,
        date: t.date,
        time: t.time,
        location: t.location,
        maxPlayers: t.maxPlayers,
        fee: t.fee,
        description: t.description,
        status: t.status,
        playersCount: (t.players || []).length
    };
}

loadMessagesFromDisk();
loadOrdersFromDisk();
shopSubsDB = loadJsonArray('shops.json');
tournamentsDB = loadJsonArray('tournaments.json');
promoCodesDB = loadJsonArray('promo-codes.json');
accountsDB = loadJsonArray('accounts.json');
ensureDefaultPromoCodes();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ahpkmppjtespemkzmkol.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFocGttcHBqdGVzcGVta3pta29sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNDM2NDAsImV4cCI6MjEwNzcxOTY0MH0._VeFP1v5vZkGz1-rGVUpHcROWWfs7zzkWEV7i96tkbk';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
try {
    const payload = JSON.parse(Buffer.from(String(SUPABASE_KEY).split('.')[1], 'base64url').toString());
    if (payload.role === 'anon') {
        console.warn('Manca SUPABASE_SERVICE_ROLE_KEY: con RLS stretto il server non potrà marcare gli annunci come venduti.');
    }
} catch (e) {}
const CART_MIN_ORDER = 20;
const WALLET_HOLD_DAYS = 7;
const PLATFORM_FEE_RATE = 0.05;
const SHOP_PLAN_EUR = 15;
const SHOP_PLAN_CENTS = 1500;

function platformChargeCents(listedEuro) {
    const base = Math.round(Number(listedEuro || 0) * 100);
    const wantNet = base + Math.round(base * PLATFORM_FEE_RATE);
    return Math.ceil((wantNet + 25) / 0.985);
}
const MEETUP_MAX_AMOUNT = 150;
const HOLD_RELEASED_AT = '1970-01-01T00:00:00.000Z';
const SINGLE_CARD_TYPE = 'Carta Singola';
const BOX_PRODUCT_TYPE = 'Box / Bustina';
const DECK_PRODUCT_TYPE = 'Mazzo Completo';
const TCGCSV_CAT = { Pokemon: 3, Magic: 1, Yugioh: 2, OnePiece: 68, Lorcana: 71 };
const SEALED_NAME_RE = /booster|elite trainer|\betb\b|\btin\b|bundle|display|blister|collection box|ultra-premium|\bupc\b|premium collection|booster box|booster pack|\bcase\b/i;
const PRECON_NAME_RE = /\bdeck\b|precon|commander|starter|structure|theme deck|battle deck|challenge deck|planeswalker deck|intro pack|challenger deck|starter deck/i;
const SKIP_PRODUCT_RE = /code card|online code|digital code/i;
const LISTING_BLOCK_RE = /\b(iphone|ipad|samsung|xiaomi|huawei|airpods?|nike|adidas|affitto|monolocale|bitcoin|crypto|onlyfans|seguaci|followers|playstation|xbox series|cocaina)\b/i;
const CATALOG_UA = 'TCGVault/1.0 (https://tcg-vault.it; catalog-match)';
const tcgcsvCache = { groups: {}, products: {}, index: {} };
const CATALOG_ALIASES = {
    Pokemon: {
        dracofiamma: 'Charizard',
        pikachu: 'Pikachu',
        mewtwo: 'Mewtwo'
    },
    Yugioh: {
        'mago nero': 'Dark Magician',
        'mago oscuro': 'Dark Magician',
        'drago bianco occhi blu': 'Blue-Eyes White Dragon',
        'drago bianco': 'Blue-Eyes White Dragon',
        exodia: 'Exodia the Forbidden One',
        'fioritura di cenere': 'Ash Blossom & Joyous Spring',
        'cenere gioiosa': 'Ash Blossom & Joyous Spring'
    },
    Magic: {
        fulmine: 'Lightning Bolt',
        'uccello del paradiso': 'Birds of Paradise',
        'contatore di incantesimi': 'Counterspell',
        'anello solare': 'Sol Ring'
    },
    OnePiece: {
        rufy: 'Luffy',
        luffy: 'Luffy',
        zoro: 'Zoro'
    },
    Lorcana: {
        elsa: 'Elsa',
        topolino: 'Mickey Mouse',
        'mickey': 'Mickey Mouse'
    }
};

function orderToRow(o) {
    return {
        id: o.id,
        payment_intent_id: o.paymentIntentId || null,
        buyer_id: o.buyerId || null,
        seller_id: o.sellerId || null,
        card_id: o.cardId != null ? String(o.cardId) : null,
        card_ids: Array.isArray(o.cardIds) ? o.cardIds : [],
        card_title: o.cardTitle || null,
        amount: o.amount != null ? Number(o.amount) : null,
        status: o.status || 'pending_payment',
        escrow_notified: !!o.escrowNotified,
        carrier: o.carrier || null,
        tracking_number: o.trackingNumber || null,
        tracking_link: o.trackingLink || null,
        paid_at: o.paidAt || null,
        completed_at: o.completedAt || null,
        created_at: o.createdAt || new Date().toISOString(),
        delivery_method: o.deliveryMethod || 'shipping',
        hold_until: o.holdUntil || null,
        meetup_code: o.meetupQrToken || o.meetupCode || null,
        meetup_place: o.meetupPlace || null,
        meetup_at: o.meetupAt || null
    };
}

function rowToOrder(r) {
    return {
        id: r.id,
        paymentIntentId: r.payment_intent_id,
        buyerId: r.buyer_id,
        sellerId: r.seller_id,
        cardId: r.card_id,
        cardIds: r.card_ids || [],
        cardTitle: r.card_title,
        amount: Number(r.amount || 0),
        status: r.status,
        escrowNotified: !!r.escrow_notified,
        carrier: r.carrier,
        trackingNumber: r.tracking_number,
        trackingLink: r.tracking_link,
        paidAt: r.paid_at,
        completedAt: r.completed_at,
        createdAt: r.created_at,
        deliveryMethod: r.delivery_method || 'shipping',
        holdUntil: r.hold_until || null,
        meetupCode: r.meetup_code || null,
        meetupQrToken: r.meetup_code || null,
        meetupPlace: r.meetup_place || null,
        meetupAt: r.meetup_at || null
    };
}

async function persistOrdersToSupabase() {
    if (!ordersDB.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/orders', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(ordersDB.map(orderToRow))
    });
    if (!res.ok) {
        console.error('Salvataggio orders Supabase:', res.status, await res.text());
    }
}

async function loadOrdersFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/orders?select=*&order=created_at.desc', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura orders Supabase:', res.status, await res.text());
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            ordersDB = rows.map(rowToOrder);
            try {
                const file = dataFile('orders.json');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(ordersDB, null, 2));
            } catch (err) {}
            console.log('Ordini caricati da Supabase:', ordersDB.length);
            return;
        }
        if (ordersDB.length) {
            await persistOrdersToSupabase();
            console.log('Ordini locali migrati su Supabase:', ordersDB.length);
        }
    } catch (err) {
        console.error('Lettura orders Supabase:', err.message);
    }
}

function messageToRow(m) {
    return {
        id: m.id,
        sender_id: String(m.senderId || ''),
        receiver_id: String(m.receiverId || ''),
        text: m.text || null,
        offer_price: m.offerPrice != null && m.offerPrice !== '' ? Number(m.offerPrice) : null,
        card_id: m.cardId != null ? String(m.cardId) : null,
        sender_name: m.senderName || null,
        is_escrow_alert: !!m.isEscrowAlert,
        order_id: m.orderId || null,
        created_at: m.timestamp || new Date().toISOString()
    };
}

function parseEscrowSenderName(raw) {
    const parts = String(raw || '').split('|');
    if (parts[0] !== 'escrow') return null;
    const dec = (v) => { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } };
    return {
        escrowStep: parts[1] || '',
        sellerId: parts[2] || '',
        buyerId: parts[3] || '',
        deliveryMethod: parts[4] === 'meetup' ? 'meetup' : 'shipping',
        carrier: dec(parts[5]),
        trackingNumber: dec(parts[6]),
        trackingLink: dec(parts[7])
    };
}

function rowToMessage(r) {
    const meta = parseEscrowSenderName(r.sender_name);
    return {
        id: r.id,
        senderId: r.sender_id,
        receiverId: r.receiver_id,
        text: r.text,
        offerPrice: r.offer_price != null ? Number(r.offer_price) : null,
        cardId: r.card_id,
        senderName: r.sender_name,
        isEscrowAlert: !!r.is_escrow_alert,
        orderId: r.order_id,
        timestamp: r.created_at,
        escrowStep: meta && meta.escrowStep,
        sellerId: meta && meta.sellerId,
        buyerId: meta && meta.buyerId,
        deliveryMethod: meta ? meta.deliveryMethod : undefined,
        carrier: meta && meta.carrier,
        trackingNumber: meta && meta.trackingNumber,
        trackingLink: meta && meta.trackingLink
    };
}

async function persistMessagesToSupabase() {
    if (!messagesDB.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/messages', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(messagesDB.map(messageToRow))
    });
    if (!res.ok) {
        console.error('Salvataggio messages Supabase:', res.status, await res.text());
    }
}

async function loadMessagesFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/messages?select=*&order=created_at.asc', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura messages Supabase:', res.status, await res.text());
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            messagesDB = rows.map(rowToMessage);
            persistJsonFile('messages.json', messagesDB, true);
            console.log('Messaggi caricati da Supabase:', messagesDB.length);
            return;
        }
        if (messagesDB.length) {
            await persistMessagesToSupabase();
            console.log('Messaggi locali migrati su Supabase:', messagesDB.length);
        }
    } catch (err) {
        console.error('Lettura messages Supabase:', err.message);
    }
}

function shopToRow(s) {
    return {
        user_id: String(s.userId || ''),
        shop_name: s.shopName || null,
        email: s.email || null,
        status: s.status || 'pending',
        plan_source: s.planSource || null,
        promo_code: s.promoCode || null,
        price_paid: s.pricePaid != null && s.pricePaid !== '' ? Number(s.pricePaid) : null,
        unlimited: !!s.unlimited,
        active_until: s.activeUntil || null,
        pending_payment_intent_id: s.pendingPaymentIntentId || null,
        created_at: s.createdAt || new Date().toISOString()
    };
}

function rowToShop(r) {
    return {
        userId: r.user_id,
        shopName: r.shop_name,
        email: r.email,
        status: r.status,
        planSource: r.plan_source,
        promoCode: r.promo_code,
        pricePaid: r.price_paid != null ? Number(r.price_paid) : undefined,
        unlimited: !!r.unlimited,
        activeUntil: r.active_until,
        pendingPaymentIntentId: r.pending_payment_intent_id,
        createdAt: r.created_at
    };
}

function tournamentToRow(t) {
    return {
        id: t.id,
        shop_id: String(t.shopId || ''),
        shop_name: t.shopName || null,
        title: t.title || '',
        game: t.game || null,
        date: t.date || null,
        time: t.time || null,
        location: t.location || null,
        max_players: t.maxPlayers != null ? Number(t.maxPlayers) : null,
        fee: t.fee != null && t.fee !== '' ? Number(t.fee) : null,
        description: t.description || null,
        status: t.status || 'open',
        players: {
            enrolled: Array.isArray(t.players) ? t.players : [],
            rounds: Array.isArray(t.rounds) ? t.rounds : []
        },
        created_at: t.createdAt || new Date().toISOString()
    };
}

function rowToTournament(r) {
    return {
        id: r.id,
        shopId: r.shop_id,
        shopName: r.shop_name,
        title: r.title,
        game: r.game,
        date: r.date,
        time: r.time,
        location: r.location,
        maxPlayers: r.max_players != null ? Number(r.max_players) : 32,
        fee: Number(r.fee || 0),
        description: r.description || '',
        status: r.status,
        players: Array.isArray(r.players)
            ? r.players
            : ((r.players && r.players.enrolled) || []),
        rounds: Array.isArray(r.players)
            ? []
            : ((r.players && r.players.rounds) || []),
        createdAt: r.created_at
    };
}

async function persistShopsToSupabase() {
    if (!shopSubsDB.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/shops', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(shopSubsDB.map(shopToRow))
    });
    if (!res.ok) {
        console.error('Salvataggio shops Supabase:', res.status, await res.text());
    }
}

async function persistTournamentsToSupabase() {
    if (!tournamentsDB.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/tournaments', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(tournamentsDB.map(tournamentToRow))
    });
    if (!res.ok) {
        console.error('Salvataggio tournaments Supabase:', res.status, await res.text());
    }
}

async function loadShopsFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/shops?select=*', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura shops Supabase:', res.status, await res.text());
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            shopSubsDB = rows.map(rowToShop);
            persistJsonFile('shops.json', shopSubsDB, true);
            console.log('Negozi caricati da Supabase:', shopSubsDB.length);
            return;
        }
        if (shopSubsDB.length) {
            await persistShopsToSupabase();
            console.log('Negozi locali migrati su Supabase:', shopSubsDB.length);
        }
    } catch (err) {
        console.error('Lettura shops Supabase:', err.message);
    }
}

async function loadTournamentsFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/tournaments?select=*&order=created_at.asc', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura tournaments Supabase:', res.status, await res.text());
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            tournamentsDB = rows.map(rowToTournament);
            persistJsonFile('tournaments.json', tournamentsDB, true);
            console.log('Tornei caricati da Supabase:', tournamentsDB.length);
            return;
        }
        if (tournamentsDB.length) {
            await persistTournamentsToSupabase();
            console.log('Tornei locali migrati su Supabase:', tournamentsDB.length);
        }
    } catch (err) {
        console.error('Lettura tournaments Supabase:', err.message);
    }
}

function promoToRow(p) {
    return {
        id: p.id,
        code: String(p.code || '').toUpperCase(),
        label: p.label || null,
        max_uses: p.maxUses != null && p.maxUses !== '' ? Number(p.maxUses) : null,
        duration_days: p.durationDays != null && p.durationDays !== '' ? Number(p.durationDays) : null,
        enabled: p.enabled !== false,
        created_by: p.createdBy || null,
        valid_until: p.validUntil || null,
        redemptions: Array.isArray(p.redemptions) ? p.redemptions : [],
        created_at: p.createdAt || new Date().toISOString()
    };
}

function rowToPromo(r) {
    return {
        id: r.id,
        code: r.code,
        label: r.label || '',
        maxUses: r.max_uses != null ? Number(r.max_uses) : null,
        durationDays: r.duration_days != null ? Number(r.duration_days) : null,
        enabled: r.enabled !== false,
        createdBy: r.created_by || '',
        validUntil: r.valid_until || null,
        redemptions: Array.isArray(r.redemptions) ? r.redemptions : [],
        createdAt: r.created_at
    };
}

async function persistPromoCodesToSupabase() {
    if (!promoCodesDB.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/promo_codes', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(promoCodesDB.map(promoToRow))
    });
    if (!res.ok) {
        console.error('Salvataggio promo_codes Supabase:', res.status, await res.text());
    }
}

async function loadPromoCodesFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/promo_codes?select=*&order=created_at.asc', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura promo_codes Supabase:', res.status, await res.text());
            ensureDefaultPromoCodes();
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            promoCodesDB = rows.map(rowToPromo);
            persistJsonFile('promo-codes.json', promoCodesDB, true);
            console.log('Promo caricate da Supabase:', promoCodesDB.length);
            ensureDefaultPromoCodes();
            return;
        }
        if (promoCodesDB.length) {
            await persistPromoCodesToSupabase();
            console.log('Promo locali migrate su Supabase:', promoCodesDB.length);
        }
        ensureDefaultPromoCodes();
    } catch (err) {
        console.error('Lettura promo_codes Supabase:', err.message);
        ensureDefaultPromoCodes();
    }
}

function syncWalletTotals(user) {
    if (!user) return;
    user.heldWallet = Math.max(0, Number(user.heldWallet || 0));
    user.availableWallet = Math.max(0, Number(user.availableWallet || 0));
    user.wallet = user.heldWallet + user.availableWallet;
}

function getOrCreateWalletUser(userId) {
    let user = usersDB.find(u => String(u.id) === String(userId));
    if (!user) {
        user = { id: String(userId), wallet: 0, availableWallet: 0, heldWallet: 0, iban: '' };
        usersDB.push(user);
    }
    if (user.availableWallet == null && user.heldWallet == null) {
        user.availableWallet = Number(user.wallet || 0);
        user.heldWallet = 0;
    }
    syncWalletTotals(user);
    return user;
}

function walletToRow(u) {
    syncWalletTotals(u);
    return {
        user_id: String(u.id || u.userId || ''),
        balance: Number(u.wallet || 0),
        held_balance: Number(u.heldWallet || 0),
        available_balance: Number(u.availableWallet || 0),
        iban: u.iban || null,
        stripe_account_id: u.stripeAccountId || null,
        last_payout_id: u.lastPayoutId || null,
        last_payout_at: u.lastPayoutAt || null,
        updated_at: u.walletUpdatedAt || new Date().toISOString()
    };
}

function applyWalletRow(r) {
    if (!r || !r.user_id) return;
    const user = getOrCreateWalletUser(r.user_id);
    const held = Number(r.held_balance || 0);
    const available = Number(r.available_balance || 0);
    const legacy = Number(r.balance || 0);
    if (held === 0 && available === 0 && legacy !== 0) {
        user.availableWallet = legacy;
        user.heldWallet = 0;
    } else {
        user.heldWallet = held;
        user.availableWallet = available;
    }
    user.iban = r.iban || '';
    user.stripeAccountId = r.stripe_account_id || user.stripeAccountId || null;
    user.lastPayoutId = r.last_payout_id || null;
    user.lastPayoutAt = r.last_payout_at || null;
    user.walletUpdatedAt = r.updated_at || null;
    syncWalletTotals(user);
}

function isHoldPending(holdUntil) {
    if (!holdUntil) return false;
    const t = new Date(holdUntil).getTime();
    return Number.isFinite(t) && t >= Date.parse('2000-01-01');
}

function releaseMatureHolds() {
    let changed = false;
    const now = Date.now();
    ordersDB.forEach(order => {
        if (order.status !== 'completed' || !isHoldPending(order.holdUntil)) return;
        if (new Date(order.holdUntil).getTime() > now) return;
        const amount = Number(order.amount || 0);
        const seller = getOrCreateWalletUser(order.sellerId);
        seller.heldWallet = Math.max(0, Number(seller.heldWallet || 0) - amount);
        seller.availableWallet = Number(seller.availableWallet || 0) + amount;
        seller.walletUpdatedAt = new Date().toISOString();
        syncWalletTotals(seller);
        order.holdUntil = HOLD_RELEASED_AT;
        changed = true;
    });
    if (changed) {
        persistOrdersToDisk();
        persistWalletsToDisk();
    }
    return changed;
}

function pendingIbanInfo(user) {
    const id = String((user && user.lastPayoutId) || '');
    if (!id.startsWith('pending_iban|')) return null;
    const rest = id.slice('pending_iban|'.length);
    const pipe = rest.indexOf('|');
    const amount = Number(pipe === -1 ? rest : rest.slice(0, pipe));
    const holder = pipe === -1 ? '' : decodeURIComponent(rest.slice(pipe + 1));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { amount, holder };
}

function setPendingIbanPayout(user, amount, holder) {
    user.lastPayoutId = 'pending_iban|' + Number(amount).toFixed(2) + '|' + encodeURIComponent(String(holder || '').slice(0, 80));
}

function normalizeIban(value) {
    return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function isPlausibleIban(value) {
    return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(normalizeIban(value));
}

function syncHeldFromCompletedOrders(userId) {
    const user = getOrCreateWalletUser(userId);
    let held = 0;
    ordersDB.forEach(o => {
        if (String(o.sellerId) !== String(userId) || o.status !== 'completed') return;
        const amt = Number(o.amount || 0);
        const t = Date.parse(o.holdUntil);
        if (Number.isFinite(t) && t > Date.now()) held += amt;
    });
    if (held > Number(user.heldWallet || 0)) {
        user.heldWallet = held;
        syncWalletTotals(user);
        persistWalletsToDisk();
    }
    return user;
}

function walletPublic(userId) {
    releaseMatureHolds();
    syncHeldFromCompletedOrders(userId);
    const user = getOrCreateWalletUser(userId);
    const pending = pendingIbanInfo(user);
    return {
        wallet: Number(user.availableWallet || 0),
        availableWallet: Number(user.availableWallet || 0),
        heldWallet: Number(user.heldWallet || 0),
        iban: user.iban || '',
        stripeAccountId: user.stripeAccountId || null,
        payoutPending: !!pending,
        payoutPendingAmount: pending ? pending.amount : 0
    };
}

function publicSiteUrl(req) {
    const envUrl = String(process.env.PUBLIC_SITE_URL || 'https://tcg-vault.it').replace(/\/$/, '');
    const origin = String(req.headers.origin || '').replace(/\/$/, '');
    if (origin && /^https?:\/\//i.test(origin)) return origin;
    return envUrl;
}

async function persistWalletsToSupabase() {
    const rows = usersDB.filter(u => u && u.id).map(walletToRow);
    if (!rows.length) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/wallets', {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(rows)
    });
    if (!res.ok) {
        console.error('Salvataggio wallets Supabase:', res.status, await res.text());
    }
}

async function loadWalletsFromSupabase() {
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/wallets?select=*', {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + SUPABASE_KEY
            }
        });
        if (!res.ok) {
            console.error('Lettura wallets Supabase:', res.status, await res.text());
            return;
        }
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
            rows.forEach(applyWalletRow);
            persistJsonFile('wallets.json', rows, true);
            console.log('Wallet caricati da Supabase:', rows.length);
            return;
        }
        if (usersDB.some(u => Number(u.wallet || 0) !== 0 || u.iban)) {
            await persistWalletsToSupabase();
            console.log('Wallet locali migrati su Supabase');
        }
    } catch (err) {
        console.error('Lettura wallets Supabase:', err.message);
    }
}
const authUserCache = new Map();
const rateBuckets = {};

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const bucket = rateBuckets[key];
    if (!bucket || bucket.reset < now) {
        rateBuckets[key] = { n: 1, reset: now + windowMs };
        return true;
    }
    bucket.n += 1;
    return bucket.n <= max;
}

async function getAuthUser(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const cached = authUserCache.get(token);
    if (cached && cached.exp > Date.now()) return cached.user;
    try {
        const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: 'Bearer ' + token
            }
        });
        if (!res.ok) return null;
        const row = await res.json();
        if (!row || !row.id) return null;
        let payload = {};
        try {
            payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
        } catch (e) {}
        const amr = Array.isArray(payload.amr) ? payload.amr : [];
        const strong = payload.aal === 'aal2' || amr.some(x => /totp|otp|mfa|webauthn|wna|passkey/i.test(String((x && x.method) || x || '')));
        const user = {
            id: String(row.id),
            email: String(row.email || '').toLowerCase(),
            aal: payload.aal || 'aal1',
            strongAuth: !!strong,
            emailConfirmed: !!(row.email_confirmed_at || row.confirmed_at),
            phoneConfirmed: !!row.phone_confirmed_at,
            createdAt: row.created_at || null,
            accessToken: token
        };
        authUserCache.set(token, { user, exp: Date.now() + 15000 });
        if (authUserCache.size > 500) {
            const first = authUserCache.keys().next().value;
            authUserCache.delete(first);
        }
        return user;
    } catch (err) {
        return null;
    }
}

async function requireAuth(req, res) {
    const user = await getAuthUser(req);
    if (!user) {
        res.status(401).json({ success: false, error: 'Accesso richiesto.' });
        return null;
    }
    req.auth = user;
    return user;
}

function assertSelf(req, res, userId) {
    if (!req.auth || String(req.auth.id) !== String(userId)) {
        res.status(403).json({ success: false, error: 'Operazione non autorizzata.' });
        return false;
    }
    return true;
}

async function requireAdmin(req, res) {
    const user = await requireAuth(req, res);
    if (!user) return null;
    if (!isAdminEmail(user.email)) {
        res.status(403).json({ success: false, error: 'Solo Admin Supremo.' });
        return null;
    }
    return user;
}

function listingOffTopic(text) {
    return LISTING_BLOCK_RE.test(String(text || ''));
}

function catalogQuerySafe(q) {
    return String(q || '').trim().replace(/[:"*?~\\()]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
}

function catalogSearchTerms(query, category) {
    const raw = catalogQuerySafe(query);
    const terms = [];
    if (raw) terms.push(raw);
    const alias = (CATALOG_ALIASES[category] || {})[raw.toLowerCase()];
    if (alias && alias.toLowerCase() !== raw.toLowerCase()) terms.push(alias);
    return terms;
}

function mapCatalogHit(source, id, name, setName, number) {
    return {
        source,
        id: String(id),
        name: String(name || '').trim(),
        set: String(setName || '').trim(),
        number: String(number || '').trim()
    };
}

async function catalogFetchJson(url) {
    const headers = { 'User-Agent': CATALOG_UA, Accept: 'application/json' };
    if (process.env.POKEMONTCG_API_KEY && /pokemontcg\.io/.test(url)) {
        headers['X-Api-Key'] = process.env.POKEMONTCG_API_KEY;
    }
    if (/ygoprodeck\.com/.test(url)) {
        headers.Referer = 'https://db.ygoprodeck.com/';
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        try {
            const res = await fetch(url, { signal: ctrl.signal, headers });
            if (res.ok) return await res.json();
            if (res.status === 400 || res.status === 404) {
                try { return await res.json(); } catch (err) { return null; }
            }
            console.error('Catalog HTTP', res.status, url.slice(0, 140));
            if (res.status < 500 || attempt) return null;
        } catch (err) {
            console.error('Catalog fetch', err.message, url.slice(0, 140));
            if (attempt) return null;
        } finally {
            clearTimeout(t);
        }
    }
    return null;
}

function listingNeedsCatalog(type) {
    return type === SINGLE_CARD_TYPE || type === BOX_PRODUCT_TYPE || type === DECK_PRODUCT_TYPE;
}

async function tcgcsvGroups(catId) {
    const cached = tcgcsvCache.groups[catId];
    if (cached && cached.exp > Date.now()) return cached.rows;
    const json = await catalogFetchJson('https://tcgcsv.com/tcgplayer/' + catId + '/groups');
    const rows = (json && json.results) || [];
    if (rows.length) tcgcsvCache.groups[catId] = { exp: Date.now() + 12 * 60 * 60 * 1000, rows };
    return rows;
}

async function tcgcsvProducts(catId, groupId) {
    const key = catId + ':' + groupId;
    const cached = tcgcsvCache.products[key];
    if (cached && cached.exp > Date.now()) return cached.rows;
    const json = await catalogFetchJson('https://tcgcsv.com/tcgplayer/' + catId + '/' + groupId + '/products');
    const rows = (json && json.results) || [];
    if (rows.length) tcgcsvCache.products[key] = { exp: Date.now() + 6 * 60 * 60 * 1000, rows };
    return rows;
}

function productKindOk(name, type) {
    if (SKIP_PRODUCT_RE.test(name)) return false;
    if (type === BOX_PRODUCT_TYPE) return SEALED_NAME_RE.test(name);
    if (type === DECK_PRODUCT_TYPE) return PRECON_NAME_RE.test(name);
    return false;
}

async function searchTcgcsvProducts(category, query, type) {
    const catId = TCGCSV_CAT[category];
    const q = String(query || '').trim().toLowerCase();
    if (!catId || q.length < 3) return [];
    const words = q.split(/\s+/).filter(w => w.length > 1);
    const groups = await tcgcsvGroups(catId);
    const matchedGroups = groups.filter(g => {
        const n = String(g.name || '').toLowerCase();
        return words.some(w => n.includes(w));
    }).slice(0, 4);
    if (!matchedGroups.length) return [];
    const lists = await Promise.all(matchedGroups.map(g => tcgcsvProducts(catId, g.groupId)));
    const hits = [];
    lists.forEach((products, i) => {
        const group = matchedGroups[i];
        products.forEach(p => {
            const name = String(p.name || '');
            const lower = name.toLowerCase();
            if (!productKindOk(name, type)) return;
            if (!words.every(w => lower.includes(w) || String(group.name || '').toLowerCase().includes(w))) return;
            hits.push(mapCatalogHit(
                'tcgcsv',
                group.groupId + ':' + p.productId,
                name,
                group.name,
                String(p.productId)
            ));
        });
    });
    return hits.slice(0, 20);
}

async function searchTcgcsvByName(category, query, type) {
    const catId = TCGCSV_CAT[category];
    const raw = catalogQuerySafe(query).toLowerCase();
    if (!catId || raw.length < 2) return [];
    const words = raw.split(/\s+/).filter(w => w.length > 1);
    if (!words.length) return [];
    const groups = await tcgcsvGroups(catId);
    const indexed = tcgcsvCache.index[catId];
    const sourceRows = indexed && indexed.exp > Date.now() ? indexed.rows : null;
    const hits = [];
    const consider = (name, groupId, productId, groupName) => {
        if (hits.length >= 20) return;
        const lower = String(name || '').toLowerCase();
        if (SKIP_PRODUCT_RE.test(name)) return;
        if (type === SINGLE_CARD_TYPE) {
            if (SEALED_NAME_RE.test(name) || PRECON_NAME_RE.test(name)) return;
        } else if (!productKindOk(name, type)) return;
        if (!words.every(w => lower.includes(w))) return;
        hits.push(mapCatalogHit('tcgcsv', groupId + ':' + productId, name, groupName, String(productId)));
    };
    if (sourceRows) {
        sourceRows.forEach(row => consider(row.name, row.groupId, row.productId, row.groupName));
        return hits.slice(0, 20);
    }
    const built = [];
    for (let i = 0; i < groups.length && hits.length < 20; i += 12) {
        const batch = groups.slice(i, i + 12);
        const lists = await Promise.all(batch.map(g => tcgcsvProducts(catId, g.groupId)));
        lists.forEach((products, idx) => {
            const group = batch[idx];
            products.forEach(p => {
                built.push({ groupId: group.groupId, productId: p.productId, name: p.name, groupName: group.name });
                consider(p.name, group.groupId, p.productId, group.name);
            });
        });
    }
    if (built.length && hits.length < 20) {
        tcgcsvCache.index[catId] = { exp: Date.now() + 6 * 60 * 60 * 1000, rows: built };
    }
    return hits.slice(0, 20);
}

async function verifyTcgcsvProduct(category, id) {
    const catId = TCGCSV_CAT[category];
    const parts = String(id || '').split(':');
    if (!catId || parts.length !== 2) return null;
    const groupId = parts[0];
    const productId = parts[1];
    const products = await tcgcsvProducts(catId, groupId);
    const p = products.find(row => String(row.productId) === String(productId));
    if (!p) return null;
    const groups = await tcgcsvGroups(catId);
    const group = groups.find(g => String(g.groupId) === String(groupId));
    return mapCatalogHit('tcgcsv', groupId + ':' + productId, p.name, group && group.name, productId);
}

async function searchPokemonCards(q) {
    const terms = catalogSearchTerms(q, 'Pokemon');
    const clauses = [];
    terms.forEach(term => {
        if (/\s/.test(term)) {
            clauses.push('name:"' + term + '"');
        } else {
            clauses.push('name:' + term);
            clauses.push('name:' + term + '*');
        }
    });
    for (const clause of clauses) {
        const json = await catalogFetchJson('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent(clause) + '&pageSize=20');
        const rows = (json && json.data) || [];
        if (rows.length) {
            return rows.map(c => mapCatalogHit('pokemon', c.id, c.name, c.set && c.set.name, c.number));
        }
    }
    return [];
}

async function searchPokemonSealed(q, type) {
    const term = catalogSearchTerms(q, 'Pokemon')[0] || '';
    const first = term.split(/\s+/)[0] || term;
    const json = await catalogFetchJson('https://api.pokemontcg.io/v2/sets?q=' + encodeURIComponent('name:' + first + '*') + '&pageSize=10');
    const sets = (json && json.data) || [];
    const kinds = type === DECK_PRODUCT_TYPE
        ? [['theme', 'Theme Deck / Starter']]
        : [['pack', 'Booster Pack'], ['box', 'Booster Box'], ['etb', 'Elite Trainer Box']];
    const hits = [];
    const needle = term.toLowerCase();
    sets.filter(s => String(s.name || '').toLowerCase().includes(needle) || needle.includes(String(s.name || '').toLowerCase()) || String(s.name || '').toLowerCase().split(/\s+/).some(w => needle.includes(w.toLowerCase()) && w.length > 3)).forEach(s => {
        kinds.forEach(([id, label]) => {
            hits.push(mapCatalogHit('pokeset', s.id + ':' + id, s.name + ' — ' + label, s.name, s.ptcgoCode || ''));
        });
    });
    if (hits.length) return hits;
    return sets.slice(0, 6).flatMap(s => kinds.map(([id, label]) => mapCatalogHit('pokeset', s.id + ':' + id, s.name + ' — ' + label, s.name, s.ptcgoCode || '')));
}

async function verifyPokeSet(id) {
    const parts = String(id || '').split(':');
    if (parts.length !== 2) return null;
    const json = await catalogFetchJson('https://api.pokemontcg.io/v2/sets/' + encodeURIComponent(parts[0]));
    const s = json && json.data;
    if (!s) return null;
    const labels = { pack: 'Booster Pack', box: 'Booster Box', etb: 'Elite Trainer Box', theme: 'Theme Deck / Starter' };
    const label = labels[parts[1]];
    if (!label) return null;
    return mapCatalogHit('pokeset', s.id + ':' + parts[1], s.name + ' — ' + label, s.name, s.ptcgoCode || '');
}

function ygoHit(c) {
    const set = (c.card_sets && c.card_sets[0] && c.card_sets[0].set_name) || c.type || 'Yu-Gi-Oh!';
    const number = (c.card_sets && c.card_sets[0] && c.card_sets[0].set_code) || c.id;
    return mapCatalogHit('ygoprodeck', c.id, c.name, set, number);
}

function queryLooksItalian(q) {
    return /[àèéìòù]/i.test(q) || /\b(mago|drago|occhi|bianco|nero|cenere|angelo|demone|eroe)\b/i.test(q);
}

async function searchYugiohCards(query) {
    const terms = catalogSearchTerms(query, 'Yugioh');
    const italian = queryLooksItalian(query);
    const urls = [];
    terms.forEach(term => {
        const enc = encodeURIComponent(term);
        const en = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=' + enc + '&num=20&offset=0';
        const exact = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?name=' + enc;
        const it = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=' + enc + '&language=it&num=20&offset=0';
        if (italian) urls.push(it, en, exact);
        else urls.push(en, exact, it);
    });
    for (const url of urls) {
        const json = await catalogFetchJson(url);
        const rows = (json && json.data) || [];
        if (rows.length) return rows.map(ygoHit);
    }
    return [];
}

async function searchMagicCards(query) {
    const terms = catalogSearchTerms(query, 'Magic');
    const queries = [];
    terms.forEach(term => {
        queries.push('name:"' + term + '"');
        queries.push(term);
        queries.push('printed:"' + term + '"');
    });
    for (const q of queries) {
        const json = await catalogFetchJson('https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q) + '&unique=prints');
        const rows = (json && json.object !== 'error' && json.data) || [];
        if (rows.length) {
            return rows.slice(0, 20).map(c => mapCatalogHit(
                'scryfall',
                c.id,
                c.name,
                c.set_name || c.set,
                c.collector_number
            ));
        }
    }
    return [];
}

function lorcastHit(c) {
    if (!c || !c.id || !c.name || c.object === 'error') return null;
    const name = c.version ? (c.name + ' — ' + c.version) : c.name;
    return mapCatalogHit('lorcast', c.id, name, c.set && c.set.name, c.collector_number);
}

async function searchLorcanaCards(query) {
    const terms = catalogSearchTerms(query, 'Lorcana');
    for (const term of terms) {
        const json = await catalogFetchJson('https://api.lorcast.com/v0/cards/search?q=' + encodeURIComponent(term) + '&unique=prints');
        const rows = (json && (json.data || json.results)) || [];
        const hits = rows.map(lorcastHit).filter(Boolean);
        if (hits.length) return hits.slice(0, 20);
    }
    return searchTcgcsvByName('Lorcana', query, SINGLE_CARD_TYPE);
}

async function searchOfficialCatalog(category, query, type) {
    const listingType = String(type || SINGLE_CARD_TYPE);
    const q = catalogSearchTerms(query, category)[0] || '';
    if (listingType === BOX_PRODUCT_TYPE || listingType === DECK_PRODUCT_TYPE) {
        let hits = [];
        if (category === 'Pokemon') hits = await searchPokemonSealed(q, listingType);
        let extra = await searchTcgcsvProducts(category, q, listingType);
        if (!extra.length) extra = await searchTcgcsvByName(category, q, listingType);
        const seen = {};
        return hits.concat(extra).filter(h => {
            const k = h.source + ':' + h.id;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        }).slice(0, 20);
    }
    if (q.length < 2) return [];
    if (category === 'Pokemon') return searchPokemonCards(query);
    if (category === 'Magic') return searchMagicCards(query);
    if (category === 'Yugioh') return searchYugiohCards(query);
    if (category === 'Lorcana') return searchLorcanaCards(query);
    if (category === 'OnePiece') return searchTcgcsvByName('OnePiece', query, SINGLE_CARD_TYPE);
    return [];
}

async function verifyOfficialCard(category, source, id) {
    const cardId = String(id || '').trim();
    if (!cardId) return null;
    if (source === 'tcgcsv') return verifyTcgcsvProduct(category, cardId);
    if (category === 'Pokemon' && source === 'pokemon') {
        const json = await catalogFetchJson('https://api.pokemontcg.io/v2/cards/' + encodeURIComponent(cardId));
        const c = json && json.data;
        if (!c) return null;
        return mapCatalogHit('pokemon', c.id, c.name, c.set && c.set.name, c.number);
    }
    if (category === 'Magic' && source === 'scryfall') {
        const c = await catalogFetchJson('https://api.scryfall.com/cards/' + encodeURIComponent(cardId));
        if (!c || c.object === 'error') return null;
        return mapCatalogHit('scryfall', c.id, c.name, c.set_name, c.collector_number);
    }
    if (category === 'Yugioh' && source === 'ygoprodeck') {
        const konamiId = cardId.split(':')[0];
        const json = await catalogFetchJson('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(konamiId));
        const c = json && json.data && json.data[0];
        if (!c) return null;
        return ygoHit(c);
    }
    if (category === 'Lorcana' && (source === 'lorcast' || source === 'lorcana')) {
        const c = await catalogFetchJson('https://api.lorcast.com/v0/cards/' + encodeURIComponent(cardId));
        return lorcastHit(c);
    }
    return null;
}

function supabaseAuthBundles(userJwt) {
    const bundles = [];
    let role = '';
    try {
        role = JSON.parse(Buffer.from(String(SUPABASE_KEY).split('.')[1], 'base64url').toString()).role || '';
    } catch (e) {}
    if (role === 'service_role') {
        bundles.push({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY });
    }
    if (userJwt) {
        bundles.push({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + userJwt });
    }
    if (!bundles.length) {
        bundles.push({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY });
    }
    return bundles;
}

async function insertListingRow(row, userJwt) {
    const payload = { ...row };
    Object.keys(payload).forEach(k => {
        if (payload[k] == null || payload[k] === '') delete payload[k];
    });
    const bundles = supabaseAuthBundles(userJwt);
    for (let round = 0; round < 10; round++) {
        let lastErr = '';
        let lastStatus = 0;
        let retry = false;
        for (const auth of bundles) {
            const res = await fetch(SUPABASE_URL + '/rest/v1/cards', {
                method: 'POST',
                headers: {
                    ...auth,
                    'Content-Type': 'application/json',
                    Prefer: 'return=representation'
                },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                const data = await res.json();
                return { row: Array.isArray(data) ? data[0] : data };
            }
            lastStatus = res.status;
            lastErr = await res.text();
            console.error('Listing insert', res.status, lastErr.slice(0, 280));
            const missing = lastErr.match(/Could not find the '([^']+)' column/i);
            if (missing && Object.prototype.hasOwnProperty.call(payload, missing[1])) {
                delete payload[missing[1]];
                retry = true;
                break;
            }
            if (/null value in column "?id"?/i.test(lastErr) && !payload.id) {
                payload.id = crypto.randomUUID();
                retry = true;
                break;
            }
            if (/invalid input syntax for type integer/i.test(lastErr) && payload.id) {
                delete payload.id;
                retry = true;
                break;
            }
        }
        if (retry) continue;
        if (lastStatus === 401 || lastStatus === 403) {
            return { error: 'Permesso database: su Supabase serve policy INSERT su public.cards (auth.uid() = user_id) oppure SUPABASE_SERVICE_ROLE_KEY su Render.' };
        }
        return { error: lastErr || 'Salvataggio annuncio fallito.' };
    }
    return { error: 'Salvataggio annuncio fallito.' };
}

function normalizeCardIds(raw) {
    if (raw == null || raw === '') return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return [...new Set(list
        .flatMap(v => String(v).split(','))
        .map(v => String(v).trim())
        .filter(v => v && v !== 'undefined' && v !== 'null'))].slice(0, 40);
}

async function getCardsByIds(ids) {
    const unique = normalizeCardIds(ids);
    if (!unique.length) return [];
    const keys = [...new Set([SUPABASE_KEY, SUPABASE_ANON_KEY].filter(Boolean))];
    const orFilter = unique.map(id => /^\d+$/.test(id) ? ('id.eq.' + id) : ('id.eq."' + id.replace(/"/g, '') + '"')).join(',');
    const queries = [
        'or=(' + orFilter + ')',
        unique.every(id => /^\d+$/.test(id)) ? ('id=in.(' + unique.join(',') + ')') : null,
        'id=in.(' + unique.map(id => '"' + id.replace(/"/g, '') + '"').join(',') + ')'
    ].filter(Boolean);

    for (const key of keys) {
        for (const query of queries) {
            try {
                const res = await fetch(SUPABASE_URL + '/rest/v1/cards?' + query + '&select=id,price,user_id,title,is_sold,description', {
                    headers: {
                        apikey: key,
                        Authorization: 'Bearer ' + key,
                        Accept: 'application/json'
                    }
                });
                const data = await res.json().catch(() => []);
                if (!res.ok) {
                    console.error('Lettura cards per pagamento:', res.status, query, data);
                    continue;
                }
                if (Array.isArray(data) && data.length) return data;
            } catch (err) {
                console.error('Lettura cards per pagamento:', err.message);
            }
        }
    }
    return [];
}

function upsertUserInMemory(profile) {
    const id = String(profile.id);
    let user = usersDB.find(u => String(u.id) === id || (profile.email && u.email && u.email.toLowerCase() === String(profile.email).toLowerCase()));
    if (!user) {
        user = {
            id,
            email: profile.email || '',
            name: profile.name || 'Utente TCG',
            address: profile.address || '',
            city: String(profile.city || '').trim(),
            avatar_url: String(profile.avatar_url || extraFor(id).avatar_url || '').trim(),
            lat: profile.lat != null ? Number(profile.lat) : extraFor(id).lat,
            lng: profile.lng != null ? Number(profile.lng) : extraFor(id).lng,
            radius_km: profile.radius_km != null ? Number(profile.radius_km) : extraFor(id).radius_km,
            wallet: 0.00,
            iban: ''
        };
        usersDB.push(user);
    } else {
        user.id = id;
        if (profile.name) user.name = profile.name;
        if (profile.address !== undefined) user.address = profile.address;
        if (profile.email) user.email = profile.email;
        if (profile.accountType) user.accountType = normalizeAccountType(profile.accountType);
        if (profile.city !== undefined) user.city = String(profile.city || '').trim();
        if (profile.avatar_url !== undefined) user.avatar_url = String(profile.avatar_url || '').trim();
        if (profile.lat != null) user.lat = Number(profile.lat);
        if (profile.lng != null) user.lng = Number(profile.lng);
        if (profile.radius_km != null) user.radius_km = Number(profile.radius_km);
    }
    return user;
}

async function saveProfileToSupabase(profile) {
    const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
    };
    const payload = {
        id: String(profile.id),
        name: String(profile.name || ''),
        email: String(profile.email || ''),
        address: String(profile.address || ''),
        city: String(profile.city || '').trim(),
        avatar_url: String(profile.avatar_url || '').trim(),
        lat: profile.lat != null && profile.lat !== '' ? Number(profile.lat) : undefined,
        lng: profile.lng != null && profile.lng !== '' ? Number(profile.lng) : undefined,
        radius_km: profile.radius_km != null && profile.radius_km !== '' ? Number(profile.radius_km) : undefined
    };
    Object.keys(payload).forEach(k => {
        if (payload[k] === undefined || payload[k] === '') delete payload[k];
    });
    payload.id = String(profile.id);
    for (let round = 0; round < 8; round++) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            const data = await res.json().catch(() => null);
            return { error: null, data };
        }
        const errText = await res.text();
        const missing = errText.match(/Could not find the '([^']+)' column/i);
        if (missing && Object.prototype.hasOwnProperty.call(payload, missing[1])) {
            if (missing[1] === 'city' && profile.city) {
                payload.address = String(profile.address || '') + (profile.address ? ', ' : '') + profile.city;
            }
            delete payload[missing[1]];
            continue;
        }
        console.error('Errore salvataggio profiles su Supabase:', errText);
        return { error: errText, data: null };
    }
    return { error: 'Salvataggio profilo fallito', data: null };
}

async function getProfileFromSupabase(userId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(String(userId))}&select=*`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
        }
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        console.error('Errore lettura profiles su Supabase:', data);
        return null;
    }
    return Array.isArray(data) ? data[0] : data;
}

function generateTrackingLink(carrier, trackingNumber) {
    if (!trackingNumber) return null;
    const cleanNumber = trackingNumber.trim();
    switch (carrier.toLowerCase()) {
        case 'poste':
        case 'sda':
        case 'poste italiane':
            return `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${cleanNumber}`;
        case 'inpost':
            return `https://inpost.it/trova-pacco?number=${cleanNumber}`;
        case 'brt':
            return `https://www.brt.it/it/tracking?shipmentId=${cleanNumber}`;
        case 'gls':
            return `https://www.gls-italy.com/it/trova-spedizione?sh=${cleanNumber}`;
        default:
            return `https://www.google.com/search?q=tracking+${encodeURIComponent(carrier)}+${encodeURIComponent(cleanNumber)}`;
    }
}

app.post('/api/auth/login', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name } = req.body || {};
    const user = upsertUserInMemory({ id: auth.id, email: auth.email, name: name || auth.email.split('@')[0] });
    res.json({ success: true, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/catalog/search', async (req, res) => {
    const auth = await getAuthUser(req);
    const limitKey = auth ? 'catalog:' + auth.id : 'catalogip:' + clientIp(req);
    if (!rateLimit(limitKey, 80, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppe ricerche. Riprova tra poco.' });
    }
    const category = String(req.query.category || '');
    const q = String(req.query.q || '');
    if (q.trim().length < 2) {
        return res.json({ success: true, cards: [] });
    }
    if (!['Pokemon', 'Yugioh', 'Magic', 'OnePiece', 'Lorcana'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Per le carte singole scegli un gioco (non Altro TCG).' });
    }
    try {
        const listingType = String(req.query.type || SINGLE_CARD_TYPE);
    const cards = await searchOfficialCatalog(category, q, listingType);
        res.json({ success: true, cards });
    } catch (err) {
        res.status(502).json({ success: false, error: 'Catalogo ufficiale non raggiungibile. Riprova.' });
    }
});

app.post('/api/listings', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!rateLimit('list:' + auth.id, 12, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppi annunci. Riprova tra poco.' });
    }
    const body = req.body || {};
    const category = String(body.category || '');
    const type = String(body.type || '');
    const price = Number(String(body.price || '').replace(',', '.'));
    let location = String(body.location || '').trim();
    if (!location) {
        const extra = extraFor(auth.id);
        const mem = usersDB.find(u => u && String(u.id) === String(auth.id)) || {};
        const fromProfile = [mem.address || extra.address, mem.city || extra.city].filter(Boolean).join(', ');
        location = fromProfile || String(mem.city || extra.city || '').trim();
    }
    const condition = String(body.condition || '').trim();
    const imageUrl = String(body.image_url || '').trim();
    const rawDesc = String(body.description || '').trim().slice(0, 2000);
    const pending = !!body.pending;
    if (!['Pokemon', 'Yugioh', 'Magic', 'OnePiece', 'Lorcana', 'Altro'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Categoria non valida.' });
    }
    if (!type || !condition || !imageUrl || !(price > 0)) {
        return res.status(400).json({ success: false, error: 'Compila prezzo, condizione e foto.' });
    }
    if (!location) {
        return res.status(400).json({ success: false, error: 'Imposta via e città sul profilo: la posizione di vendita è quella.' });
    }
    if (listingOffTopic(type + ' ' + rawDesc + ' ' + String(body.title || ''))) {
        return res.status(400).json({ success: false, error: 'Annuncio fuori tema: qui si vendono solo TCG e accessori.' });
    }

    let title = String(body.title || '').trim().slice(0, 180);
    let catalogId = null;
    let catalogSource = null;
    let catalogSet = null;

    if (listingNeedsCatalog(type)) {
        if (category === 'Altro') {
            return res.status(400).json({ success: false, error: 'Carte, box e mazzi precon devono appartenere a un gioco ufficiale (Pokémon, Magic, Yu-Gi-Oh!, One Piece, Lorcana).' });
        }
        let verified = null;
        if (type === SINGLE_CARD_TYPE) {
            verified = await verifyOfficialCard(category, body.catalogSource, body.catalogId);
        } else if (String(body.catalogSource) === 'pokeset') {
            verified = await verifyPokeSet(body.catalogId);
        } else {
            verified = await verifyTcgcsvProduct(category, body.catalogId);
            if (verified && !productKindOk(verified.name, type)) verified = null;
        }
        if (!verified) {
            return res.status(400).json({ success: false, error: 'Questo prodotto non è nel catalogo ufficiale. Cercalo e selezionalo dalla lista (box/mazzi precon: nome set + booster box, ETB, deck…).' });
        }
        const official = verified.name + (verified.set ? (' · ' + verified.set) : '');
        const typed = String(body.title || '').trim();
        title = typed && typed.toLowerCase().includes(String(verified.name).toLowerCase())
            ? typed.slice(0, 180)
            : official;
        catalogId = verified.id;
        catalogSource = verified.source;
        catalogSet = verified.set || null;
    } else {
        if (title.length < 3) {
            return res.status(400).json({ success: false, error: 'Inserisci un titolo.' });
        }
        if (listingOffTopic(title)) {
            return res.status(400).json({ success: false, error: 'Annuncio fuori tema: qui si vendono solo TCG e accessori.' });
        }
    }

    const description = pending ? ('[[PENDING]]' + rawDesc) : rawDesc;
    const inserted = await insertListingRow({
        user_id: auth.id,
        seller_name: String(body.seller_name || auth.email || 'Venditore').slice(0, 80),
        category,
        type,
        title,
        price,
        location,
        condition,
        image_url: imageUrl,
        description,
        is_sold: false,
        catalog_id: catalogId,
        catalog_source: catalogSource,
        catalog_set: catalogSet
    }, auth.accessToken);
    if (inserted.error) {
        const hint = /permesso database/i.test(inserted.error)
            ? inserted.error
            : 'Salvataggio annuncio fallito. Riprova; se continua, su Supabase manca una colonna o il permesso INSERT su cards.';
        return res.status(400).json({ success: false, error: hint });
    }
    res.json({ success: true, card: inserted.row, title });
});

app.post('/api/users/profile', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name, address, city, accountType, avatar_url, lat, lng, radius_km } = req.body;
    const id = auth.id;
    const email = auth.email;
    const user = upsertUserInMemory({ id, email, name, address, city, accountType, avatar_url, lat, lng, radius_km });
    if (accountType) user.accountType = setAccountType(id, accountType);
    if (!(Number(user.lat) && Number(user.lng))) await attachGeoToUser(user);
    saveProfileExtra(id, {
        address: user.address || '',
        city: user.city || '',
        avatar_url: user.avatar_url || '',
        lat: user.lat,
        lng: user.lng,
        radius_km: user.radius_km
    });
    const supabaseResult = await saveProfileToSupabase(user);

    res.json({
        success: true,
        user,
        savedToSupabase: !supabaseResult.error,
        supabase: supabaseResult.data,
        error: supabaseResult.error || null,
        hint: supabaseResult.error
            ? 'Su Supabase esegui GRANT SELECT, INSERT, UPDATE ON public.profiles TO anon, authenticated; oppure imposta SUPABASE_SERVICE_ROLE_KEY nel .env del server.'
            : null
    });
});

app.get('/api/users/:userId', async (req, res) => {
    const userId = req.params.userId;
    if (userId === 'SYSTEM_ESCROW') {
        return res.json({ success: true, name: 'Sistema Escrow' });
    }

    const remoteProfile = await getProfileFromSupabase(userId);
    if (remoteProfile) {
        upsertUserInMemory(remoteProfile);
        const self = await getAuthUser(req);
        const payload = publicProfilePayload({ ...remoteProfile, ...extraFor(userId), id: userId });
        if (self && String(self.id) === String(userId)) {
            payload.email = remoteProfile.email || self.email;
            Object.assign(payload, walletPublic(userId));
        }
        return res.json(payload);
    }

    const user = usersDB.find(u => String(u.id) === String(userId));
    if (user) {
        const self = await getAuthUser(req);
        const payload = publicProfilePayload({ ...user, ...extraFor(userId) });
        if (self && String(self.id) === String(userId)) {
            payload.email = user.email || self.email;
            Object.assign(payload, walletPublic(userId));
        }
        return res.json(payload);
    }

    res.json({ success: true, found: false, name: '', address: '', city: '' });
});

app.get('/api/profiles/:userId', async (req, res) => {
    const userId = String(req.params.userId || '');
    if (!userId || userId === 'SYSTEM_ESCROW') {
        return res.json({ success: true, found: false, address: '', city: '' });
    }
    const remoteProfile = await getProfileFromSupabase(userId);
    if (remoteProfile) {
        return res.json(publicProfilePayload({ ...remoteProfile, ...extraFor(userId), id: userId }));
    }
    const user = usersDB.find(u => String(u.id) === userId);
    if (user) {
        return res.json(publicProfilePayload({ ...user, ...extraFor(userId) }));
    }
    const extra = extraFor(userId);
    if (extra.city || extra.address || extra.avatar_url) {
        return res.json(publicProfilePayload({ id: userId, ...extra }));
    }
    res.json({ success: true, found: false, address: '', city: '', accountType: 'privato', partner: false });
});

app.get('/api/geo/lookup', async (req, res) => {
    if (!rateLimit('geo:' + (req.ip || 'x'), 60, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppe ricerche mappa.' });
    }
    const geo = await geocodePlace(req.query.q, req.query.street, req.query.city);
    if (!geo) return res.json({ success: true, found: false });
    res.json({ success: true, found: true, ...geo });
});

app.get('/api/geo/sellers', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 80);
    const sellers = {};
    let geoBudget = 8;
    for (const id of ids) {
        const user = usersDB.find(u => String(u.id) === String(id));
        let row = mergeProfileRow({ ...(user || {}), ...extraFor(id), id });
        if (!extractCityFromProfile(row) && !row.address) {
            const remote = await getProfileFromSupabase(id);
            if (remote) row = mergeProfileRow({ ...row, ...remote, id });
        }
        if ((!Number(row.lat) || !Number(row.lng)) && geoBudget > 0) {
            geoBudget -= 1;
            const geo = await geocodePlace(extractCityFromProfile(row) || formatProfilePlace(row) || row.address);
            if (geo) {
                row.lat = geo.lat;
                row.lng = geo.lng;
                saveProfileExtra(id, { lat: geo.lat, lng: geo.lng, city: extractCityFromProfile(row), address: extractStreetFromProfile(row) });
            }
        }
        sellers[id] = {
            city: extractCityFromProfile(row),
            address: extractStreetFromProfile(row),
            place: formatProfilePlace(row),
            lat: Number(row.lat) || null,
            lng: Number(row.lng) || null,
            radius_km: Number(row.radius_km) || 20,
            avatar_url: row.avatar_url || ''
        };
    }
    res.json({ success: true, sellers });
});

app.get('/api/accounts/public', (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
        .slice(0, 100);
    const accounts = {};
    ids.forEach(id => { accounts[id] = publicAccountMeta(id); });
    res.json({ success: true, accounts });
});

app.post('/api/create-payment-intent', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!rateLimit('pay:' + auth.id, 8, 60000)) {
        return res.status(429).json({ error: { message: 'Troppe richieste di pagamento. Riprova tra poco.' } });
    }
    try {
        if (!stripe) {
            return res.status(500).json({ error: { message: 'STRIPE_SECRET_KEY non configurata.' } });
        }
        const body = req.body || {};
        const cardIds = normalizeCardIds(
            (body.cardIds && body.cardIds.length ? body.cardIds : null) || body.cardId || body.ids
        );
        if (!cardIds.length) {
            return res.status(400).json({ error: { message: 'Nessun articolo inviato al pagamento. Riapri la scheda e riprova.' } });
        }
        const cards = await getCardsByIds(cardIds);
        if (!cards.length) {
            return res.status(400).json({ error: { message: 'Articoli non trovati (id ' + cardIds.join(', ') + ').' } });
        }
        const sellerId = String(cards[0].user_id);
        if (cards.some(c => String(c.user_id) !== sellerId)) {
            return res.status(400).json({ error: { message: 'Il carrello deve contenere un solo venditore.' } });
        }
        if (String(sellerId) === auth.id) {
            return res.status(400).json({ error: { message: 'Non puoi acquistare i tuoi annunci.' } });
        }
        if (cards.some(c => c.is_sold === true || c.is_sold === 'true')) {
            return res.status(400).json({ error: { message: 'Uno o più articoli non sono più disponibili.' } });
        }
        const amount = cards.reduce((sum, c) => sum + Number(c.price || 0), 0);
        if (amount < CART_MIN_ORDER) {
            return res.status(400).json({ error: { message: 'Ordine minimo €' + CART_MIN_ORDER.toFixed(2) + '.' } });
        }
        const deliveryMethod = String(body.deliveryMethod || 'shipping').toLowerCase() === 'meetup' ? 'meetup' : 'shipping';
        if (deliveryMethod === 'meetup') {
            const meetupErr = assertMeetupAllowed(auth, amount);
            if (meetupErr) return res.status(400).json({ error: { message: meetupErr } });
        }
        const totalChargedToBuyer = platformChargeCents(amount);

        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalChargedToBuyer,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
            metadata: { buyerId: auth.id, sellerId, cardIds: cards.map(c => c.id).join(','), deliveryMethod }
        });

        const newOrder = {
            id: 'order-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
            paymentIntentId: paymentIntent.id,
            buyerId: auth.id,
            sellerId,
            cardId: cards[0].id,
            cardIds: cards.map(c => c.id),
            cardTitle: cards.map(c => c.title).join(', '),
            amount,
            status: 'pending_payment',
            escrowNotified: false,
            deliveryMethod,
            meetupCode: deliveryMethod === 'meetup' ? generateMeetupCode() : null,
            createdAt: new Date().toISOString()
        };
        if (newOrder.meetupCode) newOrder.meetupQrToken = newOrder.meetupCode;
        ordersDB.push(newOrder);
        persistOrdersToDisk();

        res.send({ clientSecret: paymentIntent.client_secret, orderId: newOrder.id });
    } catch (error) {
        res.status(400).send({ error: { message: error.message } });
    }
});

app.post('/api/payments/confirm', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { orderId, paymentIntentId } = req.body || {};
    let order = ordersDB.find(o => (orderId && o.id === orderId) || (paymentIntentId && o.paymentIntentId === paymentIntentId));
    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }
    if (String(order.buyerId) !== auth.id && !isAdminEmail(auth.email)) {
        return res.status(403).json({ success: false, error: 'Operazione non autorizzata.' });
    }
    if (order.escrowNotified) {
        return res.json({ success: true, alreadyFulfilled: true, order });
    }
    try {
        if (stripe && (paymentIntentId || order.paymentIntentId)) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId || order.paymentIntentId);
            if (pi.status !== 'succeeded') {
                return res.status(400).json({ success: false, error: 'Pagamento non confermato dal gateway.' });
            }
        } else if (!stripe) {
            return res.status(400).json({ success: false, error: 'Impossibile verificare il pagamento.' });
        }
        await fulfillPaidOrder(order);
        res.json({ success: true, order });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.get('/api/orders/:userId', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = req.params.userId;
    if (!assertSelf(req, res, userId)) return;
    const userOrders = ordersDB
        .filter(o => (o.buyerId === userId || o.sellerId === userId) && o.status && o.status !== 'pending_payment')
        .map(o => publicOrderFor(o, userId));
    res.json(userOrders);
});

app.post('/api/orders/:orderId/ship', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { orderId } = req.params;
    const { carrier, trackingNumber } = req.body;
    
    const order = ordersDB.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }
    if (String(order.sellerId) !== auth.id && !isAdminEmail(auth.email)) {
        return res.status(403).json({ success: false, error: 'Operazione non autorizzata.' });
    }
    if (order.deliveryMethod === 'meetup') {
        return res.status(400).json({ success: false, error: 'Questo ordine è un incontro: usa la proposta luogo/orario, non il tracking.' });
    }

    order.carrier = String(carrier || '').slice(0, 80);
    order.trackingNumber = String(trackingNumber || '').slice(0, 80);
    order.trackingLink = generateTrackingLink(order.carrier, order.trackingNumber);
    order.status = 'shipped';
    persistOrdersToDisk();
    const trackLabel = [order.carrier, order.trackingNumber].filter(Boolean).join(' · ');
    pushOrderEscrowMessages(
        order,
        'shipped',
        `Spedito {title} con ${trackLabel}. Aspetta che il compratore confermi. Poi 7 giorni di hold.`,
        `Spedito {title} con ${trackLabel}. Quando arriva, conferma la ricezione.`
    );

    res.json({ success: true, message: 'Dati di spedizione salvati con successo!', order });
});

app.post('/api/orders/:orderId/meetup', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const order = ordersDB.find(o => o.id === req.params.orderId);
    if (!order) return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    if (String(order.sellerId) !== auth.id && !isAdminEmail(auth.email)) {
        return res.status(403).json({ success: false, error: 'Operazione non autorizzata.' });
    }
    if (order.deliveryMethod !== 'meetup') {
        return res.status(400).json({ success: false, error: 'Questo ordine non è un incontro.' });
    }
    if (order.status !== 'paid' && order.status !== 'meetup_arranged') {
        return res.status(400).json({ success: false, error: 'Stato ordine non valido per l\'incontro.' });
    }
    const place = String((req.body && req.body.place) || '').trim().slice(0, 200);
    const at = String((req.body && req.body.at) || '').trim().slice(0, 80);
    if (!place || !at) {
        return res.status(400).json({ success: false, error: 'Luogo pubblico e orario sono obbligatori.' });
    }
    order.meetupPlace = place;
    order.meetupAt = at;
    order.status = 'meetup_arranged';
    persistOrdersToDisk();
    pushOrderEscrowMessages(
        order,
        'meetup_arranged',
        `Incontro proposto per {title}: ${place} — ${at}. Sul posto scansiona il QR del compratore.`,
        `Incontro per {title}: ${place} — ${at}. Luogo pubblico, ispeziona, poi mostra il QR.`
    );
    res.json({ success: true, order: publicOrderFor(order, auth.id) });
});

function settleCompletedOrder(order, method) {
    if (order.status === 'completed') return { already: true, amount: Number(order.amount || 0) };
    const holdDays = WALLET_HOLD_DAYS;
    order.status = 'completed';
    order.completedAt = new Date().toISOString();
    order.deliveryMethod = method;
    order.holdUntil = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000).toISOString();
    const seller = getOrCreateWalletUser(order.sellerId);
    const amount = Number(order.amount || 0);
    seller.heldWallet = Number(seller.heldWallet || 0) + amount;
    seller.walletUpdatedAt = order.completedAt;
    syncWalletTotals(seller);
    persistOrdersToDisk();
    persistWalletsToDisk();
    return { already: false, amount, holdDays, heldWallet: seller.heldWallet, availableWallet: seller.availableWallet };
}

app.post('/api/orders/meetup-scan', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const token = String((req.body && req.body.qrToken) || '').trim();
    if (!token) return res.status(400).json({ success: false, error: 'QR mancante.' });
    const order = ordersDB.find(o =>
        String(o.sellerId) === String(auth.id) &&
        o.deliveryMethod === 'meetup' &&
        o.status !== 'pending_payment' &&
        meetupTokenMatch(o, token)
    );
    if (!order && isAdminEmail(auth.email)) {
        const adminHit = ordersDB.find(o => o.deliveryMethod === 'meetup' && meetupTokenMatch(o, token));
        if (!adminHit) return res.status(404).json({ success: false, error: 'QR non valido.' });
        return finishMeetupScan(res, auth, adminHit);
    }
    if (!order) return res.status(404).json({ success: false, error: 'QR non valido per le tue vendite.' });
    return finishMeetupScan(res, auth, order);
});

function finishMeetupScan(res, auth, order) {
    if (order.status === 'completed') {
        return res.json({ success: true, alreadyCompleted: true, message: 'Incontro già confermato. Fondi in hold.', order: publicOrderFor(order, auth.id) });
    }
    if (order.status !== 'paid' && order.status !== 'meetup_arranged') {
        return res.status(400).json({ success: false, error: 'Questo ordine non è pronto per lo scan.' });
    }
    const settled = settleCompletedOrder(order, 'meetup');
    const holdLabel = (settled.holdDays || WALLET_HOLD_DAYS) + ' giorni';
    if (!settled.already) {
        pushOrderEscrowMessages(
            order,
            'completed',
            `QR ok per {title}. €${Number(settled.amount).toFixed(2)} in hold ${holdLabel}, poi prelievo IBAN.`,
            `Incontro confermato per {title}. Fondi in hold ${holdLabel}. Problemi: support@tcgvault.com.`
        );
    }
    return res.json({
        success: true,
        message: 'QR ok. Fondi in hold ' + holdLabel + ', poi prelevabili.',
        order: publicOrderFor(order, auth.id),
        heldWallet: settled.heldWallet,
        sellerWallet: settled.availableWallet
    });
}

app.post('/api/orders/:orderId/complete', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { orderId } = req.params;
    const order = ordersDB.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    if (String(order.buyerId) !== auth.id && !isAdminEmail(auth.email)) {
        return res.status(403).json({ success: false, error: 'Operazione non autorizzata.' });
    }

    if (order.status === 'completed') {
        return res.json({ success: true, message: 'Ordine già completato.', order });
    }

    const method = order.deliveryMethod || 'shipping';
    if (method === 'meetup') {
        return res.status(400).json({ success: false, error: 'Per l\'incontro il venditore deve scansionare il tuo QR sul posto (come il check-in tornei).' });
    } else if (order.status !== 'shipped') {
        return res.status(400).json({ success: false, error: 'Conferma la ricezione solo dopo la spedizione tracciata.' });
    }

    const settled = settleCompletedOrder(order, method);
    const holdDays = settled.holdDays || WALLET_HOLD_DAYS;
    const amount = settled.amount;
    const holdLabel = holdDays + ' giorni';
    pushOrderEscrowMessages(
        order,
        'completed',
        `Ricezione confermata · {title}. €${Number(amount).toFixed(2)} in hold ${holdLabel}, poi prelievo IBAN.`,
        `Ricezione confermata · {title}. Fondi in hold ${holdLabel}. Pacco sbagliato: support@tcgvault.com.`
    );

    res.json({
        success: true,
        message: 'Ricezione confermata. I fondi restano in hold ' + holdDays + ' giorni anti-chargeback, poi diventano prelevabili.',
        order: publicOrderFor(order, auth.id),
        sellerWallet: settled.availableWallet,
        heldWallet: settled.heldWallet
    });
});

async function stripeConnectStatus(user) {
    if (!stripe || !user.stripeAccountId) {
        return { connected: false, payoutsEnabled: false, detailsSubmitted: false };
    }
    try {
        const acct = await stripe.accounts.retrieve(user.stripeAccountId);
        return {
            connected: true,
            payoutsEnabled: !!(acct.payouts_enabled),
            detailsSubmitted: !!(acct.details_submitted)
        };
    } catch (err) {
        return { connected: false, payoutsEnabled: false, detailsSubmitted: false, error: err.message };
    }
}

app.get('/api/connect/status', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const user = getOrCreateWalletUser(auth.id);
    const st = await stripeConnectStatus(user);
    res.json({ success: true, stripeAccountId: user.stripeAccountId || null, ...st });
});

app.post('/api/connect/onboard', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!stripe) {
        return res.status(500).json({ success: false, error: 'Stripe non configurato.' });
    }
    if (!rateLimit('connect:' + auth.id, 8, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppe richieste. Riprova tra poco.' });
    }
    const user = getOrCreateWalletUser(auth.id);
    try {
        if (!user.stripeAccountId) {
            const fromShop = req.body && req.body.from === 'shop';
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'IT',
                email: auth.email || undefined,
                business_type: fromShop ? undefined : 'individual',
                capabilities: { transfers: { requested: true } },
                business_profile: { url: publicSiteUrl(req) }
            });
            user.stripeAccountId = account.id;
            persistWalletsToDisk();
        }
        const fromShop = req.body && req.body.from === 'shop';
        const site = publicSiteUrl(req);
        const path = fromShop ? '/shop-dashboard.html' : '/index.html';
        const link = await stripe.accountLinks.create({
            account: user.stripeAccountId,
            refresh_url: site + path + '?connect=refresh',
            return_url: site + path + '?connect=return',
            type: 'account_onboarding'
        });
        res.json({ success: true, url: link.url, stripeAccountId: user.stripeAccountId });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/wallet/payout', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = auth.id;
    releaseMatureHolds();
    const user = getOrCreateWalletUser(userId);
    const method = String((req.body && req.body.method) || 'iban').toLowerCase();

    if (pendingIbanInfo(user)) {
        return res.status(400).json({ success: false, error: 'Hai già un bonifico in lavorazione. Attendi l\'accredito o scrivi al supporto.' });
    }

    if ((user.availableWallet || 0) <= 0) {
        const held = Number(user.heldWallet || 0);
        const msg = held > 0
            ? 'Hai €' + held.toFixed(2) + ' in hold. Il prelievo è possibile solo dopo 7 giorni dalla conferma di consegna.'
            : 'Non hai fondi disponibili da prelevare nel wallet.';
        return res.status(400).json({ success: false, error: msg });
    }

    const withdrawnAmount = Number(user.availableWallet || 0);

    if (method === 'stripe') {
        if (!stripe) {
            return res.status(500).json({ success: false, error: 'Stripe non configurato.' });
        }
        const st = await stripeConnectStatus(user);
        if (!st.payoutsEnabled) {
            return res.status(400).json({ success: false, error: 'Per l\'accredito automatico completa Stripe Express, oppure usa il bonifico IBAN.' });
        }
        try {
            const transfer = await stripe.transfers.create({
                amount: Math.round(withdrawnAmount * 100),
                currency: 'eur',
                destination: user.stripeAccountId
            });
            user.availableWallet = 0;
            user.lastPayoutId = transfer && transfer.id ? String(transfer.id) : null;
            user.lastPayoutAt = new Date().toISOString();
            user.walletUpdatedAt = user.lastPayoutAt;
            syncWalletTotals(user);
            persistWalletsToDisk();
            return res.json({
                success: true,
                message: `Prelievo di €${withdrawnAmount.toFixed(2)} inviato sul tuo conto Stripe.`,
                newBalance: 0.00,
                heldWallet: Number(user.heldWallet || 0),
                payoutPending: false
            });
        } catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }

    const iban = normalizeIban(req.body && req.body.iban);
    const holder = String((req.body && req.body.holder) || '').trim();
    if (!isPlausibleIban(iban)) {
        return res.status(400).json({ success: false, error: 'Inserisci un IBAN valido.' });
    }
    if (holder.length < 3) {
        return res.status(400).json({ success: false, error: 'Inserisci nome e cognome dell\'intestatario del conto.' });
    }

    user.availableWallet = 0;
    user.iban = iban;
    setPendingIbanPayout(user, withdrawnAmount, holder);
    user.lastPayoutAt = new Date().toISOString();
    user.walletUpdatedAt = user.lastPayoutAt;
    syncWalletTotals(user);
    persistWalletsToDisk();

    res.json({
        success: true,
        message: `Richiesta di bonifico di €${withdrawnAmount.toFixed(2)} registrata. Arriva in 1-3 giorni lavorativi.`,
        newBalance: 0.00,
        heldWallet: Number(user.heldWallet || 0),
        payoutPending: true,
        payoutPendingAmount: withdrawnAmount
    });
});

app.get('/api/admin/payouts', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const items = usersDB.map(u => {
        const pending = pendingIbanInfo(u);
        if (!pending) return null;
        return {
            userId: String(u.id),
            email: u.email || '',
            name: u.name || '',
            iban: u.iban || '',
            holder: pending.holder,
            amount: pending.amount,
            requestedAt: u.lastPayoutAt || null
        };
    }).filter(Boolean);
    res.json({ success: true, payouts: items });
});

app.post('/api/admin/payouts/:userId/complete', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const user = getOrCreateWalletUser(req.params.userId);
    const pending = pendingIbanInfo(user);
    if (!pending) {
        return res.status(400).json({ success: false, error: 'Nessun bonifico in attesa per questo utente.' });
    }
    user.lastPayoutId = 'sepa_' + Date.now();
    user.lastPayoutAt = new Date().toISOString();
    user.walletUpdatedAt = user.lastPayoutAt;
    persistWalletsToDisk();
    res.json({ success: true });
});

app.post('/api/admin/payouts/:userId/reject', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const user = getOrCreateWalletUser(req.params.userId);
    const pending = pendingIbanInfo(user);
    if (!pending) {
        return res.status(400).json({ success: false, error: 'Nessun bonifico in attesa per questo utente.' });
    }
    user.availableWallet = Number(user.availableWallet || 0) + pending.amount;
    user.lastPayoutId = null;
    user.lastPayoutAt = new Date().toISOString();
    user.walletUpdatedAt = user.lastPayoutAt;
    syncWalletTotals(user);
    persistWalletsToDisk();
    res.json({ success: true, restored: pending.amount });
});

app.post('/api/messages', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!rateLimit('msg:' + auth.id, 40, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppi messaggi. Riprova tra poco.' });
    }
    const { receiverId, text, offerPrice, cardId, senderName } = req.body;
    const senderId = auth.id;
    if (!receiverId || !String(text || '').trim()) {
        return res.status(400).json({ success: false, error: 'receiverId e text sono obbligatori.' });
    }
    if (String(receiverId) === 'SYSTEM_ESCROW') {
        return res.status(400).json({ success: false, error: 'Destinatario non valido.' });
    }

    if (senderName) {
        upsertUserInMemory({ id: senderId, name: senderName, email: auth.email });
    }

    const newMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        senderId: String(senderId),
        receiverId: String(receiverId),
        text: String(text).trim().slice(0, 2000),
        offerPrice: offerPrice || null,
        cardId: cardId || null,
        senderName: senderName || null,
        timestamp: new Date().toISOString()
    };
    messagesDB.push(newMessage);
    persistMessagesToDisk();
    res.json({ success: true, message: newMessage });
});

app.get('/api/messages/:userId', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = String(req.params.userId);
    if (!assertSelf(req, res, userId)) return;
    const userMessages = messagesDB
        .filter(m => idsMatch(m.senderId, userId) || idsMatch(m.receiverId, userId))
        .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    res.json(userMessages.length > 250 ? userMessages.slice(-250) : userMessages);
});

app.post('/api/presence/ping', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { isTyping } = req.body || {};
    userPresenceDB[auth.id] = {
        lastSeen: Date.now(),
        isTyping: isTyping || false
    };
    res.json({ success: true });
});

app.get('/api/presence/:userId', (req, res) => {
    const userId = req.params.userId;
    const presence = userPresenceDB[userId] || { lastSeen: 0, isTyping: false };
    
    const now = Date.now();
    const isOnline = (now - presence.lastSeen) < 10000;

    res.json({
        isOnline,
        isTyping: presence.isTyping,
        lastSeen: presence.lastSeen
    });
});

app.post('/api/reviews', (req, res) => {
    const { sellerId, authorId, rating, comment } = req.body;
    const newReview = {
        id: 'rev-' + Date.now(),
        sellerId,
        authorId,
        rating: parseInt(rating),
        comment,
        timestamp: new Date().toISOString()
    };
    reviewsDB.push(newReview);
    res.json({ success: true, review: newReview });
});

app.get('/api/reviews/:sellerId', (req, res) => {
    const sellerId = req.params.sellerId;
    const sellerReviews = reviewsDB.filter(r => r.sellerId === sellerId);
    res.json(sellerReviews);
});

function answerVaultBot(message) {
    const q = String(message || '').toLowerCase().trim();
    if (!q) {
        return 'Ciao, sono VaultBot. Chiedimi carrello, annunci, località, chat, pagamenti, spedizioni o come funziona TCG Vault.';
    }
    if (/(ciao|salve|hey|buongiorno|buonasera|aiuto|help)/.test(q)) {
        return 'Ciao, sono VaultBot, l\'assistente ufficiale di TCG Vault. Posso spiegarti in modo chiaro: ordine minimo €20 dallo stesso venditore; soglia catalogo €50 con annunci in attesa; località dal campo address; notifiche chat dal primo messaggio; Escrow Stripe, spedizioni e wallet.';
    }
    if (/(carrello|minimo|20\s*€|20 euro|stesso venditore|venditori diversi)/.test(q)) {
        return 'Regola Carrello: l\'ordine minimo è €20,00 e gli articoli devono appartenere a un singolo venditore. Non è possibile mischiare venditori nello stesso carrello. Sotto i €20 il checkout resta bloccato.';
    }
    if (/(annuncio|in attesa|pending|50\s*€|50 euro|catalogo|soglia|pubblic)/.test(q)) {
        return 'Regola Annunci: se il valore totale dei prodotti non venduti di un venditore è sotto €50,00, gli annunci restano in stato «in attesa» e non compaiono in vetrina. Quando il cumulativo raggiunge €50,00 si pubblicano tutti insieme.';
    }
    if (/(localit|citt|address|indirizzo|dove si trova|posizione)/.test(q)) {
        return 'Regola Località: la città mostrata in marketplace e in chat è collegata al campo address del profilo su Supabase. Non usiamo un testo fisso tipo «Verificata»: se address manca, la città non viene trovata.';
    }
    if (/(chat|notif|messagg|primo messaggio|campanello)/.test(q)) {
        return 'Regola Chat: il primo messaggio attiva correttamente la notifica. Il controllo periodico memorizza gli ID già visti e segnala ogni nuovo arrivo, senza saltare il primo.';
    }
    if (/(escrow|pagament|stripe|carta|checkout|tos|termini)/.test(q)) {
        return 'Pagamenti: il checkout usa Stripe. I fondi restano in Escrow fino a conferma di consegna o scambio a mano, poi passano nel wallet del venditore. Per completare l\'ordine servono Nome completo, indirizzo di fatturazione e la spunta obbligatoria «Accetto i Termini e le Condizioni».';
    }
    if (/(spediz|corriere|pacco|poste|inpost|gls|dhl|ups|brt)/.test(q)) {
        return 'Spedizioni: i corrieri autorizzati sono Poste Italiane/SDA, InPost, BRT, GLS, DHL e UPS. I metodi non tracciati fanno decadere la protezione Escrow. Lo scambio a mano: il compratore mostra un QR (come al check-in tornei), il venditore lo scansiona e i fondi restano 7 giorni in hold.';
    }
    if (/(ordine|wallet|prelievo|iban|vendita|acquisto)/.test(q)) {
        return 'Gestione ordini: dopo il pagamento l\'ordine è protetto. L\'acquirente riceve il prodotto con spedizione tracciata o scambio a mano; il venditore vede i fondi nel wallet e può richiedere il prelievo via IBAN a consegna confermata.';
    }
    if (/(ospite|guest|login|registr|account|profilo)/.test(q)) {
        return 'Puoi sfogliare il catalogo da ospite. Per vendere, chattare, salvare, offrire o comprare serve l\'accesso. Il profilo salva nome, email e address su Supabase.';
    }
    if (/(negozio|partner|saas|abbonamento|15|9,99|9.99|area negozi|promo|coupon|codice)/.test(q)) {
        return 'Area Negozi: marketplace e vendita carte restano gratuiti. Un unico piano negozio da €15,00/mese (o codice promo) sblocca tornei, QR, vetrina partner, boost locale, buylist, codici sconto store e ritiro in sede. La commissione 5% e la soglia catalogo €50 restano uguali per tutti.';
    }
    if (/(torneo|eventi|qr|iscriv)/.test(q)) {
        return 'Tornei: i giocatori vedono gli eventi dei negozi partner, si iscrivono con un click e ricevono un QR personale da mostrare in store. I negozi abbonati creano i tornei e scansionano i QR al check-in dalla dashboard negozio.';
    }
    if (/(faq|come funziona|regole|marketplace)/.test(q)) {
        return 'TCG Vault è un marketplace TCG. In evidenza restano ricerca e categorie. I filtri avanzati stanno nell\'ingranaggio ⚙️. Regole chiave: carrello €20 stesso venditore; annunci in attesa sotto €50 cumulativi; località da address; chat con notifica dal primo messaggio; pagamenti Escrow Stripe.';
    }
    return 'Ho letto la tua domanda. In sintesi TCG Vault protegge compravendite TCG con Escrow, carrello minimo €20 dallo stesso venditore, pubblicazione annunci al raggiungimento di €50 di catalogo, località da address e chat con notifica già dal primo messaggio. Riformula il dettaglio (carrello, annuncio, chat, pagamento o spedizione) e ti rispondo in modo puntuale. Per casi account puoi scrivere a support@tcgvault.com.';
}

app.get('/api/shops/status/:userId', (req, res) => {
    const userId = String(req.params.userId || '');
    const sub = shopSubsDB.find(s => String(s.userId) === userId);
    const active = isShopActive(userId);
    res.json({
        success: true,
        active,
        subscription: sub ? {
            shopName: sub.shopName,
            status: active ? 'active' : (sub.status || 'inactive'),
            activeUntil: sub.activeUntil || null,
            unlimited: !!sub.unlimited || (!sub.activeUntil && active),
            planSource: sub.planSource || (active ? 'paid' : null),
            priceMonthly: SHOP_PLAN_EUR
        } : null
    });
});

app.post('/api/shops/subscribe', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = auth.id;
    const email = auth.email;
    const { shopName } = req.body || {};
    const name = String(shopName || '').trim() || 'Negozio TCG';
    let sub = shopSubsDB.find(s => String(s.userId) === String(userId));
    if (!sub) {
        sub = { userId: String(userId), shopName: name, email: email || '', status: 'pending', createdAt: new Date().toISOString() };
        shopSubsDB.push(sub);
    } else {
        sub.shopName = name;
        if (email) sub.email = email;
    }

    if (stripe) {
        try {
            const paymentIntent = await stripe.paymentIntents.create({
                amount: SHOP_PLAN_CENTS,
                currency: 'eur',
                automatic_payment_methods: { enabled: true },
                metadata: { type: 'shop_saas', userId: String(userId) }
            });
            sub.pendingPaymentIntentId = paymentIntent.id;
            persistShopsToDisk();
            return res.json({ success: true, requiresPayment: true, clientSecret: paymentIntent.client_secret, price: SHOP_PLAN_EUR });
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
    }

    return res.status(503).json({ success: false, error: 'Pagamento non disponibile. Usa un codice promozionale oppure configura Stripe.' });
});

app.post('/api/shops/redeem', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!rateLimit('redeem:' + auth.id, 10, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppi tentativi. Riprova tra poco.' });
    }
    const userId = auth.id;
    const email = auth.email;
    const { shopName, code } = req.body || {};
    const promo = findPromoByCode(code);
    if (!promo) return res.status(404).json({ success: false, error: 'Codice promozionale non valido.' });
    if (promo.enabled === false) return res.status(400).json({ success: false, error: 'Codice disattivato.' });
    if (promo.validUntil && new Date(promo.validUntil).getTime() < Date.now()) {
        return res.status(400).json({ success: false, error: 'Codice scaduto.' });
    }
    promo.redemptions = promo.redemptions || [];
    const already = promo.redemptions.some(r => String(r.userId) === String(userId));
    const maxUses = promo.maxUses == null ? null : Number(promo.maxUses);
    if (!already && maxUses != null && maxUses > 0 && promo.redemptions.length >= maxUses) {
        return res.status(400).json({ success: false, error: 'Codice esaurito.' });
    }
    const sub = getOrCreateShopSub(userId, shopName, email);
    activateShopFromPromo(sub, promo);
    if (!already) {
        promo.redemptions.push({
            userId: String(userId),
            email: email || '',
            at: new Date().toISOString()
        });
    }
    persistShopsToDisk();
    persistPromoCodesToDisk();
    res.json({
        success: true,
        requiresPayment: false,
        activatedByPromo: true,
        subscription: {
            shopName: sub.shopName,
            status: 'active',
            activeUntil: sub.activeUntil,
            unlimited: !!sub.unlimited,
            planSource: 'promo'
        }
    });
});

app.get('/api/promo-codes', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    res.json({ success: true, codes: promoCodesDB.map(publicPromo) });
});

app.post('/api/promo-codes', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const { code, label, maxUses, durationDays } = req.body || {};
    let normalized = normalizePromoCode(code);
    if (!normalized) {
        normalized = 'PROMO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    }
    if (!isValidPromoFormat(normalized)) {
        return res.status(400).json({ success: false, error: 'Formato codice non valido (4-32 caratteri, lettere, numeri, - _).' });
    }
    if (promoCodesDB.some(p => normalizePromoCode(p.code) === normalized)) {
        return res.status(400).json({ success: false, error: 'Codice già esistente.' });
    }
    const usesCap = maxUses === '' || maxUses == null ? null : Number(maxUses);
    const days = durationDays === '' || durationDays == null ? null : Number(durationDays);
    const promo = {
        id: 'promo-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
        code: normalized,
        label: String(label || '').trim(),
        maxUses: usesCap && usesCap > 0 ? usesCap : null,
        durationDays: days && days > 0 ? days : null,
        enabled: true,
        createdBy: String(req.auth && req.auth.email || '').toLowerCase(),
        createdAt: new Date().toISOString(),
        redemptions: []
    };
    promoCodesDB.push(promo);
    persistPromoCodesToDisk();
    res.json({ success: true, code: publicPromo(promo) });
});

app.post('/api/promo-codes/:id/disable', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const promo = promoCodesDB.find(p => p.id === req.params.id);
    if (!promo) return res.status(404).json({ success: false, error: 'Codice non trovato.' });
    promo.enabled = false;
    persistPromoCodesToDisk();
    res.json({ success: true, code: publicPromo(promo) });
});

app.post('/api/shops/confirm', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const userId = auth.id;
    const { paymentIntentId } = req.body || {};
    const sub = shopSubsDB.find(s => String(s.userId) === String(userId));
    if (!sub) return res.status(404).json({ success: false, error: 'Abbonamento non trovato.' });
    try {
        if (stripe && (paymentIntentId || sub.pendingPaymentIntentId)) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId || sub.pendingPaymentIntentId);
            if (pi.status !== 'succeeded') {
                return res.status(400).json({ success: false, error: 'Pagamento abbonamento non confermato.' });
            }
            if (Number(pi.amount) < SHOP_PLAN_CENTS - 1) {
                return res.status(400).json({ success: false, error: 'Importo abbonamento non valido.' });
            }
        }
        sub.status = 'active';
        sub.activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        persistShopsToDisk();
        res.json({ success: true, subscription: sub });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

function alreadyPlayed(rounds, a, b) {
    return (rounds || []).some(round => (round.pairings || []).some(p =>
        (String(p.a) === String(a) && String(p.b) === String(b)) ||
        (String(p.a) === String(b) && String(p.b) === String(a))
    ));
}

function findPlayer(tournament, userId) {
    return (tournament.players || []).find(p => String(p.userId) === String(userId));
}

function applyMatchResult(tournament, pairing, result) {
    const pa = findPlayer(tournament, pairing.a);
    const pb = pairing.b ? findPlayer(tournament, pairing.b) : null;
    if (pa) {
        pa.wins = Number(pa.wins || 0);
        pa.losses = Number(pa.losses || 0);
        pa.draws = Number(pa.draws || 0);
        pa.matchPoints = Number(pa.matchPoints || 0);
        pa.opponents = pa.opponents || [];
    }
    if (pb) {
        pb.wins = Number(pb.wins || 0);
        pb.losses = Number(pb.losses || 0);
        pb.draws = Number(pb.draws || 0);
        pb.matchPoints = Number(pb.matchPoints || 0);
        pb.opponents = pb.opponents || [];
    }
    if (result === 'bye' && pa) {
        pa.wins += 1;
        pa.matchPoints += 3;
        pairing.result = 'bye';
        return;
    }
    if (!pa || !pb) return;
    pa.opponents.push(String(pb.userId));
    pb.opponents.push(String(pa.userId));
    if (result === 'draw') {
        pa.draws += 1;
        pb.draws += 1;
        pa.matchPoints += 1;
        pb.matchPoints += 1;
    } else if (String(result) === String(pa.userId)) {
        pa.wins += 1;
        pb.losses += 1;
        pa.matchPoints += 3;
    } else {
        pb.wins += 1;
        pa.losses += 1;
        pb.matchPoints += 3;
    }
    pairing.result = result;
}

function pairSwiss(tournament) {
    const active = (tournament.players || []).filter(p => p.checkedIn && !p.dropped);
    const sorted = active.slice().sort((a, b) =>
        Number(b.matchPoints || 0) - Number(a.matchPoints || 0) ||
        String(a.name || '').localeCompare(String(b.name || ''))
    );
    const used = new Set();
    const pairings = [];
    let table = 1;
    sorted.forEach((player, i) => {
        if (used.has(String(player.userId))) return;
        let partner = null;
        for (let j = i + 1; j < sorted.length; j++) {
            const cand = sorted[j];
            if (used.has(String(cand.userId))) continue;
            if (!alreadyPlayed(tournament.rounds, player.userId, cand.userId)) {
                partner = cand;
                break;
            }
        }
        if (!partner) {
            for (let j = i + 1; j < sorted.length; j++) {
                if (!used.has(String(sorted[j].userId))) {
                    partner = sorted[j];
                    break;
                }
            }
        }
        used.add(String(player.userId));
        if (!partner) {
            pairings.push({ table: table++, a: player.userId, b: null, result: null });
        } else {
            used.add(String(partner.userId));
            pairings.push({ table: table++, a: player.userId, b: partner.userId, result: null });
        }
    });
    return pairings;
}

function enrollTournamentPlayer(tournament, opts) {
    const qrToken = 'TCG-' + tournament.id + '-' + crypto.randomBytes(6).toString('hex');
    const player = {
        userId: String(opts.userId),
        name: opts.name || 'Giocatore',
        email: String(opts.email || '').trim(),
        qrToken,
        checkedIn: false,
        registeredAt: new Date().toISOString(),
        feePaid: Number(opts.fee || 0),
        paymentIntentId: opts.paymentIntentId || null
    };
    tournament.players = tournament.players || [];
    tournament.players.push(player);
    return player;
}

function creditShopTournamentFee(tournament, fee) {
    const gross = Number(fee || 0);
    if (gross <= 0) return;
    const shop = getOrCreateWalletUser(tournament.shopId);
    shop.heldWallet = Number(shop.heldWallet || 0) + gross;
    shop.walletUpdatedAt = new Date().toISOString();
    syncWalletTotals(shop);
    const holdUntil = new Date(Date.now() + WALLET_HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    ordersDB.push({
        id: 'tfee-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
        buyerId: 'tournament-fee',
        sellerId: String(tournament.shopId),
        cardTitle: 'Iscrizione: ' + (tournament.title || 'Torneo'),
        amount: gross,
        status: 'completed',
        deliveryMethod: 'shipping',
        completedAt: new Date().toISOString(),
        holdUntil,
        createdAt: new Date().toISOString()
    });
    persistOrdersToDisk();
    persistWalletsToDisk();
}

function requireShopTournament(req, tournament) {
    if (!tournament) return 'Torneo non trovato.';
    if (String(tournament.shopId) !== String(req.auth.id) && !isAdminEmail(req.auth.email)) {
        return 'Operazione non autorizzata.';
    }
    if (!isShopActive(req.auth.id) && !isAdminEmail(req.auth.email)) {
        return 'Abbonamento negozio non attivo.';
    }
    return null;
}

app.get('/api/tournaments', (req, res) => {
    const list = tournamentsDB
        .filter(t => t.status !== 'cancelled')
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
        .map(publicTournament);
    res.json(list);
});

app.get('/api/tournaments/shop/:shopId', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const shopId = String(req.params.shopId);
    if (!assertSelf(req, res, shopId)) return;
    if (!isShopActive(shopId)) {
        return res.status(403).json({ success: false, error: 'Abbonamento negozio non attivo.' });
    }
    const list = tournamentsDB.filter(t => String(t.shopId) === shopId);
    res.json(list);
});

app.post('/api/tournaments', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const shopId = auth.id;
    const { shopName, title, game, date, time, location, maxPlayers, fee, description } = req.body || {};
    if (!isShopActive(shopId)) {
        return res.status(403).json({ success: false, error: 'Serve l\'abbonamento Area Negozi (€15,00/mese) per creare tornei.' });
    }
    if (!title || !date) {
        return res.status(400).json({ success: false, error: 'Titolo e data sono obbligatori.' });
    }
    const tournament = {
        id: 'trn-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
        shopId: String(shopId),
        shopName: shopName || 'Negozio TCG',
        title: String(title).trim(),
        game: game || 'TCG',
        date,
        time: time || '',
        location: location || '',
        maxPlayers: Number(maxPlayers) || 32,
        fee: Number(fee) || 0,
        description: description || '',
        status: 'open',
        players: [],
        rounds: [],
        createdAt: new Date().toISOString()
    };
    tournamentsDB.push(tournament);
    persistTournamentsToDisk();
    res.json({ success: true, tournament });
});

app.post('/api/tournaments/:id/register', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const tournament = tournamentsDB.find(t => t.id === req.params.id);
    if (!tournament) return res.status(404).json({ success: false, error: 'Torneo non trovato.' });
    if (tournament.status !== 'open') {
        return res.status(400).json({ success: false, error: 'Iscrizioni chiuse.' });
    }
    const userId = auth.id;
    const email = auth.email;
    const name = (req.body && req.body.name) || auth.email.split('@')[0];
    if (!email) {
        return res.status(400).json({ success: false, error: 'Accedi e indica un\'email valida per ricevere il QR.' });
    }
    if ((tournament.players || []).some(p => String(p.userId) === String(userId))) {
        const existing = tournament.players.find(p => String(p.userId) === String(userId));
        return res.json({
            success: true,
            alreadyRegistered: true,
            qrToken: existing.qrToken,
            qrImageUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(existing.qrToken),
            emailSent: false,
            message: 'Sei già iscritto. Mostra questo QR in negozio.'
        });
    }
    if ((tournament.players || []).length >= Number(tournament.maxPlayers || 32)) {
        return res.status(400).json({ success: false, error: 'Torneo al completo.' });
    }
    const fee = Number(tournament.fee || 0);
    if (fee > 0) {
        const paymentIntentId = req.body && req.body.paymentIntentId;
        if (!stripe) {
            return res.status(500).json({ success: false, error: 'Pagamenti non configurati.' });
        }
        if (!paymentIntentId) {
            return res.status(400).json({ success: false, error: 'Questa iscrizione è a pagamento.', requiresPayment: true, fee });
        }
        try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            if (pi.status !== 'succeeded') {
                return res.status(400).json({ success: false, error: 'Pagamento iscrizione non confermato.' });
            }
            if (String(pi.metadata.tournamentId) !== String(tournament.id) || String(pi.metadata.userId) !== String(userId)) {
                return res.status(400).json({ success: false, error: 'Pagamento non valido per questa iscrizione.' });
            }
            if (Number(pi.amount) < platformChargeCents(fee) - 1) {
                return res.status(400).json({ success: false, error: 'Importo pagamento non corrispondente.' });
            }
            if ((tournament.players || []).some(p => p.paymentIntentId && String(p.paymentIntentId) === String(paymentIntentId))) {
                return res.status(400).json({ success: false, error: 'Questo pagamento è già stato usato.' });
            }
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
    }
    const enrolled = enrollTournamentPlayer(tournament, { userId, name, email, fee, paymentIntentId: (req.body && req.body.paymentIntentId) || null });
    persistTournamentsToDisk();
    if (fee > 0) creditShopTournamentFee(tournament, fee);
    res.json({
        success: true,
        qrToken: enrolled.qrToken,
        qrImageUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(enrolled.qrToken),
        emailSent: false,
        message: fee > 0
            ? 'Iscrizione pagata. Mostra questo QR al check-in. Il negozio riceve l\'intera quota, in hold 7 giorni.'
            : 'Iscrizione confermata. Il QR è pronto: salvalo e usalo al check-in.'
    });
});

app.post('/api/tournaments/:id/register-intent', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!rateLimit('tpay:' + auth.id, 8, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppe richieste di pagamento. Riprova tra poco.' });
    }
    const tournament = tournamentsDB.find(t => t.id === req.params.id);
    if (!tournament) return res.status(404).json({ success: false, error: 'Torneo non trovato.' });
    if (tournament.status !== 'open') {
        return res.status(400).json({ success: false, error: 'Iscrizioni chiuse.' });
    }
    if ((tournament.players || []).some(p => String(p.userId) === String(auth.id))) {
        return res.json({ success: true, requiresPayment: false, alreadyRegistered: true });
    }
    const fee = Number(tournament.fee || 0);
    if (fee <= 0) {
        return res.json({ success: true, requiresPayment: false, fee: 0 });
    }
    if (!stripe) {
        return res.status(500).json({ success: false, error: 'Pagamenti non configurati.' });
    }
    try {
        const chargedCents = platformChargeCents(fee);
        const paymentIntent = await stripe.paymentIntents.create({
            amount: chargedCents,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
            metadata: {
                type: 'tournament_entry',
                tournamentId: String(tournament.id),
                userId: String(auth.id),
                shopId: String(tournament.shopId)
            }
        });
        res.json({
            success: true,
            requiresPayment: true,
            fee,
            charged: chargedCents / 100,
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/tournaments/:id/checkin', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const shopId = auth.id;
    const { qrToken } = req.body || {};
    if (!isShopActive(shopId)) {
        return res.status(403).json({ success: false, error: 'Abbonamento negozio non attivo.' });
    }
    const tournament = tournamentsDB.find(t => t.id === req.params.id && String(t.shopId) === String(shopId));
    if (!tournament) return res.status(404).json({ success: false, error: 'Torneo non trovato.' });
    const token = String(qrToken || '').trim();
    const player = (tournament.players || []).find(p => p.qrToken === token);
    if (!player) return res.status(404).json({ success: false, error: 'QR non valido per questo evento.' });
    if (player.checkedIn) {
        return res.json({ success: true, alreadyCheckedIn: true, player: { name: player.name, email: player.email } });
    }
    player.checkedIn = true;
    player.checkedInAt = new Date().toISOString();
    persistTournamentsToDisk();
    res.json({ success: true, player: { name: player.name, email: player.email } });
});

app.post('/api/tournaments/:id/round', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const tournament = tournamentsDB.find(t => t.id === req.params.id);
    const denied = requireShopTournament(req, tournament);
    if (denied) {
        const code = denied === 'Torneo non trovato.' ? 404 : 403;
        return res.status(code).json({ success: false, error: denied });
    }
    tournament.rounds = Array.isArray(tournament.rounds) ? tournament.rounds : [];
    const current = tournament.rounds[tournament.rounds.length - 1];
    if (current && (current.pairings || []).some(p => !p.result)) {
        return res.status(400).json({ success: false, error: 'Chiudi tutti i tavoli del round corrente prima di abbinare il successivo.' });
    }
    const ready = (tournament.players || []).filter(p => p.checkedIn && !p.dropped);
    if (ready.length < 2) {
        return res.status(400).json({ success: false, error: 'Servono almeno 2 giocatori al check-in per partire.' });
    }
    const pairings = pairSwiss(tournament);
    pairings.forEach(p => {
        if (!p.b) applyMatchResult(tournament, p, 'bye');
    });
    tournament.rounds.push({
        number: tournament.rounds.length + 1,
        pairings,
        startedAt: new Date().toISOString()
    });
    tournament.status = 'running';
    persistTournamentsToDisk();
    res.json({ success: true, tournament });
});

app.post('/api/tournaments/:id/match', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const tournament = tournamentsDB.find(t => t.id === req.params.id);
    const denied = requireShopTournament(req, tournament);
    if (denied) {
        const code = denied === 'Torneo non trovato.' ? 404 : 403;
        return res.status(code).json({ success: false, error: denied });
    }
    const table = Number(req.body && req.body.table);
    const result = req.body && req.body.result;
    const round = (tournament.rounds || [])[tournament.rounds.length - 1];
    if (!round) return res.status(400).json({ success: false, error: 'Nessun round attivo.' });
    const pairing = (round.pairings || []).find(p => Number(p.table) === table);
    if (!pairing) return res.status(404).json({ success: false, error: 'Tavolo non trovato.' });
    if (pairing.result) return res.status(400).json({ success: false, error: 'Risultato già registrato.' });
    if (pairing.b == null) return res.status(400).json({ success: false, error: 'Bye già assegnato.' });
    const valid = result === 'draw' || String(result) === String(pairing.a) || String(result) === String(pairing.b);
    if (!valid) return res.status(400).json({ success: false, error: 'Risultato non valido.' });
    applyMatchResult(tournament, pairing, result);
    persistTournamentsToDisk();
    res.json({ success: true, tournament });
});

app.post('/api/vaultbot', (req, res) => {
    if (!rateLimit('bot:' + clientIp(req), 30, 60000)) {
        return res.status(429).json({ success: false, error: 'Troppe richieste a VaultBot.' });
    }
    const reply = answerVaultBot(req.body && req.body.message);
    res.json({ success: true, reply });
});

const PORT = process.env.PORT || 4242;
Promise.all([
    loadOrdersFromSupabase(),
    loadMessagesFromSupabase(),
    loadShopsFromSupabase(),
    loadTournamentsFromSupabase(),
    loadPromoCodesFromSupabase(),
    loadWalletsFromSupabase()
]).finally(() => {
    releaseMatureHolds();
    app.listen(PORT, () => {
        console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT}`);
        console.log('Ambiente:', IS_SANDBOX ? 'SANDBOX' : 'produzione');
        console.log('Dati locali:', DATA_DIR);
        if (IS_SANDBOX && !fs.existsSync(path.join(__dirname, '.env.sandbox'))) {
            console.log('Attenzione: manca .env.sandbox — Supabase/Stripe sono quelli del live. Copia .env.sandbox.example in .env.sandbox con un progetto di test.');
        }
        console.log('Stripe:', stripe ? 'configurato' : 'manca STRIPE_SECRET_KEY');
        console.log('Webhook:', process.env.STRIPE_WEBHOOK_SECRET ? 'configurato' : 'manca STRIPE_WEBHOOK_SECRET');
    });
});
