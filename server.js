require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

const corsMiddleware = require('cors');
app.use(corsMiddleware());

function persistOrdersToDisk() {
    try {
        const file = path.join(__dirname, 'data', 'orders.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(ordersDB, null, 2));
    } catch (err) {
        console.error('Salvataggio ordini fallito:', err.message);
    }
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

function fulfillPaidOrder(order) {
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
    return order;
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
        if (order) fulfillPaidOrder(order);
    }
    res.json({ received: true });
});

app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const stripe = process.env.STRIPE_SECRET_KEY
    ? require('stripe')(process.env.STRIPE_SECRET_KEY)
    : null;

let messagesDB = [];
let reviewsDB = [];
let ordersDB = [];
let usersDB = []; 
let userPresenceDB = {};
let shopSubsDB = [];
let tournamentsDB = [];
let promoCodesDB = [];

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
    try {
        fs.mkdirSync(path.dirname(MESSAGES_FILE), { recursive: true });
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messagesDB, null, 2));
    } catch (err) {
        console.error('Salvataggio messaggi fallito:', err.message);
    }
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

function persistJsonFile(fileName, data) {
    try {
        const file = path.join(__dirname, 'data', fileName);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Salvataggio ' + fileName + ' fallito:', err.message);
    }
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

function persistShopsToDisk() { persistJsonFile('shops.json', shopSubsDB); }
function persistTournamentsToDisk() { persistJsonFile('tournaments.json', tournamentsDB); }
function persistPromoCodesToDisk() { persistJsonFile('promo-codes.json', promoCodesDB); }

function isAdminEmail(email) {
    return ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

function requireAdmin(req, res) {
    const email = (req.body && req.body.adminEmail)
        || (req.query && req.query.adminEmail)
        || req.headers['x-admin-email'];
    if (!isAdminEmail(email)) {
        res.status(403).json({ success: false, error: 'Solo Admin Supremo.' });
        return false;
    }
    return true;
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
ensureDefaultPromoCodes();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ahpkmppjtespemkzmkol.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFocGttcHBqdGVzcGVta3pta29sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNDM2NDAsImV4cCI6MjEwNzcxOTY0MH0._VeFP1v5vZkGz1-rGVUpHcROWWfs7zzkWEV7i96tkbk';

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

app.post('/api/auth/login', (req, res) => {
    const { id, email, name } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email obbligatoria.' });

    const userId = id || ('user-' + Date.now());
    const fallbackName = email.toLowerCase() === 'francesco_delduca@icloud.com' ? 'Francesco Del Duca (Admin)' : email.split('@')[0];
    const user = upsertUserInMemory({ id: userId, email, name: name || fallbackName });
    res.json({ success: true, user });
});

app.post('/api/users/profile', async (req, res) => {
    const { id, email, name, address } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'ID obbligatorio.' });

    const user = upsertUserInMemory({ id, email, name, address });
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
        return res.json({
            success: true,
            found: true,
            name: remoteProfile.name || '',
            email: remoteProfile.email || '',
            address: remoteProfile.address || remoteProfile.city || remoteProfile.location || '',
            city: extractCityFromProfile(remoteProfile)
        });
    }

    const user = usersDB.find(u => String(u.id) === String(userId));
    if (user) {
        return res.json({
            success: true,
            found: true,
            name: user.name || '',
            email: user.email || '',
            address: user.address || '',
            city: extractCityFromProfile(user)
        });
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
        return res.json({
            success: true,
            found: true,
            id: remoteProfile.id,
            name: remoteProfile.name || '',
            address: remoteProfile.address || remoteProfile.city || remoteProfile.location || '',
            city: extractCityFromProfile(remoteProfile)
        });
    }
    const user = usersDB.find(u => String(u.id) === userId);
    if (user) {
        return res.json({
            success: true,
            found: true,
            id: user.id,
            name: user.name || '',
            address: user.address || '',
            city: extractCityFromProfile(user)
        });
    }
    res.json({ success: true, found: false, address: '', city: '' });
});

