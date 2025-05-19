require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const path = require('path');

// Variables de entorno
envirovars();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT,
  SESSION_BUCKET,
  SESSION_FILE
} = process.env;

// Fichero local de autenticación de Baileys
envirovars = () => {};
const AUTH_FILE = path.join(__dirname, 'baileys_auth.json');

// Inicializa cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

let whatsappClient, latestQr = null;
let globalCatalog = null;
const processedMessages = new Set(); // Para evitar duplicados

// Descarga el archivo de auth desde Supabase si existe\async function ensureAuthFile() {
  try {
    const { data, error } = await supabase.storage
      .from(SESSION_BUCKET)
      .download(SESSION_FILE);
    if (!error && data) {
      const contents = await data.text();
      await fs.writeFile(AUTH_FILE, contents, 'utf8');
      console.log('📥 Auth file descargado de Supabase');
    }
  } catch (err) {
    console.log('⚠️ No había auth file en Supabase, se generará uno nuevo');
  }
}

// Carga catálogo global\async function loadGlobalCatalog() {
  console.log('📋 Intentando cargar catálogo global...');
  try {
    const { data, error } = await supabase
      .from('productos')
      .select('id, nombre, descripcion, precio, tamano, foto_url, categoria');
    if (error) {
      console.error('❌ Error al cargar el catálogo global:', error.message);
      return null;
    }
    globalCatalog = data;
    console.log('✅ Catálogo global cargado correctamente:', data.length, 'productos');
    return data;
  } catch (err) {
    console.error('❌ Excepción al cargar el catálogo global:', err.message);
    return null;
  }
}

// Inicialización de WhatsApp\async function initWhatsApp() {
  console.log('📡 Iniciando cliente WhatsApp...');

  // Asegura que exista el archivo de credenciales local\await ensureAuthFile();

  // Usa Baileys con un único archivo de auth
  const { state, saveCreds } = useSingleFileAuthState(AUTH_FILE);
  
  const client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  // Cada vez que las credenciales cambian, persístelas localmente y en Supabase
  client.ev.on('creds.update', async () => {
    await saveCreds();
    try {
      const file = await fs.readFile(AUTH_FILE, 'utf8');
      await supabase.storage
        .from(SESSION_BUCKET)
        .upload(SESSION_FILE, file, { upsert: true });
      console.log('📤 Auth file subido a Supabase');
    } catch (err) {
      console.error('❌ Error subiendo auth file a Supabase', err.message);
    }
  });

  client.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      latestQr = qr;
      console.log('--- QR RECEIVED ---');
      console.log(`🖼️ Escanea en tu navegador: ${BASE_URL}/qr`);
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp listo');
      await loadGlobalCatalog();
    }
    if (connection === 'close') {
      const errMsg = lastDisconnect?.error?.message || 'Unknown error';
      console.log('❌ WhatsApp desconectado:', errMsg);
      if (errMsg.includes('Connection Failure')) {
        console.log('⚠️ Fallo de conexión, reiniciando auth...');
        await fs.unlink(AUTH_FILE).catch(() => {});
        initWhatsApp();
      } else {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('⏳ Reconectando en 5s...');
          setTimeout(initWhatsApp, 5000);
        }
      }
    }
  });

  client.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    const messageId = msg.key.id;
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);
    if (!msg.key.fromMe && msg.message) {
      console.log('📩 Mensaje entrante:', msg.key.remoteJid);
      // Guardar en DB
      try {
        const { error, data } = await supabase
          .from('mensajes')
          .insert({
            whatsapp_from: msg.key.remoteJid,
            whatsapp_to: msg.key.participant || msg.key.remoteJid,
            texto: msg.message.conversation || '',
            enviado_por_bot: false
          });
        if (error) console.error('❌ Error guardando mensaje:', error.message);
      } catch (err) {
        console.error('❌ Excepción guardando mensaje:', err.message);
      }
      // Forward a n8n
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: msg.key.remoteJid, body: msg.message.conversation || '' })
        });
        console.log('➡️ Mensaje enviado a n8n');
      } catch (err) {
        console.error('❌ Error forwarding a n8n:', err.message);
      }
    }
  });

  whatsappClient = client;
}

// Ruta para mostrar el QR\app.get('/qr', (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  QRCode.toBuffer(latestQr)
    .then(buffer => {
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    })
    .catch(err => {
      console.error('Error generando QR:', err.message);
      res.status(500).send('Error generando QR');
    });
});

// Endpoint para enviar mensajes manualmente
app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, { text: body });
    await supabase.from('mensajes').insert({ whatsapp_from: to, whatsapp_to: to, texto: body, enviado_por_bot: true });
    res.json({ status: 'enviado' });
  } catch (err) {
    console.error('❌ Error enviando mensaje:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook para nuevos mensajes (opcional)
app.post('/webhook/new-message', (_, res) => res.sendStatus(200));

// Arranca todo
initWhatsApp().catch(err => console.error('❌ initWhatsApp error:', err));

const port = PORT || 3000;
app.listen(port, () => console.log(`🚀 Server escuchando en puerto ${port}`));
