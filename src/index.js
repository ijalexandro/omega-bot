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
    .upload(SESSION_FILE, Buffer.from(JSON.stringify(session)), { upsert: true });
  if (error) console.error('Error guardando sesión:', error.message);
}

const app = express();
app.use(express.json());

let whatsappClient;
let latestQr = null;

// Endpoint que devuelve la imagen PNG del QR
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  try {
    const pngBuffer = await QRCode.toBuffer(latestQr, { type: 'png' });
    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err) {
    console.error('Error generando PNG:', err);
    res.status(500).send('Error generando imagen QR');
  }
});

// Endpoint para enviar mensajes desde n8n
app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, body);
    res.json({ status: 'enviado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

// (Opcional) endpoint de debug de mensajes
app.post('/webhook/new-message', (req, res) => {
  console.log('Webhook hit:', req.body);
  res.sendStatus(200);
});

async function initWhatsApp() {
  console.log('📡 Iniciando WhatsApp client...');
  const sessionData = await getSession();
  const client = new Client({
    session: sessionData,
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', qr => {
    latestQr = qr;
    console.log('--- QR RECEIVED ---');
    qrcodeTerminal.generate(qr, { small: true });
    console.log(`Escanea aquí (imagen PNG): ${BASE_URL}/qr`);
  });

  client.on('authenticated', session => {
    console.log('✅ Authenticated, guardando sesión…');
    saveSession(session);
  });

  client.on('auth_failure', msg => {
    console.error('❌ Auth failure:', msg);
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando WhatsApp ${percent}% - ${message}`);
  });

  client.on('change_state', state => {
    console.log(`🔄 Estado cambiado a: ${state}`);
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp listo');
  });

  client.on('disconnected', reason => {
    console.log('❌ WhatsApp desconectado:', reason);
  });

  client.on('message', async msg => {
    console.log('📩 Mensaje entrante:', msg.from, msg.body);
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

  try {
    await client.initialize();
  } catch (err) {
    console.error('❌ Error initializing WhatsApp client:', err);
  }
  whatsappClient = client;
}

// Arranca la inicialización y captura errores
initWhatsApp().catch(err => console.error('Error en initWhatsApp:', err));

// Levanta servidor HTTP
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server escuchando en puerto ${port}`);
});
