// src/index.js
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SESSION_BUCKET,
  SESSION_FILE,
  N8N_WEBHOOK_URL,
  PORT
} = process.env;

// Cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Carga/guarda sesión en Storage
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
    .upload(SESSION_FILE, Buffer.from(JSON.stringify(session)), { upsert: true });
  if (error) console.error('Error guardando sesión:', error.message);
}

// Express
const app = express();
app.use(express.json());

// Endpoint para enviar mensajes desde n8n
app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, body);
    return res.json({ status: 'enviado' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Debug: recibe eventos de WhatsApp (opcional)
app.post('/webhook/new-message', (req, res) => {
  console.log('Webhook hit:', req.body);
  res.sendStatus(200);
});

let whatsappClient;
async function initWhatsApp() {
  const sessionData = await getSession();

  // Cliente con sesión legacy
  const client = new Client({ session: sessionData });

  // Mostrar QR en logs (ASCII) para escanear
  client.on('qr', qr => {
    console.log('--- QR RECEIVED ---');
    qrcode.generate(qr, { small: true });
    console.log('Escanea ese código QR con tu WhatsApp.');
  });

  client.on('authenticated', session => {
    console.log('✅ Authenticated, guardando sesión…');
    saveSession(session);
  });
  client.on('auth_failure', msg => console.error('❌ Auth failure:', msg));
  client.on('ready', () => console.log('✅ WhatsApp listo'));
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
app.listen(port, () => console.log(`Server escuchando en puerto ${port}`));
