require('dotenv').config();
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
console.log("DEBUG Baileys version:", require('@whiskeysockets/baileys/package.json').version);
console.log("DEBUG typeof useSingleFileAuthState:", typeof useSingleFileAuthState);

const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const path = require('path');

// Variables de entorno
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT,
  SESSION_BUCKET,
  SESSION_FILE
} = process.env;

// Ruta local para el archivo de credenciales de Baileys
const AUTH_FILE = path.join(__dirname, 'baileys_auth.json');

// Cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

let whatsappClient;
let latestQr = null;
let globalCatalog = null;
const processedMessages = new Set();

// Descarga el archivo de auth desde Supabase si existe (MODO BUFFER)
async function ensureAuthFile() {
  try {
    const { data, error } = await supabase.storage
      .from(SESSION_BUCKET)
      .download(SESSION_FILE);
    if (!error && data) {
      // Descargar como arrayBuffer y guardar como Buffer
      const arrayBuffer = await data.arrayBuffer();
      await fs.writeFile(AUTH_FILE, Buffer.from(arrayBuffer));
      console.log('📥 Auth file descargado de Supabase');
    }
  } catch (err) {
    console.log('⚠️ No había auth file en Supabase, se generará uno nuevo');
  }
}

// Carga catálogo global
async function loadGlobalCatalog() {
  console.log('📋 Intentando cargar catálogo global...');
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, nombre, descripcion, precio, tamano, foto_url, categoria');
    if (error) {
      console.error('❌ Error al cargar catálogo global:', error.message);
      return;
    }
    globalCatalog = data;
    console.log('✅ Catálogo global cargado:', data.length, 'productos');
  } catch (err) {
    console.error('❌ Excepción cargando catálogo:', err.message);
  }
}

// Inicializa WhatsApp y Baileys
async function initWhatsApp() {
  console.log('📡 Iniciando WhatsApp...');

  await ensureAuthFile();

  const { state, saveCreds } = useSingleFileAuthState(AUTH_FILE);
  const client = makeWASocket({ auth: state, printQRInTerminal: false });

  client.ev.on('creds.update', async () => {
    await saveCreds();
    try {
      // Leer el archivo como Buffer (sin 'utf8')
      const fileContents = await fs.readFile(AUTH_FILE);
      await supabase.storage.from(SESSION_BUCKET).upload(SESSION_FILE, fileContents, { upsert: true });
      console.log('📤 Auth file subido a Supabase');
    } catch (err) {
      console.error('❌ Error subiendo auth file:', err.message);
    }
  });

  client.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      latestQr = qr;
      console.log('--- QR RECEIVED ---');
      console.log(`🖼️ Escanea aquí: ${BASE_URL}/qr`);
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp listo');
      await loadGlobalCatalog();
    }
    if (connection === 'close') {
      const errMsg = lastDisconnect?.error?.message || 'Unknown';
      console.log('❌ WhatsApp desconectado:', errMsg);
      if (errMsg.includes('Connection Failure')) {
        await fs.unlink(AUTH_FILE).catch(() => {});
        initWhatsApp();
      } else {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) setTimeout(initWhatsApp, 5000);
      }
    }
  });

  client.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    const id = msg.key.id;
    if (processedMessages.has(id)) return;
    processedMessages.add(id);
    if (!msg.key.fromMe && msg.message) {
      console.log('📩 Mensaje de', msg.key.remoteJid);
      try {
        const { error } = await supabase.from('mensajes').insert({
          whatsapp_from: msg.key.remoteJid,
          whatsapp_to: msg.key.participant || msg.key.remoteJid,
          texto: msg.message.conversation || '',
          enviado_por_bot: false
        });
        if (error) console.error('❌ Error guardando:', error.message);
      } catch (e) {
        console.error('❌ Excepción:', e.message);
      }
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: msg.key.remoteJid, body: msg.message.conversation || '' })
        });
        console.log('➡️ Forward a n8n');
      } catch (e) {
        console.error('❌ Error forward n8n:', e.message);
      }
    }
  });

  whatsappClient = client;
}

// Rutas de Express
app.get('/qr', (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  QRCode.toBuffer(latestQr)
    .then(buf => res.type('png').send(buf))
    .catch(err => {
      console.error(err);
      res.status(500).send('Error QR');
    });
});

app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, { text: body });
    await supabase.from('mensajes').insert({ whatsapp_from: to, whatsapp_to: to, texto: body, enviado_por_bot: true });
    res.json({ status: 'enviado' });
  } catch (e) {
    console.error('❌ Error enviando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/webhook/new-message', (_, res) => res.sendStatus(200));

// Arrancar el servidor
try {
  initWhatsApp().catch(e => console.error('❌ init error:', e));
} catch (e) {
  console.error('❌ Error inicializando WhatsApp:', e);
}

const serverPort = PORT || 3000;
app.listen(serverPort, () => console.log(`🚀 Server en puerto ${serverPort}`));

