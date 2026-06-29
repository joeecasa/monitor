// ============================================================
//  Monitor de entradas Argentina — thegreatreviewer.com/wc-tracker
//  Puppeteer + ntfy (push al celu) + email via Resend
//
//  Variables de entorno requeridas (mismo .env que monitor.js):
//    NTFY_TOPIC, RESEND_API_KEY
//
//  Uso:
//    node monitor-tracker.js
// ============================================================

const puppeteer = require("puppeteer");
const { Resend } = require("resend");
require("dotenv").config();

const CONFIG = {
  PRECIO_MAXIMO: 2000,         // USD — cambia según tu umbral
  INTERVALO_MINUTOS: 3,
  URL: "https://thegreatreviewer.com/wc-tracker",
  EMAIL: {
    destinatario: "j.casa.marquez@gmail.com",
  },
};

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

// ──────────────────────────────────────────────
//  Notificaciones
// ──────────────────────────────────────────────

async function enviarNtfy({ partido, precio, categoria, buyLink }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { log("NTFY_TOPIC no configurado", C.rojo); return; }

  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title":    `ARGENTINA ${categoria} a $${precio} USD`,
      "Priority": "urgent",
      "Tags":     "soccer,rotating_light",
      "Click":    buyLink || CONFIG.URL,
    },
    body: `${partido}\n${categoria} a $${precio} USD\nUmbral: $${CONFIG.PRECIO_MAXIMO} — ¡Comprá ahora!`,
  });
  log("Ntfy enviado al celu", C.verde);
}

async function enviarEmail({ partido, precio, categoria, buyLink }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: "Monitor Argentina <onboarding@resend.dev>",
    to: CONFIG.EMAIL.destinatario,
    subject: `ALERTA Argentina — ${partido} | ${categoria} a $${precio} USD`,
    html: `
      <h2>Entrada Argentina por debajo del umbral</h2>
      <p><strong>Partido:</strong> ${partido}</p>
      <p><strong>Categoría:</strong> ${categoria}</p>
      <p><strong>Precio mínimo:</strong> $${precio} USD</p>
      <p><strong>Tu umbral:</strong> $${CONFIG.PRECIO_MAXIMO} USD</p>
      ${buyLink ? `<p><a href="${buyLink}" style="font-size:18px;font-weight:bold;color:#d40000;">COMPRAR AHORA</a></p>` : `<p><a href="${CONFIG.URL}">Ver en tracker</a></p>`}
    `,
  });
  log("Email enviado", C.verde);
}

// ──────────────────────────────────────────────
//  Browser singleton
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
//  Scraping
// ──────────────────────────────────────────────

async function aplicarFiltroArgentina(page) {
  // Intento 1: <select> nativo
  try {
    const selects = await page.$$("select");
    for (const sel of selects) {
      const opciones = await sel.evaluate(el =>
        Array.from(el.options).map(o => o.text)
      );
      if (opciones.some(o => o.toLowerCase().includes("argentina") || o.toLowerCase().includes("team"))) {
        await sel.select(
          await sel.evaluate(el => {
            const opt = Array.from(el.options).find(o => o.text.toLowerCase().includes("argentina"));
            return opt ? opt.value : "";
          })
        );
        await new Promise(r => setTimeout(r, 1500));
        log("Filtro Argentina aplicado (select)", C.cyan);
        return true;
      }
    }
  } catch {}

  // Intento 2: dropdown custom — buscar botón "All Teams" y click en Argentina
  try {
    const btns = await page.$$("button, [role='combobox'], [role='listbox']");
    for (const btn of btns) {
      const txt = await btn.evaluate(el => el.innerText || "");
      if (txt.toLowerCase().includes("all teams") || txt.toLowerCase().includes("team")) {
        await btn.click();
        await new Promise(r => setTimeout(r, 500));
        const items = await page.$$("[role='option'], li, [class*='option'], [class*='item']");
        for (const item of items) {
          const itemTxt = await item.evaluate(el => el.innerText || "");
          if (itemTxt.toLowerCase().includes("argentina")) {
            await item.click();
            await new Promise(r => setTimeout(r, 1500));
            log("Filtro Argentina aplicado (dropdown custom)", C.cyan);
            return true;
          }
        }
      }
    }
  } catch {}

  log("No se pudo aplicar filtro de equipo — buscando Argentina en todo el contenido", C.amarillo);
  return false;
}

