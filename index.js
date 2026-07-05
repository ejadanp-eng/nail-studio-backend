const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const cron = require('node-cron');

// Initialize Firebase
console.log('Starting Firebase initialization...');
console.log('FIREBASE_SERVICE_ACCOUNT env var exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT);
console.log('admin module keys:', Object.keys(admin).slice(0, 10));
console.log('admin.credential type:', typeof admin.credential);

let serviceAccount;
try {
  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawEnv) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable not found');
  }
  serviceAccount = JSON.parse(rawEnv);
  console.log('✓ Firebase service account parsed successfully');
  console.log('✓ Project ID:', serviceAccount.project_id);
} catch (e) {
  console.error('✗ Error parsing FIREBASE_SERVICE_ACCOUNT:', e.message);
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.cert(serviceAccount),
    projectId: 'viky-nail-studio'
  });
  console.log('✓ Firebase initialized successfully');
} catch (e) {
  console.error('✗ Error initializing Firebase:', e.message);
  process.exit(1);
}
const db = getFirestore();

// Initialize WhatsApp client
const puppeteer = require('puppeteer');
const clientOptions = {
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: puppeteer.executablePath()
  }
};
console.log('Chrome executable path:', puppeteer.executablePath());
const client = new Client(clientOptions);

const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
let latestQrDataUrl = null;
let whatsappReady = false;

client.on('qr', async (qr) => {
  console.log('📱 QR generado. Abre la URL del servicio en tu navegador para escanearlo.');
  qrcode.generate(qr, { small: true });
  try {
    latestQrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
  } catch (e) {
    console.error('Error generando QR imagen:', e.message);
  }
});

client.on('ready', () => {
  console.log('✅ WhatsApp client is ready!');
  whatsappReady = true;
  latestQrDataUrl = null;
  startReminders();
});

client.on('auth_failure', () => {
  console.log('❌ Authentication failed, restarting...');
});

client.on('disconnected', () => {
  console.log('⚠️ Client disconnected');
  process.exit(1);
});

client.initialize();

// Reminder formatter
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  return date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function buildReminderMessage(appt, service, type) {
  const fecha = formatDate(appt.date);
  const tipoMsg = type === '24h' ? 'MAÑANA' : 'EN 1 HORA';

  return `¡Hola ${appt.clientName}! 👋

Recordatorio: Tu cita *${tipoMsg}* en *Viky Nails Studio* 💅

📋 *Detalle:*
• Servicio: ${service?.name}
• Fecha: ${fecha}
• Hora: ${appt.time}
• Duración: ${service?.duration} min
• Total: $${service?.price}

¡Te esperamos! 💅
_Viky Nails Studio_`;
}

// Check and send reminders
async function checkAndSendReminders() {
  try {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const tomorrowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() + 1).padStart(2, '0')}`;

    // Get all appointments
    const snapshot = await db.collection('appointments').get();
    const appointments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    // Get services for reference
    const servicesRef = await db.collection('services').get();
    const services = {};
    servicesRef.docs.forEach(d => { services[d.id] = d.data(); });

    for (const appt of appointments) {
      // Skip if already completed or cancelled
      if (appt.status === 'completed' || appt.status === 'cancelled') continue;

      const [h, m] = appt.time.split(':').map(Number);
      const apptDateTime = new Date(appt.date);
      apptDateTime.setHours(h, m, 0, 0);
      const diffMs = apptDateTime - now;
      const diffHours = diffMs / (1000 * 60 * 60);

      const service = services[appt.serviceId];
      const phoneNumber = `${appt.clientPhone}@c.us`; // WhatsApp format

      // Check if needs 24h reminder
      if (diffHours > 23 && diffHours <= 24) {
        if (!appt.reminder24hSent) {
          console.log(`📱 Sending 24h reminder to ${appt.clientName}`);
          const msg = buildReminderMessage(appt, service, '24h');
          await client.sendMessage(phoneNumber, msg);
          await db.collection('appointments').doc(appt.id).update({ reminder24hSent: true });
        }
      }

      // Check if needs 1h reminder
      if (diffHours > 0.5 && diffHours <= 1) {
        if (!appt.reminder1hSent) {
          console.log(`📱 Sending 1h reminder to ${appt.clientName}`);
          const msg = buildReminderMessage(appt, service, '1h');
          await client.sendMessage(phoneNumber, msg);
          await db.collection('appointments').doc(appt.id).update({ reminder1hSent: true });
        }
      }
    }
  } catch (error) {
    console.error('❌ Error checking reminders:', error);
  }
}

// Start reminder system
function startReminders() {
  // Check every minute
  cron.schedule('* * * * *', () => {
    console.log(`⏰ Checking reminders at ${new Date().toLocaleString()}`);
    checkAndSendReminders();
  });
}

// Health check endpoint (for Render)
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    // Página principal: muestra el QR de WhatsApp o el estado
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    let body;
    if (whatsappReady) {
      body = `<div style="text-align:center;font-family:sans-serif;padding:40px">
        <h1 style="color:#25D366">✅ WhatsApp conectado</h1>
        <p>El sistema de recordatorios está activo.</p>
      </div>`;
    } else if (latestQrDataUrl) {
      body = `<div style="text-align:center;font-family:sans-serif;padding:40px">
        <h1>📱 Escanea con WhatsApp</h1>
        <p>Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
        <img src="${latestQrDataUrl}" alt="QR" style="width:400px;max-width:90%"/>
        <p style="color:#888">La página se refresca sola cada 20s</p>
      </div>
      <script>setTimeout(()=>location.reload(),20000)</script>`;
    } else {
      body = `<div style="text-align:center;font-family:sans-serif;padding:40px">
        <h1>⏳ Iniciando...</h1>
        <p>Generando código QR, espera unos segundos.</p>
      </div>
      <script>setTimeout(()=>location.reload(),5000)</script>`;
    }
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nail Studio - WhatsApp</title></head><body>${body}</body></html>`);
  }
}).listen(process.env.PORT || 3000);

console.log('🚀 Backend iniciado...');
