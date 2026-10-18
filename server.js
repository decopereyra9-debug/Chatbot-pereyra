// Chatbot de WhatsApp (Cloud API de Meta + Gemini). Sin dependencias.
const http = require("http");

// ====== 1) EDITA ESTO CON LOS DATOS DEL NEGOCIO ======
const NEGOCIO = {
  nombre: "Decoraciones PEREYRA",
  descripcion: "Hacemos bonita tu fiesta. Decoración para todo tipo de eventos: decoración con globos, mesas de dulces, centros de mesa, y decoración para cumpleaños, bodas, XV años, bautizos y más. Ubicados en Jalapa, Tabasco.",
  zonaHoraria: "America/Mexico_City",
  dias: [0, 1, 2, 3, 4, 5, 6], // lunes a domingo
  desde: 8,                    // 8:00 AM
  hasta: 20,                   // 8:00 PM
  textoHorario: "Lunes a domingo de 8:00 AM a 8:00 PM",
  faqs: `
- ¿Qué servicios ofrecen? -> Decoración con globos, mesas de dulces, centros de mesa, y decoración para cumpleaños, bodas, XV años, bautizos y más.
- ¿Dónde están ubicados? -> Jalapa, Tabasco.
- ¿Cuál es su horario? -> Lunes a domingo de 8:00 AM a 8:00 PM.
- ¿Cuánto cuesta? -> No tienes precios cargados. Responde que un asesor enviará la cotización y usa [HUMANO].
- ¿Qué métodos de pago aceptan? -> No tienes esta información. Usa [HUMANO].
- ¿Hacen envíos o instalan a domicilio? -> No tienes esta información. Usa [HUMANO].
`,
  mensajeCierre:
    "¡Hola! Gracias por escribir a Decoraciones PEREYRA. Ahora estamos fuera de horario " +
    "(atendemos de lunes a domingo de 8:00 AM a 8:00 PM). Déjanos tu nombre y el tipo de evento " +
    "que tienes en mente, y te respondemos en cuanto abramos.",
  bienvenida:
    "¡Buenos días! 👋 Bienvenido al WhatsApp de Decoraciones PEREYRA. Hacemos bonita tu fiesta. " +
    "Cuéntame, ¿qué tipo de evento tienes en mente?",
  mensajeHumano:
    "Con gusto. Un asesor te contactará en cuanto esté disponible. Mientras tanto, ¿me dejas tu nombre?",
};
// =====================================================

const {
  WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, GEMINI_API_KEY,
  OWNER_NUMBER, // opcional: tu número personal (con código de país) para avisos
  GEMINI_MODEL = "gemini-2.0-flash",
  GRAPH_VERSION = "v21.0",
  PORT = 3000,
} = process.env;

const SYSTEM = `Eres el asistente virtual de WhatsApp de "${NEGOCIO.nombre}". ${NEGOCIO.descripcion}
Horario de atención: ${NEGOCIO.textoHorario}.
Reglas:
- Responde en español, con tono amable y breve (máximo 3-4 frases).
- Usa SOLO la información de abajo. Si no tienes el dato, no inventes: responde exactamente con la marca [HUMANO] al final de tu mensaje y di que un asesor lo atenderá.
- Si el cliente pide hablar con una persona, quiere comprar/agendar algo que no puedes completar o está molesto, añade [HUMANO].
- Nunca des precios o promesas que no estén en la información.
Información del negocio:
${NEGOCIO.faqs}`;

const historial = new Map();   // número -> últimos turnos
const vistos = new Set();      // ids de mensaje ya procesados
const cierreEnviado = new Map(); // número -> timestamp del último aviso de cierre
const conocidos = new Set();     // números que ya recibieron la bienvenida

function dentroDeHorario() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: NEGOCIO.zonaHoraria, weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(new Date());
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const d = dias[p.find((x) => x.type === "weekday").value];
  const h = parseInt(p.find((x) => x.type === "hour").value, 10);
  return NEGOCIO.dias.includes(d) && h >= NEGOCIO.desde && h < NEGOCIO.hasta;
}

async function enviar(to, text) {
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!r.ok) console.error("Error enviando:", r.status, await r.text());
}

async function preguntarIA(numero, texto) {
  const h = historial.get(numero) || [];
  h.push({ role: "user", parts: [{ text: texto }] });
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: h }),
    }
  );
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) { console.error("Error IA:", JSON.stringify(data)); return "[HUMANO]"; }
  h.push({ role: "model", parts: [{ text: out }] });
  historial.set(numero, h.slice(-8));
  return out;
}

async function procesar(msg) {
  if (vistos.has(msg.id)) return;
  vistos.add(msg.id);
  if (vistos.size > 5000) vistos.clear();

  const numero = msg.from;
  if (msg.type !== "text") {
    return enviar(numero, "Por ahora solo puedo leer mensajes de texto. ¿Me escribes tu consulta?");
  }
  const texto = msg.text.body;
  console.log(`[${new Date().toISOString()}] ${numero}: ${texto}`);

  if (!dentroDeHorario()) {
    const ultimo = cierreEnviado.get(numero) || 0;
    if (Date.now() - ultimo > 12 * 3600 * 1000) {
      cierreEnviado.set(numero, Date.now());
      await enviar(numero, NEGOCIO.mensajeCierre);
    }
    console.log(`LEAD FUERA DE HORARIO ${numero}: ${texto}`);
    return;
  }

  if (!conocidos.has(numero)) {
    conocidos.add(numero);
    await enviar(numero, NEGOCIO.bienvenida);
    const soloSaludo = texto.length < 40 && /^\s*(hola|buenos|buenas|hey|info|quiero informaci)/i.test(texto);
    if (soloSaludo) return;
  }

  let respuesta = await preguntarIA(numero, texto);
  const escalar = respuesta.includes("[HUMANO]");
  respuesta = respuesta.replace("[HUMANO]", "").trim() || NEGOCIO.mensajeHumano;
  await enviar(numero, respuesta);
  if (escalar) {
    console.log(`ESCALAR A HUMANO ${numero}: ${texto}`);
    if (OWNER_NUMBER) await enviar(OWNER_NUMBER, `Cliente ${numero} necesita atención: "${texto}"`);
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/webhook") {
    if (url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      res.writeHead(200); return res.end(url.searchParams.get("hub.challenge"));
    }
    res.writeHead(403); return res.end();
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200); res.end("ok");
      try {
        const msgs = JSON.parse(body)?.entry?.[0]?.changes?.[0]?.value?.messages || [];
        msgs.forEach((m) => procesar(m).catch((e) => console.error(e)));
      } catch (e) { console.error(e); }
    });
    return;
  }
  res.writeHead(200); res.end("Bot activo");
}).listen(PORT, () => console.log("Bot escuchando en puerto " + PORT));