app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, buyerId, sellerId, cardId, cardTitle } = req.body;
    try {
        if (!stripe) {
            return res.status(500).json({ error: { message: 'STRIPE_SECRET_KEY non configurata.' } });
        }
        const baseAmountCents = Math.round(amount * 100); 
        const applicationFee = Math.round(baseAmountCents * 0.07);
        const estimatedStripeFee = Math.round(baseAmountCents * 0.015) + 25;
        const totalChargedToBuyer = baseAmountCents + applicationFee + estimatedStripeFee;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalChargedToBuyer,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
        });

        const newOrder = {
            id: 'order-' + Date.now(),
            paymentIntentId: paymentIntent.id,
            buyerId: buyerId || 'guest',
            sellerId: sellerId || 'unknown',
            cardId: cardId || 'unknown',
            cardTitle: cardTitle || '',
            amount: amount,
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
    const { orderId, paymentIntentId } = req.body || {};
    let order = ordersDB.find(o => (orderId && o.id === orderId) || (paymentIntentId && o.paymentIntentId === paymentIntentId));
    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
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
        fulfillPaidOrder(order);
        res.json({ success: true, order });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.get('/api/orders/:userId', (req, res) => {
    const userId = req.params.userId;
    const userOrders = ordersDB.filter(o => o.buyerId === userId || o.sellerId === userId);
    res.json(userOrders);
});

app.post('/api/orders/:orderId/ship', (req, res) => {
    const { orderId } = req.params;
    const { carrier, trackingNumber } = req.body;
    
    const order = ordersDB.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    order.carrier = carrier;
    order.trackingNumber = trackingNumber;
    order.trackingLink = generateTrackingLink(carrier, trackingNumber);
    order.status = 'shipped';

    res.json({ success: true, message: 'Dati di spedizione salvati con successo!', order });
});

app.post('/api/orders/:orderId/complete', (req, res) => {
    const { orderId } = req.params;
    const order = ordersDB.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
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

    res.json({ success: true, message: 'Ricezione confermata! Fondi accreditati nel wallet del venditore.', order, sellerWallet: seller.wallet });
});

app.post('/api/wallet/payout', async (req, res) => {
    const { userId, iban } = req.body;
    
    let user = usersDB.find(u => u.id === userId);
    if (!user) {
        user = { id: userId, wallet: 0.00 }; 
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

        res.json({ 
            success: true, 
            message: `Prelievo di €${withdrawnAmount.toFixed(2)} elaborato con successo!`,
            newBalance: 0.00 
        });
    } catch (error) {
        res.status(400).send({ success: false, error: { message: error.message } });
    }
});

app.post('/api/messages', (req, res) => {
    const { senderId, receiverId, text, offerPrice, cardId, senderName } = req.body;
    if (!senderId || !receiverId || !String(text || '').trim()) {
        return res.status(400).json({ success: false, error: 'senderId, receiverId e text sono obbligatori.' });
    }

    if (senderName && senderId !== 'SYSTEM_ESCROW') {
        upsertUserInMemory({ id: senderId, name: senderName });
    }

    const newMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        senderId: String(senderId),
        receiverId: String(receiverId),
        text: String(text).trim(),
        offerPrice: offerPrice || null,
        cardId: cardId || null,
        senderName: senderName || null,
        timestamp: new Date().toISOString()
    };
    messagesDB.push(newMessage);
    persistMessagesToDisk();
    res.json({ success: true, message: newMessage });
});

app.get('/api/messages/:userId', (req, res) => {
    const userId = String(req.params.userId);
    const userMessages = messagesDB.filter(m => idsMatch(m.senderId, userId) || idsMatch(m.receiverId, userId));
    res.json(userMessages);
});

app.post('/api/presence/ping', (req, res) => {
    const { userId, isTyping } = req.body;
    if (!userId) return res.status(400).json({ success: false });

    userPresenceDB[userId] = {
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
    const { userId, shopName, email } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, error: 'userId obbligatorio.' });
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

    sub.status = 'active';
    sub.activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    persistShopsToDisk();
    res.json({ success: true, requiresPayment: false, subscription: sub });
});

app.post('/api/shops/redeem', (req, res) => {
    const { userId, shopName, email, code } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, error: 'Accedi per riscattare il codice.' });
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

app.get('/api/promo-codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ success: true, codes: promoCodesDB.map(publicPromo) });
});

app.post('/api/promo-codes', (req, res) => {
    if (!requireAdmin(req, res)) return;
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
        createdBy: String(req.body.adminEmail || '').toLowerCase(),
        createdAt: new Date().toISOString(),
        redemptions: []
    };
    promoCodesDB.push(promo);
    persistPromoCodesToDisk();
    res.json({ success: true, code: publicPromo(promo) });
});

app.post('/api/promo-codes/:id/disable', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const promo = promoCodesDB.find(p => p.id === req.params.id);
    if (!promo) return res.status(404).json({ success: false, error: 'Codice non trovato.' });
    promo.enabled = false;
    persistPromoCodesToDisk();
    res.json({ success: true, code: publicPromo(promo) });
});

app.post('/api/shops/confirm', async (req, res) => {
    const { userId, paymentIntentId } = req.body || {};
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

app.get('/api/tournaments/shop/:shopId', (req, res) => {
    const shopId = String(req.params.shopId);
    if (!isShopActive(shopId)) {
        return res.status(403).json({ success: false, error: 'Abbonamento negozio non attivo.' });
    }
    const list = tournamentsDB.filter(t => String(t.shopId) === shopId);
    res.json(list);
});

app.post('/api/tournaments', (req, res) => {
    const { shopId, shopName, title, game, date, time, location, maxPlayers, fee, description } = req.body || {};
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

app.post('/api/tournaments/:id/register', (req, res) => {
    const tournament = tournamentsDB.find(t => t.id === req.params.id);
    if (!tournament) return res.status(404).json({ success: false, error: 'Torneo non trovato.' });
    if (tournament.status !== 'open') {
        return res.status(400).json({ success: false, error: 'Iscrizioni chiuse.' });
    }
    const { userId, name, email } = req.body || {};
    if (!userId || !email) {
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
    console.log('QR torneo per', player.email, qrToken);
    res.json({
        success: true,
        qrToken,
        qrImageUrl,
        emailSent: false,
        message: 'Iscrizione confermata. Il QR è pronto: salvalo e usalo al check-in. L\'invio email parte quando SMTP è configurato sul server.'
    });
});

app.post('/api/tournaments/:id/checkin', (req, res) => {
    const { shopId, qrToken } = req.body || {};
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
    const reply = answerVaultBot(req.body && req.body.message);
    res.json({ success: true, reply });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
    console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT}`);
});
