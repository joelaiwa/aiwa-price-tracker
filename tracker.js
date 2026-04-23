const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const PRODUCTS_FILE = "./products.json";
const STATE_FILE = "./state.json";
const LOG_FILE = "./tracker.log";
const CHECK_INTERVAL = process.env.CHECK_INTERVAL_MINUTES || 60;

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── Load / save ──────────────────────────────────────────────────────────────
function loadProducts() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    log("ERROR: products.json not found.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Fetch search results and split into ours vs competitors ──────────────────
async function fetchPrices(keyword, ourListingId) {
  try {
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(keyword)}&limit=50`;
    const res = await axios.get(url, { timeout: 10000 });
    const results = res.data.results || [];

    if (!results.length) return { ourPrice: null, lowestCompetitor: null };

    // Find our own listing in the results
    const ourListing = results.find((r) => r.id === ourListingId);

    // Everyone else is a competitor
    const competitors = results
      .filter((r) => r.id !== ourListingId && r.price > 0)
      .sort((a, b) => a.price - b.price);

    return {
      ourPrice: ourListing ? ourListing.price : null,
      ourTitle: ourListing ? ourListing.title : null,
      lowestCompetitor: competitors.length ? competitors[0] : null,
    };
  } catch (err) {
    log(`  ERROR fetching search results for "${keyword}": ${err.message}`);
    return { ourPrice: null, lowestCompetitor: null };
  }
}

// ─── WhatsApp via Twilio ──────────────────────────────────────────────────────
async function sendWhatsApp(message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.TWILIO_WHATSAPP_TO;

  if (!accountSid || !authToken || !from || !to) {
    log("WARNING: Twilio not configured. Skipping WhatsApp.");
    return false;
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      new URLSearchParams({ From: from, To: to, Body: message }),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    log("  WhatsApp sent successfully.");
    return true;
  } catch (err) {
    log(`  ERROR sending WhatsApp: ${err.response?.data?.message || err.message}`);
    return false;
  }
}

// ─── Format price ─────────────────────────────────────────────────────────────
function fmt(n) {
  return `$${Number(n).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} MXN`;
}

// ─── Main check ───────────────────────────────────────────────────────────────
async function checkPrices() {
  log("════ Starting price check ════");
  const products = loadProducts();
  const state = loadState();
  const alerts = [];
  const notFoundInSearch = [];

  for (const product of products) {
    log(`\nChecking: ${product.name} (${product.ourListingId})`);

    const { ourPrice, ourTitle, lowestCompetitor } = await fetchPrices(
      product.keyword,
      product.ourListingId
    );

    // If our listing wasn't found in search results, warn but don't crash
    if (ourPrice === null) {
      log(`  WARNING: Our listing ${product.ourListingId} not found in search results for "${product.keyword}".`);
      log(`  It may be paused, or the keyword may not match our listing. Skipping.`);
      notFoundInSearch.push(product.name);
      continue;
    }

    log(`  Our price: ${fmt(ourPrice)}`);

    if (!lowestCompetitor) {
      log(`  No competitors found in search results.`);
      continue;
    }

    const theirPrice = lowestCompetitor.price;
    const diff = ourPrice - theirPrice;
    const diffPct = ((diff / ourPrice) * 100).toFixed(1);

    log(`  Lowest competitor: ${fmt(theirPrice)} — "${lowestCompetitor.title.substring(0, 55)}..."`);

    // Alert if competitor is cheaper by ANY amount
    if (theirPrice < ourPrice) {
      const productState = state[product.ourListingId] || {};

      // 6-hour cooldown per product to avoid spam
      const alreadyAlerted =
        productState.lastAlertPrice === theirPrice &&
        productState.lastAlertDate &&
        new Date() - new Date(productState.lastAlertDate) < 6 * 60 * 60 * 1000;

      if (!alreadyAlerted) {
        state[product.ourListingId] = {
          lastAlertPrice: theirPrice,
          lastAlertDate: new Date().toISOString(),
          lastOurPrice: ourPrice,
        };

        alerts.push({
          name: product.name,
          ourPrice,
          theirPrice,
          diff: diff.toFixed(2),
          diffPct: Math.abs(diffPct),
          competitorTitle: lowestCompetitor.title,
          competitorUrl: lowestCompetitor.permalink,
        });

        log(`  ⚠ ALERT: Competitor cheaper by ${fmt(diff)} (${Math.abs(diffPct)}%)`);
      } else {
        log(`  Already alerted for this price recently. Cooldown active.`);
      }
    } else {
      log(`  ✓ We are the cheapest (or tied).`);
      if (state[product.ourListingId]) {
        state[product.ourListingId].lastAlertPrice = null;
      }
    }

    saveState(state);

    // Respectful delay between API calls
    await new Promise((r) => setTimeout(r, 1500));
  }

  // ─── Send WhatsApp with all alerts ─────────────────────────────────────────
  if (alerts.length > 0) {
    log(`\nSending WhatsApp alert for ${alerts.length} product(s)...`);

    const lines = alerts.map(
      (a) =>
        `🚨 *${a.name}*\n` +
        `   Nuestro precio: ${fmt(a.ourPrice)}\n` +
        `   Competidor:     ${fmt(a.theirPrice)} (-${a.diffPct}% / -${fmt(a.diff)})\n` +
        `   "${a.competitorTitle.substring(0, 50)}..."\n` +
        `   🔗 ${a.competitorUrl}`
    );

    const message =
      `⚠️ *AIWA — Alerta de Precios* ⚠️\n` +
      `📅 ${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}\n` +
      `${alerts.length} producto(s) con precio más bajo en ML:\n\n` +
      lines.join("\n\n") +
      `\n\n_Revisa y ajusta tus precios en Mercado Libre._`;

    await sendWhatsApp(message);
  } else {
    log("\nNo alerts. All prices competitive.");
  }

  // Warn if some listings weren't found in search
  if (notFoundInSearch.length > 0) {
    log(`\nWARNING: ${notFoundInSearch.length} listing(s) not found in search results:`);
    notFoundInSearch.forEach((n) => log(`  - ${n}`));
    log(`Check that their keywords match and listings are active on ML.`);
  }

  log("\n════ Check complete ════\n");
}

// ─── Start ────────────────────────────────────────────────────────────────────
log("AIWA Price Tracker starting...");
log(`Checking every ${CHECK_INTERVAL} minutes.`);

checkPrices();

const cronExpr = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpr, checkPrices);
