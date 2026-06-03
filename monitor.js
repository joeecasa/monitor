// ============================================================
//  Monitor de entradas M86 — Argentina en Miami, 3 julio 2026
//  Scraping de fifacollect.info con Puppeteer + alerta por email
//
//  Instalación:
//    npm install puppeteer nodemailer
//
//  Uso:
//    node monitor-m86.js
// ============================================================

const puppeteer = require("puppeteer");
const { Resend } = require("resend");
const { google } = require("googleapis");
const fs = require("fs");
require("dotenv").config();

// ──────────────────────────────────────────────
//  CONFIGURACIÓN
// ──────────────────────────────────────────────
const CONFIG = {
  PRECIO_MAXIMO: 1500,
  INTERVALO_MINUTOS: 5,
  HORA_RESUMEN: 23,
  CATEGORIAS: ["CAT4","CAT3", "CAT2", "CAT1"],
  EMAIL: {
    usuario: "j.casa.marquez@gmail.com",
    password: process.env.GMAIL_PASSWORD,
    destinatario: "j.casa.marquez@gmail.com",
  },
};
// ──────────────────────────────────────────────

const URL = "https://www.fifacollect.info/tickets/world-cup-2026/listings";
const MATCH_ID = "M86";

const C = {
  verde:    "\x1b[32m",
  rojo:     "\x1b[31m",
  amarillo: "\x1b[33m",
  cyan:     "\x1b[36m",
  bold:     "\x1b[1m",
  reset:    "\x1b[0m",
};

function ahoraAR() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
}

function log(msg, color = C.reset) {
  const hora = ahoraAR().toLocaleTimeString("es-AR", { hour12: false });
  console.log(`${C.cyan}[${hora}]${C.reset} ${color}${msg}${C.reset}`);
}

function parsePrecio(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

const SHEET_ID = "16Rj3LfZkU-eWC2wd6FP3if3nPu32O6-Q-VB36_hGHwY";

async function getSheetsClient() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON
    ? process.env.GOOGLE_CREDENTIALS_JSON
    : Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, "base64").toString();
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function inicializarSheet() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A1",
  });
  if (!res.data.values) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "A1",
      valueInputOption: "RAW",
      resource: { values: [["Fecha", "Hora", "CAT4", "CAT3", "CAT2", "CAT1"]] },
    });
  }
}

async function escribirEnSheets(precios) {
  const ahora = ahoraAR();
  const fecha = ahora.toLocaleDateString("es-AR");
  const hora = ahora.toLocaleTimeString("es-AR", { hour12: false });
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "A:F",
    valueInputOption: "RAW",
    resource: {
      values: [[fecha, hora, precios.CAT4 ?? "", precios.CAT3 ?? "", precios.CAT2 ?? "", precios.CAT1 ?? ""]],
    },
  });
}

const HISTORIAL_FILE = "historial.json";

function cargarHistorial() {
  try {
    if (fs.existsSync(HISTORIAL_FILE))
      return JSON.parse(fs.readFileSync(HISTORIAL_FILE, "utf8"));
  } catch {}
  return {};
}

function guardarHistorial(h) {
  fs.writeFileSync(HISTORIAL_FILE, JSON.stringify(h, null, 2));
}

let historial = cargarHistorial();
let resumenEnviadoHoy = null;

async function registrarPrecios(precios) {
  const ahora = ahoraAR();
  const fecha = ahora.toLocaleDateString("es-AR");
  const hora = ahora.toLocaleTimeString("es-AR", { hour12: false });
  if (!historial[fecha]) historial[fecha] = [];
  historial[fecha].push({ hora, ...precios });
  guardarHistorial(historial);
  try {
    await escribirEnSheets(precios);
    log("Sheets actualizado", C.cyan);
  } catch (err) {
    log(`Error Sheets: ${err.message}`, C.rojo);
  }
}

async function enviarNtfy(cat, precio) {
  const link = `https://collect.fifa.com/marketplace?tags=${cat.toLowerCase()}-m86`;
  await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      "Title": `ALERTA M86 - ${cat} a $${precio} USD`,
      "Priority": "urgent",
      "Tags": "soccer,rotating_light",
      "Click": link,
    },
    body: `${cat} a $${precio} USD — por debajo de $${CONFIG.PRECIO_MAXIMO}. Toca para comprar.`,
  });
  log(`Ntfy enviado`, C.verde);
}

