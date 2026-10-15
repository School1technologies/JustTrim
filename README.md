# Just Trim: web app + backend (one service)

(Plain text file. Open it with Notepad, not Acrobat.)

Node.js (Express) + PostgreSQL. The server also serves the mobile-friendly web app from `public/`,
so you deploy **one service and one database** and the app is live at a single address.

## What is included
- **Login with email + password** (passwords stored as scrypt hashes, rate limited). No SMS needed.
- **Customer:** browse salons with a live crowd meter, pick services/combos and a stylist, book a free slot,
  join the walk-in queue, cancel (free until 2 hours before), rate, offer codes, loyalty points.
- **Salon owner:** register a salon and branches, team (photo, speciality, own timings, leave), menu and combos,
  timings, holidays, offers, today's bookings (Start / Done / No-show), walk-ins, **live alert on every new booking**.
- **Super Admin:** approve or reject salons, suspend, mark paid, extend trial, pricing settings, disputes, reset a forgotten password.
- **SaaS billing:** ₹1499/month per salon + 18% GST, first 3 months free, 7 day grace, expired salons are hidden.
- **No double booking**, even if many people tap the same slot at once (enforced by the database).

## Deploy (about 30 minutes)
1. Put this folder in a GitHub repository.
2. On **Render** (render.com): New → Blueprint → pick the repo. It reads `render.yaml` and creates the API and a PostgreSQL database.
   (Other hosts work too: use the `Dockerfile` and any PostgreSQL. In India, AWS Mumbai `ap-south-1` gives the lowest delay.)
3. Set the environment variables listed in `.env.example`. The important one is `ADMIN_EMAILS`: put **your email** there.
4. Open the address your host gives you. **Create an account with your admin email** (choose any name) and you land in the Super Admin panel.
5. Optional: connect your own domain (for example `app.justtrim.in`). HTTPS is added automatically.
6. When you are ready to charge: create a Razorpay account, add the three `RAZORPAY_*` variables, and add a webhook to
   `https://<your-address>/api/webhooks/razorpay` for the `payment.captured` event.
   Until then, salons run on the free trial and Super Admin can press **Mark paid** by hand.

The database tables are created automatically on every start. Turn on daily backups in your database settings.

## Run it on your own computer
```bash
npm install
createdb justtrim
export DATABASE_URL=postgres://localhost/justtrim JWT_SECRET=$(openssl rand -hex 32) ADMIN_EMAILS=you@example.com
npm run migrate && npm start         # open http://localhost:3000
DATABASE_URL=postgres://... npm test # 52 checks. WARNING: wipes that database, use a throwaway one.
```

## Good to know
- **Forgotten passwords:** there is no email service yet, so Super Admin resets them (Billing tab → Reset a forgotten password).
  Adding emailed reset links needs an email provider (for example Resend or Amazon SES). Same for confirming email addresses.
- **Refunds:** cancelling flags the advance for refund but does not call Razorpay yet. Refund from the Razorpay dashboard for now.
- **Left for later:** reschedule button, insights charts and Tamil/Hindi in the new screens (the server already supports reschedule),
  moving stylist photos to object storage when you have many salons, a second API server (live alerts then need Redis or Postgres `LISTEN/NOTIFY`).
- **Before real customers:** privacy policy and terms (India's DPDP Act), GST registration and GST invoice format. Please check these with an accountant or lawyer.

## API at a glance
`POST /api/auth/{register,login}` · `GET /api/me` · `GET /api/salons`, `/api/salons/:id`, `/api/salons/:id/slots` ·
`POST /api/bookings`, `GET /api/bookings/mine`, `POST /api/bookings/:id/{cancel,reschedule,rate}`, `POST /api/salons/:id/walkin` ·
Owner: `POST /api/salons`, `GET /api/my/salons`, `GET /api/salons/:id/manage`, `PATCH /api/salons/:id`, staff, services, combos,
`GET /api/salons/:id/{bookings,notifications,events,billing}`, `POST /api/salons/:id/billing/checkout` ·
Admin: `GET /api/admin/{overview,salons,settings,tickets}`, `POST /api/admin/salons/:id/{approve,reject,suspend,activate,mark-paid,extend-trial}`, `POST /api/admin/users/reset-password`.

## How to change things later
| I want to change | Where |
|---|---|
| Colours | `public/style.css`, the block at the very end called "Just Trim brand". Each colour is a code like `#E10650`. |
| Logo and icons | Replace `public/logo.png` (sign-in page), `public/pin.png` (top bar), `public/favicon.png`, `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`. Keep the same file names. |
| Subscription price, free months, GST | Super Admin screen → Billing tab. No code needed. |
| Screens and features | Ask for the change, get updated files, then follow the steps below. |

**Updating the live app:** on GitHub open the file → pencil icon (edit) → paste → **Commit changes**. For many files use
**Add file → Upload files** and drop them in. Render notices the change and redeploys by itself in 2 to 4 minutes.
Check **Events** in Render to see it finish.