async function extraerDatos(page) {
  return page.evaluate(() => {
    const resultados = [];

    function parsePrecio(str) {
      if (!str) return null;
      const n = parseFloat(str.replace(/[^0-9.]/g, ""));
      return isNaN(n) || n < 50 ? null : n; // ignorar números menores a $50
    }

    function extraerDeNodo(nodo) {
      const texto = nodo.innerText || nodo.textContent || "";

      // Precio "From $X" — el más barato disponible en la card
      const fromMatch = texto.match(/[Ff]rom\s*\$([\d,]+\.?\d*)/);
      const precioFrom = fromMatch ? parsePrecio(fromMatch[1]) : null;

      // Fallback: cualquier precio con $
      const todosPrecios = (texto.match(/\$[\d,]+\.?\d*/g) || [])
        .map(p => parsePrecio(p))
        .filter(Boolean);

      const precios = precioFrom ? [precioFrom] : todosPrecios;
      if (precios.length === 0) return null;

      // Nombre del partido: "X vs Y"
      const vsMatch = texto.match(/[\wÀ-ž][\w\sÀ-ž]* vs [\w\sÀ-ž]+/i);
      const partido = vsMatch
        ? vsMatch[0].trim().replace(/\s+/g, " ")
        : texto.split("\n").map(l => l.trim()).find(l => l.length > 3) || "";

      // Categorías disponibles (puede ser "Category 1", "Front Category 2", etc.)
      const catsEncontradas = [];
      const catRegex = /(?:Front\s+)?Category\s+[1-4]/gi;
      let m;
      while ((m = catRegex.exec(texto)) !== null) {
        if (!catsEncontradas.includes(m[0])) catsEncontradas.push(m[0].trim());
      }
      // También acepta formato CAT1-4
      const catCorto = texto.match(/\bCAT\s*[1-4]\b/gi) || [];
      catCorto.forEach(c => { if (!catsEncontradas.includes(c)) catsEncontradas.push(c); });

      const categoria = catsEncontradas.length > 0
        ? catsEncontradas.join(" / ")
        : "N/A";

      const buyEl = nodo.querySelector('a[href*="fifa"], a[href*="collect"], a[href*="ticket"]');
      const textoDebug = texto.replace(/\s+/g, " ").substring(0, 300);

      return {
        partido: partido.substring(0, 80),
        precios,
        precioMinimo: Math.min(...precios),
        categoria,
        buyLink: buyEl ? buyEl.href : null,
        textoDebug,
      };
    }

    // Estrategia 1: buscar cards/artículos con "Argentina"
    const candidatos = document.querySelectorAll(
      'article, [class*="card"], [class*="match"], [class*="fixture"], [class*="event"], [class*="listing"]'
    );
    candidatos.forEach(el => {
      if (!(el.innerText || "").toLowerCase().includes("argentina")) return;
      const d = extraerDeNodo(el);
      if (d) resultados.push(d);
    });

    // Estrategia 2: filas de tabla con Argentina
    if (resultados.length === 0) {
      document.querySelectorAll("tr").forEach(row => {
        if (!(row.innerText || "").toLowerCase().includes("argentina")) return;
        const d = extraerDeNodo(row);
        if (d) resultados.push(d);
      });
    }

    // Estrategia 3: cualquier div/span con Argentina y precio
    if (resultados.length === 0) {
      document.querySelectorAll("div, section, li").forEach(el => {
        const txt = el.innerText || "";
        if (!txt.toLowerCase().includes("argentina")) return;
        if (!(txt.match(/\$[\d,]+/))) return;
        if (el.children.length > 10) return; // evitar contenedores muy grandes
        const d = extraerDeNodo(el);
        if (d) resultados.push(d);
      });
    }

    return resultados;
  });
}

// ──────────────────────────────────────────────
//  Ciclo principal
// ──────────────────────────────────────────────

// Clave: precio + categoria + bucket de 5 min → evita spam de la misma alerta
const alertasEnviadas = new Set();

async function revisar() {
  log("Revisando partidos de Argentina en wc-tracker...", C.amarillo);

  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );

    await page.goto(CONFIG.URL, { waitUntil: "networkidle2", timeout: 45000 });

    // Esperar que el JS renderice el contenido
    await new Promise(r => setTimeout(r, 3000));

    await aplicarFiltroArgentina(page);

    // Esperar actualización post-filtro
    await new Promise(r => setTimeout(r, 2000));

    const datos = await extraerDatos(page);

    if (!datos || datos.length === 0) {
      log("Sin datos de Argentina disponibles en el tracker", C.amarillo);
      return;
    }

    log(`Encontrados ${datos.length} resultado(s)`, C.cyan);

    for (const d of datos) {
      const { partido, precioMinimo, categoria, buyLink } = d;
      const esAlerta = precioMinimo <= CONFIG.PRECIO_MAXIMO;
      const color = esAlerta ? C.verde + C.bold : C.reset;
      const icono = esAlerta ? ">> ALERTA <<" : "-";

      log(`  ${icono} ${partido.substring(0, 50)} | ${categoria}: $${precioMinimo} USD`, color);
      if (categoria === "N/A") log(`    [debug] texto: ${d.textoDebug}`, C.amarillo);

      if (esAlerta) {
        const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
        const key = `${categoria}-${precioMinimo}-${bucket}`;

        if (!alertasEnviadas.has(key)) {
          alertasEnviadas.add(key);
          try {
            await Promise.all([
              enviarNtfy({ partido, precio: precioMinimo, categoria, buyLink }),
              enviarEmail({ partido, precio: precioMinimo, categoria, buyLink }),
            ]);
          } catch (err) {
            log(`Error enviando alerta: ${err.message}`, C.rojo);
          }
        } else {
          log(`  (alerta ya enviada, esperando próximo ciclo)`, C.amarillo);
        }
      }
    }

  } catch (err) {
    log(`Error: ${err.message}`, C.rojo);
  } finally {
    await page.close();
  }

  const proxima = new Date(ahoraAR().getTime() + CONFIG.INTERVALO_MINUTOS * 60 * 1000);
  log(`Próxima revisión: ${proxima.toLocaleTimeString("es-AR", { hour12: false })}`, C.reset);
  console.log("");
}

// ──────────────────────────────────────────────
//  Inicio
// ──────────────────────────────────────────────

console.log(`
╔════════════════════════════════════════╗
║   Monitor Argentina — WC Tracker       ║
║   thegreatreviewer.com/wc-tracker      ║
╚════════════════════════════════════════╝

  Umbral:    $${CONFIG.PRECIO_MAXIMO} USD
  Intervalo: cada ${CONFIG.INTERVALO_MINUTOS} minutos
  Email:     ${CONFIG.EMAIL.destinatario}
  Ntfy:      ntfy.sh/${process.env.NTFY_TOPIC || "(configura NTFY_TOPIC en .env)"}

`);

revisar();
setInterval(revisar, CONFIG.INTERVALO_MINUTOS * 60 * 1000);