async function enviarEmail(cat, precio) {
  const link = `https://collect.fifa.com/marketplace?tags=${cat.toLowerCase()}-m86`;
  const resend = new Resend(process.env.RESEND_API_KEY);

  await resend.emails.send({
    from: "Monitor M86 <onboarding@resend.dev>",
    to: CONFIG.EMAIL.destinatario,
    subject: `ALERTA M86 Miami — ${cat} a $${precio} USD`,
    html: `
      <h2>Entrada M86 por debajo de tu umbral</h2>
      <p><strong>Partido:</strong> M86 — Round of 32, Miami (3 julio 2026)</p>
      <p><strong>Categoria:</strong> ${cat}</p>
      <p><strong>Precio actual:</strong> $${precio} USD</p>
      <p><strong>Tu umbral:</strong> $${CONFIG.PRECIO_MAXIMO} USD</p>
      <p><a href="${link}" style="font-size:18px;font-weight:bold;">COMPRAR AHORA</a></p>
    `,
  });

  log(`Email enviado a ${CONFIG.EMAIL.destinatario}`, C.verde);
}

async function enviarResumen(fecha) {
  const entradas = historial[fecha] || [];
  if (entradas.length === 0) return;

  const resumen = {};
  for (const cat of CONFIG.CATEGORIAS) {
    const precios = entradas.map(e => e[cat]).filter(p => p != null);
    resumen[cat] = precios.length === 0 ? null : {
      min: Math.min(...precios),
      max: Math.max(...precios),
      ultimo: precios[precios.length - 1],
      lecturas: precios.length,
    };
  }

  const filasHtml = CONFIG.CATEGORIAS.map(cat => {
    const r = resumen[cat];
    if (!r) return `<tr><td>${cat}</td><td colspan="4" style="color:gray">Sin datos</td></tr>`;
    return `<tr>
      <td><strong>${cat}</strong></td>
      <td>$${r.min}</td>
      <td>$${r.max}</td>
      <td>$${r.ultimo}</td>
      <td>${r.lecturas}</td>
    </tr>`;
  }).join("");

  const html = `
    <h2>Resumen diario M86 - ${fecha}</h2>
    <p>Umbral actual: $${CONFIG.PRECIO_MAXIMO} USD | Lecturas totales: ${entradas.length}</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
      <tr style="background:#f0f0f0">
        <th>Categoria</th><th>Minimo</th><th>Maximo</th><th>Ultimo</th><th>Lecturas</th>
      </tr>
      ${filasHtml}
    </table>
  `;

  const lineasNtfy = CONFIG.CATEGORIAS.map(cat => {
    const r = resumen[cat];
    return r ? `${cat}: min $${r.min} / ultimo $${r.ultimo}` : `${cat}: sin datos`;
  }).join("\n");

  const resend = new Resend(process.env.RESEND_API_KEY);
  await Promise.all([
    resend.emails.send({
      from: "Monitor M86 <onboarding@resend.dev>",
      to: CONFIG.EMAIL.destinatario,
      subject: `Resumen diario M86 - ${fecha}`,
      html,
    }),
    fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        "Title": `Resumen M86 - ${fecha}`,
        "Tags": "bar_chart",
      },
      body: lineasNtfy,
    }),
  ]);

  log(`Resumen diario enviado (${entradas.length} lecturas)`, C.verde);
}

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--no-zygote",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: BROWSER_ARGS,
  });
  browser.on("disconnected", () => { browser = null; });
  return browser;
}

