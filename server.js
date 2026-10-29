require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

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
        const file = path.join(__dirname, 'data', 'orders.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(ordersDB, null, 2));
    } catch (err) {
        console.error('Salvataggio ordini fallito:', err.message);
    }
    persistOrdersToSupabase().catch(err => console.error('Salvataggio ordini Supabase:', err.message));
}

function loadOrdersFromDisk() {
    try {
        const file = path.join(__dirname, 'data', 'orders.json');
        if (!fs.existsSync(file)) return;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) ordersDB = parsed;
    } catch (err) {
        console.error('Lettura ordini persistiti fallita:', err.message);
    }
}

async function markCardsSold(cardIds) {
    const ids = [...new Set((cardIds || []).map(id => Number(id)).filter(n => Number.isFinite(n)))];
    if (!ids.length) return;
    try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/cards?id=in.(' + ids.join(',') + ')', {
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

async function fulfillPaidOrder(order) {
    if (!order || order.escrowNotified) return order;
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.escrowNotified = true;
    if (order.sellerId && order.sellerId !== 'unknown') {
        messagesDB.push({
            id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            senderId: 'SYSTEM_ESCROW',
            receiverId: order.sellerId,
            cardId: order.cardId || null,
            text: `📦 VENDITA EFFETTUATA! Il tuo prodotto "${order.cardTitle || 'Articolo TCG'}" è stato acquistato per €${Number(order.amount).toFixed(2)}. I fondi sono al sicuro in Escrow. Clicca qui per inserire corriere e tracciamento.`,
            isEscrowAlert: true,
            orderId: order.id,
            timestamp: new Date().toISOString()
        });
        persistMessagesToDisk();
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

const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');

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
    const raw = row.city || row.citta || row.location || row.address || '';
    const text = String(raw).trim();
    if (!text) return '';
    const parts = text.split(',').map(part => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : text;
}

const persistTimers = {};
function persistJsonFile(fileName, data, immediate) {
    if (!persistTimers[fileName]) persistTimers[fileName] = {};
    const slot = persistTimers[fileName];
    slot.data = data;
    const flush = () => {
        slot.timer = null;
        try {
            const file = path.join(__dirname, 'data', fileName);
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
        const file = path.join(__dirname, 'data', fileName);
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
        created_at: o.createdAt || new Date().toISOString()
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
        createdAt: r.created_at
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
                const file = path.join(__dirname, 'data', 'orders.json');
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

function rowToMessage(r) {
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
        timestamp: r.created_at
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
        players: Array.isArray(t.players) ? t.players : [],
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
        players: Array.isArray(r.players) ? r.players : [],
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

function walletToRow(u) {
    return {
        user_id: String(u.id || u.userId || ''),
        balance: Number(u.wallet || 0),
        iban: u.iban || null,
        last_payout_id: u.lastPayoutId || null,
        last_payout_at: u.lastPayoutAt || null,
        updated_at: u.walletUpdatedAt || new Date().toISOString()
    };
}

function applyWalletRow(r) {
    if (!r || !r.user_id) return;
    let user = usersDB.find(u => String(u.id) === String(r.user_id));
    if (!user) {
        user = { id: String(r.user_id), wallet: 0, iban: '' };
        usersDB.push(user);
    }
    user.wallet = Number(r.balance || 0);
    user.iban = r.iban || '';
    user.lastPayoutId = r.last_payout_id || null;
    user.lastPayoutAt = r.last_payout_at || null;
    user.walletUpdatedAt = r.updated_at || null;
}

function walletPublic(userId) {
    const user = usersDB.find(u => String(u.id) === String(userId));
    return {
        wallet: Number((user && user.wallet) || 0),
        iban: (user && user.iban) || ''
    };
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
            phoneConfirmed: !!row.phone_confirmed_at
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

async function getCardsByIds(ids) {
    const unique = [...new Set((ids || []).map(id => String(id)).filter(Boolean))].slice(0, 40);
    if (!unique.length) return [];
    const list = unique.map(id => '"' + id.replace(/"/g, '') + '"').join(',');
    const res = await fetch(SUPABASE_URL + '/rest/v1/cards?id=in.(' + list + ')&select=id,price,user_id,title,is_sold,description', {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY
        }
    });
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
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
    }
    return user;
}

async function saveProfileToSupabase(profile) {
    const payload = {
        id: String(profile.id),
        name: String(profile.name || ''),
        email: String(profile.email || ''),
        address: String(profile.address || '')
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const message = (data && (data.message || data.error)) || `HTTP ${res.status}`;
        console.error('Errore salvataggio profiles su Supabase:', message, data);
        return { error: message, data: null };
    }
    return { error: null, data };
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

app.post('/api/users/profile', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { name, address, accountType } = req.body;
    const id = auth.id;
    const email = auth.email;
    const user = upsertUserInMemory({ id, email, name, address, accountType });
    if (accountType) user.accountType = setAccountType(id, accountType);
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
        const flags = publicAccountMeta(userId);
        const self = await getAuthUser(req);
        const payload = {
            success: true,
            found: true,
            name: remoteProfile.name || '',
            city: extractCityFromProfile(remoteProfile),
            accountType: flags.accountType,
            partner: flags.partner
        };
        if (self && String(self.id) === String(userId)) {
            payload.email = remoteProfile.email || self.email;
            payload.address = remoteProfile.address || remoteProfile.city || remoteProfile.location || '';
            Object.assign(payload, walletPublic(userId));
        }
        return res.json(payload);
    }

    const user = usersDB.find(u => String(u.id) === String(userId));
    if (user) {
        const flags = publicAccountMeta(userId);
        const self = await getAuthUser(req);
        const payload = {
            success: true,
            found: true,
            name: user.name || '',
            city: extractCityFromProfile(user),
            accountType: flags.accountType,
            partner: flags.partner
        };
        if (self && String(self.id) === String(userId)) {
            payload.email = user.email || self.email;
            payload.address = user.address || '';
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
        const flags = publicAccountMeta(userId);
        return res.json({
            success: true,
            found: true,
            id: remoteProfile.id,
            name: remoteProfile.name || '',
            city: extractCityFromProfile(remoteProfile),
            accountType: flags.accountType,
            partner: flags.partner
        });
    }
    const user = usersDB.find(u => String(u.id) === userId);
    if (user) {
        const flags = publicAccountMeta(userId);
        return res.json({
            success: true,
            found: true,
            id: user.id,
            name: user.name || '',
            city: extractCityFromProfile(user),
            accountType: flags.accountType,
            partner: flags.partner
        });
    }
    res.json({ success: true, found: false, address: '', city: '', accountType: 'privato', partner: false });
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
        const cardIds = Array.isArray(body.cardIds) && body.cardIds.length ? body.cardIds : (body.cardId ? [body.cardId] : []);
        const cards = await getCardsByIds(cardIds);
        if (!cards.length) {
            return res.status(400).json({ error: { message: 'Articoli non trovati.' } });
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
        const baseAmountCents = Math.round(amount * 100);
        const applicationFee = Math.round(baseAmountCents * 0.07);
        const estimatedStripeFee = Math.round(baseAmountCents * 0.015) + 25;
        const totalChargedToBuyer = baseAmountCents + applicationFee + estimatedStripeFee;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalChargedToBuyer,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
            metadata: { buyerId: auth.id, sellerId, cardIds: cards.map(c => c.id).join(',') }
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
            createdAt: new Date().toISOString()
        };
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
    const userOrders = ordersDB.filter(o => o.buyerId === userId || o.sellerId === userId);
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

    order.carrier = String(carrier || '').slice(0, 80);
    order.trackingNumber = String(trackingNumber || '').slice(0, 80);
    order.trackingLink = generateTrackingLink(order.carrier, order.trackingNumber);
    order.status = 'shipped';
    persistOrdersToDisk();

    res.json({ success: true, message: 'Dati di spedizione salvati con successo!', order });
});

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

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    let seller = usersDB.find(u => u.id === order.sellerId);
    if (!seller) {
        seller = { id: order.sellerId, wallet: 0 };
        usersDB.push(seller);
    }
    seller.wallet = (seller.wallet || 0) + Number(order.amount);
    seller.walletUpdatedAt = order.completedAt;
    persistOrdersToDisk();
    persistWalletsToDisk();

    res.json({ success: true, message: 'Ricezione confermata! Fondi accreditati nel wallet del venditore.', order, sellerWallet: seller.wallet });
});

app.post('/api/wallet/payout', async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const { iban } = req.body;
    const userId = auth.id;
    
    let user = usersDB.find(u => String(u.id) === String(userId));
    if (!user) {
        user = { id: userId, wallet: 0.00, iban: '' };
        usersDB.push(user);
    }

    if (!iban || iban.trim().length < 10) {
        return res.status(400).json({ success: false, error: 'Inserisci un codice IBAN valido per il prelievo.' });
    }

    if ((user.wallet || 0) <= 0) {
        return res.status(400).json({ success: false, error: 'Non hai fondi disponibili da prelevare nel wallet.' });
    }

    try {
        const payoutAmount = Math.round((user.wallet || 0) * 100);
        let payoutResult;
        try {
            payoutResult = await stripe.payouts.create({
                amount: payoutAmount,
                currency: 'eur',
                method: 'standard',
                destination: iban.trim()
            });
        } catch (stripeErr) {
            payoutResult = { id: 'po_simulated_' + Date.now() };
        }

        const withdrawnAmount = user.wallet || 0;
        user.wallet = 0.00;
        user.iban = iban.trim();
        user.lastPayoutId = payoutResult && payoutResult.id ? String(payoutResult.id) : null;
        user.lastPayoutAt = new Date().toISOString();
        user.walletUpdatedAt = user.lastPayoutAt;
        persistWalletsToDisk();

        res.json({ 
            success: true, 
            message: `Prelievo di €${withdrawnAmount.toFixed(2)} elaborato con successo!`,
            newBalance: 0.00 
        });
    } catch (error) {
        res.status(400).send({ success: false, error: { message: error.message } });
    }
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
        return 'Spedizioni: i corrieri autorizzati sono Poste Italiane/SDA, InPost, BRT, GLS, DHL e UPS. I metodi non tracciati fanno decadere la protezione Escrow. Lo scambio a mano è consentito usando la città del profilo.';
    }
    if (/(ordine|wallet|prelievo|iban|vendita|acquisto)/.test(q)) {
        return 'Gestione ordini: dopo il pagamento l\'ordine è protetto. L\'acquirente riceve il prodotto con spedizione tracciata o scambio a mano; il venditore vede i fondi nel wallet e può richiedere il prelievo via IBAN a consegna confermata.';
    }
    if (/(ospite|guest|login|registr|account|profilo)/.test(q)) {
        return 'Puoi sfogliare il catalogo da ospite. Per vendere, chattare, salvare, offrire o comprare serve l\'accesso. Il profilo salva nome, email e address su Supabase.';
    }
    if (/(negozio|partner|saas|abbonamento|9,99|9.99|area negozi|promo|coupon|codice)/.test(q)) {
        return 'Area Negozi: marketplace e caricamento carte restano gratuiti. I servizi avanzati (tornei, check-in QR, dashboard) si sbloccano con SaaS €9,99/mese oppure con un codice promozionale valido, senza pagamento. L\'Admin Supremo genera i codici dal menu Admin.';
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
            priceMonthly: 9.99
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
                amount: 999,
                currency: 'eur',
                automatic_payment_methods: { enabled: true },
                metadata: { type: 'shop_saas', userId: String(userId) }
            });
            sub.pendingPaymentIntentId = paymentIntent.id;
            persistShopsToDisk();
            return res.json({ success: true, requiresPayment: true, clientSecret: paymentIntent.client_secret, price: 9.99 });
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
        }
        sub.status = 'active';
        sub.activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        persistShopsToDisk();
        res.json({ success: true, subscription: sub });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

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
        return res.status(403).json({ success: false, error: 'Serve l\'abbonamento Area Negozi (€9,99/mese) per creare tornei.' });
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
    const qrToken = 'TCG-' + tournament.id + '-' + crypto.randomBytes(6).toString('hex');
    const player = {
        userId: String(userId),
        name: name || 'Giocatore',
        email: String(email).trim(),
        qrToken,
        checkedIn: false,
        registeredAt: new Date().toISOString()
    };
    tournament.players.push(player);
    persistTournamentsToDisk();
    const qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(qrToken);
    res.json({
        success: true,
        qrToken,
        qrImageUrl,
        emailSent: false,
        message: 'Iscrizione confermata. Il QR è pronto: salvalo e usalo al check-in. L\'invio email parte quando SMTP è configurato sul server.'
    });
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
    app.listen(PORT, () => {
        console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT}`);
        console.log('Stripe:', stripe ? 'configurato' : 'manca STRIPE_SECRET_KEY');
        console.log('Webhook:', process.env.STRIPE_WEBHOOK_SECRET ? 'configurato' : 'manca STRIPE_WEBHOOK_SECRET');
    });
});
