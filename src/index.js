// src/index.js
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SESSION_BUCKET,
  SESSION_FILE,
  N8N_WEBHOOK_URL,
  PORT
} = process.env;

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Funciones para sesión
async function getSession() {
  const { data, error } = await supabase
    .storage.from(SESSION_BUCKET)
    .download(SESSION_FILE);
  if (error || !data) return null;
  const text = await data.text();
  return JSON.parse(text);
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

// Endpoint para que n8n envíe mensajes
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

// (Opcional) endpoint de debug
app.post('/webhook/new-message', (req, res) => {
  console.log('Webhook hit:', req.body);
  res.sendStatus(200);
});

let whatsappClient;
async function initWhatsApp() {
  // Saneamos el clientId (solo alfanumérico, underscores o guiones)
  const rawId = SESSION_FILE || 'omega_session';
  const clientId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');

  const sessionData = await getSession();
  whatsappClient = new Client({
    authStrategy: new LocalAuth({ clientId }),
    session: sessionData
  });

  whatsappClient.on('authenticated', session => saveSession(session));
  whatsappClient.on('auth_failure', msg => console.error('Auth failure:', msg));
  whatsappClient.on('ready', () => console.log('WhatsApp listo'));
  whatsappClient.on('message', async msg => {
    console.log('Mensaje entrante:', msg.from, msg.body);
    // Forward a n8n
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

  await whatsappClient.initialize();
}

initWhatsApp();

// Arrancamos servidor HTTP
const port = PORT || 3000;
app.listen(port, () => console.log(`Server escuchando en puerto ${port}`));