async function scrapePrecios() {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    log("Abriendo fifacollect.info...", C.amarillo);
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });

    await page.waitForSelector("table", { timeout: 15000 }).catch(() => {
      log("Tabla no encontrada", C.rojo);
    });

    const filas = await page.evaluate((matchId) => {
      const resultados = [];
      const rows = Array.from(document.querySelectorAll("tr"));
      let enSeccionMatch = false;

      for (let i = 0; i < rows.length; i++) {
        const texto = rows[i].innerText || "";

        if (texto.includes(matchId)) {
          enSeccionMatch = true;
        }

        if (!enSeccionMatch) continue;

        // Si encontramos otro partido distinto, paramos
        if (enSeccionMatch && !texto.includes(matchId) && /\bM\d{2,3}\b/.test(texto)) {
          break;
        }

        const catMatch = texto.match(/CAT[1-4]/);
        if (catMatch) {
          const precios = texto.match(/\$[\d,]+\.?\d*/g);
          resultados.push({
            categoria: catMatch[0],
            precios: precios || [],
          });
        }
      }

      return resultados;
    }, MATCH_ID);

    return filas;
  } finally {
    await page.close();
  }
}

async function revisar() {
  log(`Revisando precios ${MATCH_ID} Miami...`, C.amarillo);

  let filas;
  try {
    filas = await scrapePrecios();
  } catch (err) {
    log(`Error: ${err.message}`, C.rojo);
    return;
  }

  if (!filas || filas.length === 0) {
    log("No se encontraron filas para M86", C.rojo);
    return;
  }

  let hayAlerta = false;
  const preciosDia = {};

  for (const cat of CONFIG.CATEGORIAS) {
    const fila = filas.find((f) => f.categoria === cat);

    if (!fila) {
      log(`  ${cat}: No existe para este partido`, C.amarillo);
      preciosDia[cat] = null;
      continue;
    }

    const ultimoPrecio = fila.precios[fila.precios.length - 1];
    const precio = parsePrecio(ultimoPrecio);
    preciosDia[cat] = precio;

    if (!precio) {
      log(`  ${cat}: Sin listings ahora`, C.amarillo);
      continue;
    }

    const esAlerta = precio <= CONFIG.PRECIO_MAXIMO;
    const color = esAlerta ? C.verde + C.bold : C.reset;
    const icono = esAlerta ? ">> ALERTA <<" : "-";

    log(`  ${icono} ${cat}: $${precio} USD`, color);

    if (esAlerta) {
      hayAlerta = true;
      const link = `https://collect.fifa.com/marketplace?tags=${cat.toLowerCase()}-m86`;
      log(`  DEBAJO DE $${CONFIG.PRECIO_MAXIMO}! Compra: ${link}`, C.verde + C.bold);
      try {
        await Promise.all([
          enviarNtfy(cat, precio),
          enviarEmail(cat, precio),
        ]);
      } catch (err) {
        log(`Error enviando alerta: ${err.message}`, C.rojo);
      }
    }
  }

  registrarPrecios(preciosDia);

  const ahora = ahoraAR();
  const fecha = ahora.toLocaleDateString("es-AR");
  if (ahora.getHours() === CONFIG.HORA_RESUMEN && resumenEnviadoHoy !== fecha) {
    resumenEnviadoHoy = fecha;
    try {
      await enviarResumen(fecha);
    } catch (err) {
      log(`Error enviando resumen: ${err.message}`, C.rojo);
    }
  }

  if (!hayAlerta) {
    const proxima = new Date(ahoraAR().getTime() + CONFIG.INTERVALO_MINUTOS * 60 * 1000);
    log(`Sin alertas. Proxima revision: ${proxima.toLocaleTimeString("es-AR", { hour12: false })}`, C.reset);
  }

  console.log("");
}

// ──────────────────────────────────────────────
//  Inicio
// ──────────────────────────────────────────────
console.log(`
╔════════════════════════════════════════╗
║   Monitor M86 — Argentina en Miami     ║
║   Hard Rock Stadium — 3 julio 2026     ║
╚════════════════════════════════════════╝

  Umbral de precio:  $${CONFIG.PRECIO_MAXIMO} USD
  Categorias:        ${CONFIG.CATEGORIAS.join(", ")}
  Intervalo:         cada ${CONFIG.INTERVALO_MINUTOS} minutos
  Email:             ${CONFIG.EMAIL.destinatario}

`);

inicializarSheet()
  .then(() => log("Google Sheets conectado", C.verde))
  .catch(err => log(`Error conectando Sheets: ${err.message}`, C.rojo));

revisar();
setInterval(revisar, CONFIG.INTERVALO_MINUTOS * 60 * 1000);
