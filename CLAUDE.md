# Monitor M86 — FIFA World Cup 2026

Monitor automático de precios de entradas para el partido **M86 (Argentina)** en el Hard Rock Stadium, Miami — **3 julio 2026**.

## Qué hace

- Scrapea `fifacollect.info/tickets/world-cup-2026/listings` con Puppeteer cada 5 minutos
- Filtra las filas del partido M86 buscando categorías CAT1–CAT4
- Si algún precio está por debajo del umbral configurado, envía un email de alerta via Resend

## Stack

- **Runtime:** Node.js
- **Scraping:** Puppeteer (headless Chrome)
- **Emails:** Resend (`resend` npm package)
- **Config:** dotenv (`.env` en raíz)

## Archivos clave

| Archivo | Rol |
|---|---|
| `monitor.js` | Script principal — único archivo de lógica |
| `.env` | Credenciales: `RESEND_API_KEY`, `GMAIL_PASSWORD` |
| `package.json` | Entry point: `node monitor.js` / `npm start` |

## Configuración (dentro de `monitor.js`)

```js
const CONFIG = {
  PRECIO_MAXIMO: 1500,        // USD — dispara alerta si precio <= este valor
  INTERVALO_MINUTOS: 5,
  CATEGORIAS: ["CAT4", "CAT3", "CAT2", "CAT1"],
  EMAIL: {
    destinatario: "j.casa.marquez@gmail.com",
  },
};
```

## Variables de entorno requeridas

```
RESEND_API_KEY=...           # API key de resend.com
PUPPETEER_EXECUTABLE_PATH=   # Opcional: path al Chrome si no usa el bundled
```

## Cómo correr

```bash
npm install
node monitor.js
# o
npm start
```

## Lógica de scraping

1. Navega a la URL con `networkidle2`
2. Espera el selector `table`
3. Recorre todas las `<tr>` buscando la sección del partido M86
4. Para cada fila con `CAT[1-4]`, extrae el último precio (`$xxx`)
5. Compara con `PRECIO_MAXIMO` y envía email si corresponde

## Email de alerta

- **From:** `Monitor M86 <onboarding@resend.dev>`
- **To:** `j.casa.marquez@gmail.com`
- **Subject:** `ALERTA M86 Miami — {CAT} a ${precio} USD`
- Incluye link directo a `collect.fifa.com/marketplace?tags={cat}-m86`

## Notas

- El browser de Puppeteer se reutiliza entre ciclos (instancia singleton con reconexión automática)
- Si no encuentra filas para M86 o la tabla no carga, loguea el error y continúa en el próximo intervalo
- Los logs usan colores ANSI (verde = alerta, rojo = error, amarillo = info)
