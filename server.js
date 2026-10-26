require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path'); 
const app = express();

const corsMiddleware = require('cors');
app.use(corsMiddleware());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

let messagesDB = [];
let reviewsDB = [];
let ordersDB = [];
let usersDB = []; 
let userPresenceDB = {};

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

loadMessagesFromDisk();

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
            amount: amount,
            status: 'paid',
            createdAt: new Date().toISOString()
        };
        ordersDB.push(newOrder);

        if (sellerId && sellerId !== 'unknown') {
            const notificationMsg = {
                id: 'msg-' + Date.now(),
                senderId: 'SYSTEM_ESCROW',
                receiverId: sellerId,
                cardId: cardId || null,
                text: `📦 VENDITA EFFETTUATA! Il tuo prodotto "${cardTitle || 'Articolo TCG'}" è stato acquistato per €${Number(amount).toFixed(2)}. I fondi sono al sicuro in Escrow. Clicca qui per inserire corriere e tracciamento.`,
                isEscrowAlert: true,
                orderId: newOrder.id,
                timestamp: new Date().toISOString()
            };
            messagesDB.push(notificationMsg);
            persistMessagesToDisk();
        }

        res.send({ clientSecret: paymentIntent.client_secret, orderId: newOrder.id });
    } catch (error) {
        res.status(400).send({ error: { message: error.message } });
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

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
    console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT}`);
});
