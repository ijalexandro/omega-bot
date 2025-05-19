// src/index.js
require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
 
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  N8N_WEBHOOK_URL,
  BASE_URL,
  PORT
} = process.env;

// Inicializa cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(express.json());

let whatsappClient, latestQr = null;

// 1) Devuelve la imagen PNG del QR
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

// 2) Endpoint para que n8n envíe mensajes
app.post('/send-message', async (req, res) => {
  const { to, body } = req.body;
  if (!whatsappClient) return res.status(503).send('WhatsApp no inicializado');
  try {
    await whatsappClient.sendMessage(to, body);
    console.log(`✔️  Mensaje enviado a ${to}`);
    res.json({ status: 'enviado' });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3) (Opcional) debug de webhooks entrantes
app.post('/webhook/new-message', (req, res) => {
  console.log('🔔 Webhook recibido:', req.body);
  res.sendStatus(200);
});

async function initWhatsApp() {
  console.log('📡 Iniciando cliente WhatsApp...');
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'omega-bot' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  // Mostrar QR ASCII y exponer URL de imagen
  client.on('qr', qr => {
    latestQr = qr;
    console.log('--- QR RECEIVED ---');
    qrcodeTerminal.generate(qr, { small: true });
    console.log(`🖼️  Escanea en tu navegador: ${BASE_URL}/qr`);
  });

  client.on('authenticated', () => {
    console.log('✅  Autenticado correctamente');
  });

  client.on('auth_failure', msg => console.error('❌  Auth failure:', msg));

  client.on('ready', () => {
    console.log('✅  WhatsApp listo');
  });

  client.on('disconnected', reason => {
    console.log('❌  WhatsApp desconectado:', reason);
  });

  client.on('change_state', state => {
    console.log('🔄  Estado cambiado a:', state);
  });

  // Manejo de mensajes entrantes
  client.on('message', async msg => {
    console.log('📩  Mensaje entrante:', msg.from, msg.body);

    // 4) Guarda en la tabla mensajes
    try {
      const { error } = await supabase
        .from('mensajes')
        .insert({
          whatsapp_from: msg.from,
          whatsapp_to: msg.to || '',
          texto: msg.body,
          enviado_por_bot: false
        });
      if (error) console.error('❌  Error guardando en DB:', error.message);
      else console.log('🗄️  Mensaje guardado en DB');
    } catch (err) {
      console.error('❌  Excepción al guardar en DB:', err);
    }

    // 5) Forward a n8n
    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: msg.from, body: msg.body })
      });
      console.log('➡️  Mensaje enviado a n8n');
    } catch (err) {
      console.error('❌  Error forward a n8n:', err.message);
    }
  });

  await client.initialize();
  whatsappClient = client;
}

initWhatsApp().catch(err => console.error('❌  initWhatsApp error:', err));

const port = PORT || 3000;
app.listen(port, () => console.log(`🚀  Server escuchando en puerto ${port}`));
