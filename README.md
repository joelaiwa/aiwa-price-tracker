# AIWA Price Tracker — Mercado Libre + WhatsApp Alerts

Monitors competitor prices on Mercado Libre México and sends WhatsApp notifications when a competitor undercuts AIWA's prices.

---

## How it works

1. Every hour (configurable), the script searches Mercado Libre for each of your products using the keywords you define.
2. It finds the lowest competitor price (excluding your own listing).
3. If a competitor is cheaper than your price by more than the threshold you set, it sends a WhatsApp message.
4. It has a 6-hour cooldown per product to avoid spam — you only get re-alerted if the situation continues.

---

## Step 1 — Set up Twilio (WhatsApp)

Twilio lets you send WhatsApp messages programmatically. The free trial is enough to test.

1. Go to **https://www.twilio.com** and create a free account.
2. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp message**.
3. You'll see a sandbox number (e.g. `+1 415 523 8886`). Send the join code from your WhatsApp to activate it.
4. Copy your **Account SID** and **Auth Token** from the Console dashboard.

> **For production** (after testing): Apply for a WhatsApp Business sender through Twilio. Cost is ~$0.05 USD per message sent.

---

## Step 2 — Deploy to Railway (free, easiest)

Railway.app is the simplest way to run this 24/7 for free.

### 2a. Push code to GitHub

1. Create a free account at **https://github.com**
2. Create a new repository called `aiwa-price-tracker`
3. Upload all these files to the repository

### 2b. Deploy on Railway

1. Go to **https://railway.app** and sign up (free tier available)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `aiwa-price-tracker` repository
4. Railway will detect it's a Node.js app automatically

### 2c. Add environment variables in Railway

In your Railway project, go to **Variables** and add:

```
TWILIO_ACCOUNT_SID     = ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN      = your_auth_token_here
TWILIO_WHATSAPP_FROM   = whatsapp:+14155238886
TWILIO_WHATSAPP_TO     = whatsapp:+521XXXXXXXXXX
CHECK_INTERVAL_MINUTES = 60
```

That's it — Railway will start the app and keep it running 24/7.

---

## Alternative: Deploy to Render (also free)

1. Go to **https://render.com** and sign up
2. New → **Background Worker** → Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node tracker.js`
5. Add the same environment variables under **Environment**

---

## Step 3 — Configure your products

Edit `products.json` with your actual AIWA products:

```json
[
  {
    "name": "AIWA Bocina Bluetooth AW-BT100",
    "ourPrice": 599,
    "ourListingId": "MLM123456789",
    "keyword": "bocina bluetooth aiwa",
    "alertThresholdPct": 3
  }
]
```

| Field | Description |
|---|---|
| `name` | Your internal product name (for the alert message) |
| `ourPrice` | Your current listing price in MXN |
| `ourListingId` | Your Mercado Libre listing ID (e.g. MLM123456789) — used to exclude your own listing from results |
| `keyword` | What to search on ML to find competitors |
| `alertThresholdPct` | Only alert if competitor is cheaper by at least this % (e.g. 3 = 3%) |

### How to find your Mercado Libre listing ID

Open your listing on mercadolibre.com.mx. The URL will look like:
`https://articulo.mercadolibre.com.mx/MLM-123456789-...`
Your ID is `MLM123456789` (remove the dash).

---

## Step 4 — Update prices

Whenever you change a price on Mercado Libre, update `ourPrice` in `products.json` and redeploy (or just edit directly in Railway/Render).

---

## Example WhatsApp alert you'll receive

```
⚠️ AIWA Price Alert ⚠️
15/01/2025, 14:30:00

🚨 AIWA Bocina Bluetooth AW-BT100
   Tu precio: $599 MXN
   Competidor: $549 MXN (-8.3%)
   Listing: Bocina Bluetooth Portátil 20W Resistente Agua...
   🔗 https://articulo.mercadolibre.com.mx/...

Revisa tus precios en Mercado Libre.
```

---

## Viewing logs

In Railway or Render, go to your deployment and click **Logs** to see real-time output of every price check.

---

## Costs

| Service | Cost |
|---|---|
| Railway / Render hosting | Free tier available |
| Twilio WhatsApp (sandbox) | Free for testing |
| Twilio WhatsApp (production) | ~$0.05 USD per message |
| Mercado Libre API | Free, no key required |

For a team receiving a few alerts per day, total cost is under $5 USD/month.

---

## Troubleshooting

**"No competitor data found"** — Your keyword may be too specific. Try broader terms, e.g. `bocina bluetooth` instead of `bocina bluetooth aiwa aw-bt100`.

**WhatsApp not sending** — Double-check your Twilio credentials and make sure you've joined the sandbox from your phone.

**Getting too many alerts** — Increase `alertThresholdPct` (e.g. from 3 to 10) to only alert on meaningful price differences.
