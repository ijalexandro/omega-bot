// src/index.js
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT,
  SESSION_BUCKET,
  SESSION_FILE
} = process.env;

// Inicializa cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

let whatsappClient, latestQr = null;
let globalCatalog = null;
const processedMessages = new Set(); // Para evitar procesar el mismo mensaje más de una vez

async function loadSession() {
  console.log('📂 Intentando cargar sesión desde Supabase Storage...');
  try {
    const { data, error } = await supabase.storage
      .from(SESSION_BUCKET)
      .download(SESSION_FILE);
    if (error) {
      console.error('❌ Error descargando sesión:', error.message, error.details);
      return null;
    }
    const sessionData = await data.text();
    return JSON.parse(sessionData);
  } catch (err) {
    console.error('❌ Excepción al cargar sesión:', err.message);
    return null;
  }
}

async function saveSession(session) {
  console.log('💾 Intentando guardar sesión en Supabase Storage...', JSON.stringify(session).slice(0, 100) + '...');
  try {
    const { error } = await supabase.storage
      .from(SESSION_BUCKET)
      .upload(SESSION_FILE, JSON.stringify(session), {
        upsert: true,
      });
    if (error) {
      console.error('❌ Error guardando sesión:', error.message, error.details);
    } else {
      console.log('✅ Sesión guardada correctamente en Supabase Storage');
    }
  } catch (err) {
    console.error('❌ Excepción al guardar sesión:', err.message);
  }
}

async function loadGlobalCatalog() {
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

async function initWhatsApp() {
  console.log('📡 Iniciando cliente WhatsApp...');

  // Intentar cargar la sesión existente
  let savedState = await loadSession();
  const { state, saveCreds } = await useMultiFileAuthState(savedState || 'baileys_auth');

  const client = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  client.ev.on('creds.update', async () => {
    console.log('🔄 Credenciales actualizadas, guardando sesión...');
    await saveSession(state);
    await saveCreds();
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('⏳ Esperando 5 segundos antes de reconectar...');
        await new Promise(resolve => setTimeout(resolve, 5000)); // Retraso de 5 segundos
        initWhatsApp();
      }
      console.log('❌ WhatsApp desconectado:', lastDisconnect?.error?.message);
    }
  });

  client.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    const messageId = msg.key.id;

    console.log('📢 Evento messages.upsert recibido para mensaje:', messageId);

    // Evitar procesar el mismo mensaje más de una vez
    if (processedMessages.has(messageId)) {
      console.log('⚠️ Mensaje ya procesado, ignorando:', messageId);
      return;
    }
    processedMessages.add(messageId);

    if (!msg.key.fromMe && msg.message) {
      console.log('📩 Mensaje entrante:', msg.key.remoteJid, msg.message.conversation);

      // Guardar mensaje entrante
      try {
        const { error, data } = await supabase
          .from('mensajes')
          .insert({
            whatsapp_from: msg.key.remoteJid,
            whatsapp_to: msg.key.participant || msg.key.remoteJid,
            texto: msg.message.conversation || '',
            enviado_por_bot: false
          })
          .select();
        if (error) {
          console.error('❌ Error guardando mensaje entrante en DB:', error.message, error.details);
        } else {
          console.log('🗄️ Mensaje entrante guardado en DB correctamente, ID:', data?.[0]?.id);
        }
      } catch (err) {
        console.error('❌ Excepción al guardar mensaje entrante en DB:', err.message);
      }

      // Enviar a n8n
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: msg.key.remoteJid, body: msg.message.conversation || '' })
        });
        console.log('➡️ Mensaje enviado a n8n');
      } catch (err) {
        console.error('❌ Error forward a n8n:', err.message);
      }
    }
  });

  whatsappClient = client;
}

app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('QR no disponible');
  try {
    const img = await QRCode.toBuffer(latestQr);
    res.set('Content-Type', 'image/png');
    res.send(img);
  } catch (err) {
    console.error('Error generando QR PNG:', err);
    res.status(500).send('Error generando imagen QR');
  }
});

app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, { text: body });
    console.log(`✔️ Mensaje enviado a ${to}`);

    // Guardar la respuesta del bot en Supabase
    const { error, data } = await supabase
      .from('mensajes')
      .insert({
        whatsapp_from: to, // El bot envía desde su número
        whatsapp_to: to,
        texto: body,
        enviado_por_bot: true
      })
      .select();
    if (error) {
      console.error('❌ Error guardando respuesta del bot en DB:', error.message, error.details);
    } else {
      console.log('🗄️ Respuesta del bot guardada en DB correctamente, ID:', data?.[0]?.id);
    }

    res.json({ status: 'enviado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/new-message', (req, res) => {
  console.log('🔔 Webhook recibido:', req.body);
  res.sendStatus(200);
});

initWhatsApp().catch(err => console.error('❌ initWhatsApp error:', err));

const port = PORT || 3000;
app.listen(port, () => console.log(`🚀 Server escuchando en puerto ${port}`));
