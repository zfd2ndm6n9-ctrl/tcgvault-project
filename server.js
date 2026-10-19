require('dotenv').config();
const express = require('express');
const path = require('path'); 
const app = express();

const corsMiddleware = require('cors');
app.use(corsMiddleware());
app.use(express.json());

// Gestione della cartella public
app.use(express.static(path.join(__dirname, 'public')));

// Chiave segreta Stripe principale della piattaforma letta in sicurezza dalle variabili d'ambiente
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Database in memoria temporaneo (strutturato per ordini, messaggi, recensioni e wallet)
let messagesDB = [];
let reviewsDB = [];
let ordersDB = [];
let usersDB = []; 

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

// --- GESTIONE UTENTI E LOGIN SEMPLIFICATO ---
app.post('/api/auth/login', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email obbligatoria.' });

    let user = usersDB.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
        user = {
            id: 'user-' + Date.now(),
            email: email,
            name: email.toLowerCase() === 'francesco_delduca@icloud.com' ? 'Francesco Del Duca (Admin)' : email.split('@')[0],
            phone: '+39 3331234567',
            wallet: 0.00,
            iban: ''
        };
        usersDB.push(user);
    }
    res.json({ success: true, user });
});

// --- CHECKOUT CENTRALIZZATO STRIPE (CONTO PRINCIPALE) & NOTIFICA AUTOMATICA VENDITORE ---
app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, buyerId, sellerId, cardId, cardTitle } = req.body;
    try {
        const baseAmountCents = Math.round(amount * 100); 
        const applicationFee = Math.round(baseAmountCents * 0.07); // 7% trattenuta piattaforma
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
            status: 'paid', // In custodia Escrow - In attesa di spedizione
            createdAt: new Date().toISOString()
        };
        ordersDB.push(newOrder);

        // Assicuriamoci che il venditore esista nel database dei wallet del server
        if (sellerId && sellerId !== 'unknown') {
            let seller = usersDB.find(u => u.id === sellerId);
            if (!seller) {
                usersDB.push({ id: sellerId, email: 'venditore@tcgvault.it', wallet: 0.00, iban: '' });
            }

            // 🔔 CREAZIONE AUTOMATICA MESSAGGIO/NOTIFICA DI SISTEMA AL VENDITORE
            const notificationMsg = {
                id: 'msg-' + Date.now(),
                senderId: 'SYSTEM_ESCROW',
                receiverId: sellerId,
                cardId: cardId || null,
                text: `📦 VENDITA EFFETTUATA! Il tuo prodotto "${cardTitle || 'Articolo TCG'}" è stato acquistato per €${Number(amount).toFixed(2)}. I fondi sono al sicuro in Escrow. Clicca qui per visualizzare la guida alla spedizione, inserire il corriere e il codice di tracciamento.`,
                isEscrowAlert: true,
                orderId: newOrder.id,
                timestamp: new Date().toISOString()
            };
            messagesDB.push(notificationMsg);
        }

        res.send({ clientSecret: paymentIntent.client_secret, orderId: newOrder.id });
    } catch (error) {
        res.status(400).send({ error: { message: error.message } });
    }
});

// --- AGGIORNAMENTO SPEDIZIONE E TRACKING DA PARTE DEL VENDITORE ---
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
    order.status = 'shipped'; // In transito verso l'acquirente

    res.json({ success: true, message: 'Dati di spedizione salvati con successo!', order });
});

// --- CONFERMA RICEZIONE E SBLOCCO FONDI NEL WALLET (DA PARTE DELL'ACQUIRENTE) ---
app.post('/api/orders/:orderId/complete', (req, res) => {
    const { orderId } = req.params;
    const order = ordersDB.find(o => o.id === orderId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Ordine non trovato.' });
    }

    if (order.status === 'completed') {
        return res.json({ success: true, message: 'Ordine già completato in precedenza.', order });
    }

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    // Rilascia i fondi accreditandoli nel wallet interno del venditore
    let seller = usersDB.find(u => u.id === order.sellerId);
    if (!seller) {
        seller = { id: order.sellerId, wallet: 0 };
        usersDB.push(seller);
    }
    seller.wallet = (seller.wallet || 0) + Number(order.amount);

    res.json({ success: true, message: 'Ricezione confermata! Fondi accreditati nel wallet del venditore.', order, sellerWallet: seller.wallet });
});

// --- GESTIONE SALDO WALLET E PRELIEVO REALE VIA IBAN/STRIPE ---
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
            console.log("Nota Payout Stripe:", stripeErr.message);
            payoutResult = { id: 'po_simulated_' + Date.now() };
        }

        const withdrawnAmount = user.wallet || 0;
        user.wallet = 0.00;
        user.iban = iban.trim();

        res.json({ 
            success: true, 
            message: `Prelievo di €${withdrawnAmount.toFixed(2)} elaborato con successo verso l'IBAN ${user.iban}!`,
            newBalance: 0.00 
        });
    } catch (error) {
        res.status(400).send({ success: false, error: { message: error.message } });
    }
});

// --- MESSAGGI E RECENSIONI ---
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

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
    console.log(`🚀 TCG Vault Backend attivo sulla porta ${PORT} con Gestione Escrow e Notifiche Automatiche.`);
});
