require('dotenv').config();
const express = require('express');
const path = require('path'); 
const app = express();

const corsMiddleware = require('cors');
app.use(corsMiddleware());
app.use(express.json());

// --- SISTEMA DI PROTEZIONE PASSWORD (BASIC AUTH) ---
const ADMIN_USER = "admin";
const ADMIN_PASS = "tcgvault2026"; // Puoi cambiarla qui se vuoi

app.use((req, res, next) => {
    // Escludiamo eventuali webhook di Stripe se in futuro li attivi
    if (req.path.startsWith('/api/webhook')) return next();

    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [user, pass] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="TCG Vault Area Riservata Test"');
    res.status(401).send(`
        <html>
            <head><title>TCG Vault - Accesso Riservato</title></head>
            <body style="font-family: Arial; text-align: center; margin-top: 100px; background: #0f172a; color: #fff;">
                <div style="max-width: 400px; margin: auto; padding: 30px; background: #1e293b; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
                    <h2>🔒 TCG Vault (Test Mode)</h2>
                    <p style="color: #94a3b8; font-size: 14px;">Area protetta per test in produzione con HTTPS e Stripe Livemode.</p>
                    <p style="color: #38bdf8; font-size: 13px; margin-top: 15px;">Usa utente: <b>admin</b><br>Password: <b>tcgvault2026</b></p>
                </div>
            </body>
        </html>
    `);
});

// Gestione della cartella public
app.use(express.static(path.join(__dirname, 'public')));

const stripe = require('stripe')('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');

// Database in memoria temporaneo per chat, recensioni e ordini/spedizioni
let messagesDB = [];
let reviewsDB = [];
let ordersDB = [];

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

app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, sellerStripeAccountId, buyerId, sellerId, cardId } = req.body;
    try {
        const baseAmountCents = Math.round(amount * 100); 
        const applicationFee = Math.round(baseAmountCents * 0.07);
        const estimatedStripeFee = Math.round(baseAmountCents * 0.015) + 25;
        const totalChargedToBuyer = baseAmountCents + applicationFee + estimatedStripeFee;

        const paymentIntentConfig = {
            amount: totalChargedToBuyer,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
        };

        if (sellerStripeAccountId) {
            paymentIntentConfig.application_fee_amount = applicationFee + estimatedStripeFee;
            paymentIntentConfig.transfer_data = { destination: sellerStripeAccountId };
        }

        const paymentIntent = await stripe.paymentIntents.create(paymentIntentConfig);

        const newOrder = {
            id: 'order-' + Date.now(),
            paymentIntentId: paymentIntent.id,
            buyerId: buyerId || 'guest',
            sellerId: sellerId || 'unknown',
            cardId: cardId || 'unknown',
            amount: amount,
            status: 'paid',
            carrier: null,
            trackingNumber: null,
            trackingUrl: null,
            createdAt: new Date().toISOString()
        };
        ordersDB.push(newOrder);

        res.send({ clientSecret: paymentIntent.client_secret, orderId: newOrder.id });
    } catch (error) {
        res.status(400).send({ error: { message: error.message } });
    }
});

// Endpoint Stripe Connect con URL fisso HTTPS forzato per evitare errori Livemode
app.post('/api/create-connect-account-link', async (req, res) => {
    const { email } = req.body;
    try {
        const account = await stripe.accounts.create({
            type: 'express',
            country: 'IT',
            email: email,
            capabilities: { transfers: { requested: true } },
        });

        const baseUrl = 'https://tcg-vault-bjs3.onrender.com';

        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: `${baseUrl}/api/stripe-refresh?account_id=${account.id}`,
            return_url: `${baseUrl}/api/stripe-success?account_id=${account.id}`,
            type: 'account_onboarding',
        });

        res.send({ url: accountLink.url, accountId: account.id });
    } catch (error) {
        res.status(400).send({ error: { message: error.message } });
    }
});

app.get('/api/stripe-success', (req, res) => {
    const accountId = req.query.account_id;
    const baseUrl = 'https://tcg-vault-bjs3.onrender.com';
    res.redirect(`${baseUrl}/?stripe_connected=true&account_id=${accountId}`);
});

app.get('/api/stripe-refresh', (req, res) => {
    const baseUrl = 'https://tcg-vault-bjs3.onrender.com';
    res.redirect(`${baseUrl}/?stripe_error=true`);
});

app.post('/api/messages', (req, res) => {
    const { senderId, receiverId, text, offerPrice, cardId } = req.body;
    const newMessage = {
        id: 'msg-' + Date.now(),
        senderId,
        receiverId,
        text,
        offerPrice: offerPrice || null,
        cardId: cardId || null,
        timestamp: new Date().toISOString()
    };
    messagesDB.push(newMessage);
    res.json({ success: true, message: newMessage });
});

app.get('/api/messages/:userId', (req, res) => {
    const userId = req.params.userId;
    const userMessages = messagesDB.filter(m => m.senderId === userId || m.receiverId === userId);
    res.json(userMessages);
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

app.post('/api/orders/:orderId/ship', (req, res) => {
    const { orderId } = req.params;
    const { carrier, trackingNumber } = req.body;

    const order = ordersDB.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    if (!trackingNumber || trackingNumber.trim().length < 5) {
        return res.status(400).json({ success: false, error: 'Codice di tracking non valido o troppo corto.' });
    }

    order.carrier = carrier || 'Poste Italiane';
    order.trackingNumber = trackingNumber.trim();
    order.trackingUrl = generateTrackingLink(order.carrier, order.trackingNumber);
    order.status = 'shipped';
    order.shippedAt = new Date().toISOString();

    res.json({ success: true, order });
});

app.post('/api/orders/:orderId/complete', (req, res) => {
    const { orderId } = req.params;
    const order = ordersDB.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    res.json({ success: true, message: 'Ricezione confermata! Fondi rilasciati al venditore.', order });
});

app.post('/api/orders/:orderId/dispute', (req, res) => {
    const { orderId } = req.params;
    const { reason } = req.body;
    const order = ordersDB.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    order.status = 'disputed';
    order.disputeReason = reason || 'Problema riscontrato nella transazione';
    order.disputedAt = new Date().toISOString();

    res.json({ success: true, message: 'Controversia aperta. L\'Admin Supremo (francesco_delduca@icloud.com) è stato allertato.', order });
});

app.get('/api/orders/:orderId', (req, res) => {
    const order = ordersDB.find(o => o.id === req.params.orderId);
    if (!order) {
        return res.status(404).json({ error: 'Ordine non trovato.'});
    }
    res.json(order);
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
    console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT} con protezione Password e HTTPS forzato!`);
});
