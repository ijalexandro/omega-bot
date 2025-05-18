// src/index.js
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Client } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SESSION_BUCKET,
  SESSION_FILE,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getSession() {
  const { data, error } = await supabase
    .storage.from(SESSION_BUCKET)
    .download(SESSION_FILE);
  if (error || !data) return null;
  return JSON.parse(await data.text());
}

async function saveSession(session) {
  const { error } = await supabase
    .storage.from(SESSION_BUCKET)
    .upload(SESSION_FILE,
      Buffer.from(JSON.stringify(session)),
      { upsert: true }
    );
  if (error) console.error('Error guardando sesión:', error.message);
}

const app = express();
app.use(express.json());

let whatsappClient;
let latestQr = null;

// Reemplazamos /qr para devolver la imagen PNG
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  try {
    const pngBuffer = await QRCode.toBuffer(latestQr, { type: 'png' });
    res.set('Content-Type', 'image/png');
    return res.send(pngBuffer);
  } catch (err) {
    console.error('Error generando PNG:', err);
    return res.status(500).send('Error generando imagen QR');
  }
});

// Endpoint para que n8n envíe mensajes por WhatsApp
app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, body);
    return res.json({ status: 'enviado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    return res.status(500).json({ error: err.message });
  }
});

// (Opcional) debug de webhooks entrantes
app.post('/webhook/new-message', (req, res) => {
  console.log('Webhook hit:', req.body);
  res.sendStatus(200);
});

async function initWhatsApp() {
  const sessionData = await getSession();
  const client = new Client({ session: sessionData });

  client.on('qr', qr => {
    latestQr = qr;
    // ASCII en consola
    console.log('--- QR RECEIVED ---');
    qrcodeTerminal.generate(qr, { small: true });
    // URL de la imagen QR
    console.log(`Escanea usando: ${BASE_URL}/qr`);
  });

  client.on('authenticated', session => {
    console.log('✅ Authenticated, guardando sesión…');
    saveSession(session);
  });

  client.on('auth_failure', msg => {
    console.error('❌ Auth failure:', msg);
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp listo');
  });

  client.on('message', async msg => {
    console.log('Mensaje entrante:', msg.from, msg.body);
    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: msg.from, body: msg.body })
      });
    } catch (err) {
      console.error('Error forward a n8n:', err.message);
    }
  });

  await client.initialize();
  whatsappClient = client;
}

initWhatsApp();

// Arranca servidor HTTP
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server escuchando en puerto ${port}`);
});
