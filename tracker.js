const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
require("dotenv").config();

// ─── Config ───────────────────────────────────────────────────────────────────
const PRODUCTS_FILE = "./products.json";
const LOG_FILE = "./tracker.log";
const CHECK_INTERVAL = process.env.CHECK_INTERVAL_MINUTES || 60; // minutes

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── Load products ────────────────────────────────────────────────────────────
function loadProducts() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    log("ERROR: products.json not found. Please create it.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
}

function saveProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

// ─── Mercado Libre API ────────────────────────────────────────────────────────
async function getLowestCompetitorPrice(keyword, ourListingId = null) {
  try {
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(keyword)}&limit=20`;
    const res = await axios.get(url, { timeout: 10000 });
    const results = res.data.results || [];

    // Filter out our own listing if we have our listing ID
    const competitors = ourListingId
      ? results.filter((r) => r.id !== ourListingId)
      : results;

    if (!competitors.length) return null;

    // Find the lowest price among active listings
    const prices = competitors
      .filter((r) => r.condition !== "not_specified")
      .map((r) => ({ price: r.price, title: r.title, id: r.id, url: r.permalink }))
      .filter((r) => r.price > 0);

    if (!prices.length) return null;

    prices.sort((a, b) => a.price - b.price);
    return prices[0]; // { price, title, id, url }
  } catch (err) {
    log(`ERROR fetching ML data for "${keyword}": ${err.message}`);
    return null;
  }
}

// ─── WhatsApp via Twilio ──────────────────────────────────────────────────────
async function sendWhatsApp(message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886
  const to = process.env.TWILIO_WHATSAPP_TO;     // e.g. whatsapp:+521XXXXXXXXXX

  if (!accountSid || !authToken || !from || !to) {
    log("WARNING: Twilio credentials not configured. Skipping WhatsApp notification.");
    return false;
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      new URLSearchParams({ From: from, To: to, Body: message }),
      { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    log("WhatsApp notification sent successfully.");
    return true;
  } catch (err) {
    log(`ERROR sending WhatsApp: ${err.response?.data?.message || err.message}`);
    return false;
  }
}

// ─── Main check logic ─────────────────────────────────────────────────────────
async function checkPrices() {
  log("─── Starting price check ───");
  const products = loadProducts();
  const alerts = [];

  for (const product of products) {
    log(`Checking: ${product.name}`);
    const competitor = await getLowestCompetitorPrice(product.keyword, product.ourListingId);

    const now = new Date().toISOString();

    if (!competitor) {
      log(`  No competitor data found for "${product.keyword}"`);
      product.lastChecked = now;
      product.lastCompetitorPrice = null;
      continue;
    }

    const ourPrice = product.ourPrice;
    const theirPrice = competitor.price;
    const diff = ourPrice - theirPrice;
    const diffPct = ((diff / ourPrice) * 100).toFixed(1);

    log(`  Our price: $${ourPrice} | Lowest competitor: $${theirPrice} (${diffPct}% diff)`);
    log(`  Competitor: "${competitor.title.substring(0, 60)}..."`);

    product.lastChecked = now;
    product.lastCompetitorPrice = theirPrice;
    product.lastCompetitorTitle = competitor.title;
    product.lastCompetitorUrl = competitor.url;

    // Alert if competitor beats us by more than the threshold
    const threshold = product.alertThresholdPct || 0;
    if (theirPrice < ourPrice && Math.abs(diffPct) >= threshold) {
      const alreadyAlerted =
        product.lastAlertPrice === theirPrice &&
        product.lastAlertDate &&
        new Date() - new Date(product.lastAlertDate) < 6 * 60 * 60 * 1000; // 6hr cooldown

      if (!alreadyAlerted) {
        product.lastAlertPrice = theirPrice;
        product.lastAlertDate = now;
        alerts.push({
          product: product.name,
          ourPrice,
          theirPrice,
          diffPct: Math.abs(diffPct),
          competitorTitle: competitor.title,
          competitorUrl: competitor.url,
        });
        log(`  ⚠ ALERT: Competitor is cheaper by $${diff.toFixed(0)} (${Math.abs(diffPct)}%)`);
      } else {
        log(`  Alert already sent recently. Skipping.`);
      }
    } else {
      log(`  ✓ We are competitively priced.`);
    }

    // Small delay between products to be respectful to the API
    await new Promise((r) => setTimeout(r, 1500));
  }

  saveProducts(products);

  // Send one WhatsApp message with all alerts
  if (alerts.length > 0) {
    const lines = alerts.map(
      (a) =>
        `🚨 *${a.product}*\n` +
        `   Tu precio: $${a.ourPrice.toLocaleString("es-MX")} MXN\n` +
        `   Competidor: $${a.theirPrice.toLocaleString("es-MX")} MXN (-${a.diffPct}%)\n` +
        `   Listing: ${a.competitorTitle.substring(0, 50)}...\n` +
        `   🔗 ${a.competitorUrl}`
    );
    const message =
      `⚠️ *AIWA Price Alert* ⚠️\n` +
      `${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}\n\n` +
      lines.join("\n\n") +
      `\n\n_Revisa tus precios en Mercado Libre._`;

    await sendWhatsApp(message);
  } else {
    log("No alerts. All prices competitive.");
  }

  log("─── Check complete ───\n");
}

// ─── Start ────────────────────────────────────────────────────────────────────
log("AIWA Price Tracker starting...");
log(`Will check every ${CHECK_INTERVAL} minutes.`);

// Run immediately on start
checkPrices();

// Schedule recurring checks
const cronExpr = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpr, checkPrices);
