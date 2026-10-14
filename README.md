# ZENVORA

A commerce and delivery platform for the Nigerian market. This build covers the customer side end to end (browse, search, choose a delivery area, create an account, place a cash-on-delivery order), the merchant dashboard, and delivery dispatch: rider applications, manual assignment by administrators, and proof of delivery.

> **All stores, products and prices in this build are sample data for development.** They are not real businesses.

## What works now

- Home, shop and search with filters, sorting and paging
- Product pages with options (for example portion size) and quantity
- Delivery areas: stores only show for areas they serve, and the server refuses any other
- Cart held on the server. Prices, stock, delivery fees and totals are calculated server-side
- Accounts: register, log in, log out, profile, password reset
- Checkout with **cash on delivery**, then order confirmation and order history
- **Store dashboard.** Staff connect with an access code and manage orders (accept, prepare, mark ready), stock, prices and offers. Sales figures come from real orders.
- **Riders.** Anyone can apply from `#/rider`, choosing a vehicle, a phone number and the areas they cover. Nothing is assigned until an administrator approves them. Approved riders go online or offline, then pick up, deliver or report a failed delivery. Delivery requires a proof note and confirmation that the cash was collected.
- **Administration** (`#/admin`, administrators only). Dispatch shows every order needing a rider, with only the approved riders who cover that area. Riders can be approved, suspended or sent back to review, with a note. The audit log records every rider and dispatch change.
- Mobile-first layout, bottom navigation, reduced-motion support, keyboard focus states

## Not built yet

- **Online payments.** Needs a provider (for example Paystack or Flutterwave) and your keys. The checkout shows "Pay online" as unavailable.
- **Payment status.** Cash on delivery is marked collected only when the assigned rider confirms it on delivery. Nothing is charged online.
- **Email.** No email provider is connected. In development the password-reset link is printed in the server console. In production it is never logged, so resets stay unavailable until email is connected.
- **Rider identity checks.** Administrators approve riders after checking their details outside the app. No identity documents are uploaded or stored.
- **Live tracking and delivery time estimates.** There is no rider location feed yet, so the app shows no live position and no estimated arrival time.
- **Rider earnings, settlements, disputes, merchant applications, listing review, promotions and platform settings** are not built yet. Multi-merchant checkout, real product photography and live tracking are also later work.

## Run it

Requires Node 22 or newer. There are no npm dependencies to install.

```bash
cd server
npm start          # http://localhost:4000
npm test           # server tests
```

Environment variables: `PORT` (default 4000), `ZENVORA_DATA_DIR` (where the SQLite file lives, default `server/data`, git-ignored), `NODE_ENV=production` (adds the `Secure` cookie flag and stops logging reset links), `ZENVORA_MERCHANT_CLAIM_CODES` (a JSON map from store id to its staff access code, for example `{"m-sample-kitchen":"a-long-random-code"}`).

### Administrator accounts

There is no admin sign-up and no built-in admin login. Create an ordinary account in the app first, then grant the role on the server, against the real database:

```bash
cd server
node scripts/grant-role.js you@example.com admin        # grant
node scripts/grant-role.js you@example.com customer     # remove
```

Every grant is recorded in the audit log.

Node prints a one-time warning that `node:sqlite` is experimental. That is expected on Node 22.

## Layout

```
server/   Node http API and static file server (no dependencies)
  src/catalogue.js   sample merchants and products (prices in kobo)
  src/cart.js        cart rules, pure functions
  src/auth.js        accounts, sessions, password reset, rate limiting
  src/orders.js      order placement, merchant status rules
  src/merchant.js    store access codes and product rules
  src/dispatch.js    riders, assignments, pickup and delivery rules
  scripts/           command-line tools (administrator roles)
  src/db.js          SQLite schema (node:sqlite)
  src/app.js         API routes
web/      Browser app (plain ES modules, no build step)
  css/               design tokens, layout, components
  js/                router, views, API client
```

## Security notes

- Passwords are hashed with scrypt. Session and reset tokens are stored only as SHA-256 hashes.
- Sessions are `HttpOnly`, `SameSite=Lax` cookies checked against the database on every request. Logout and password reset end sessions on the server.
- Login, registration and reset are rate limited per IP and (for login) per email. The limiter keys on the connection address. If you deploy behind a proxy, add trusted-proxy handling first, or every user will share one limit.
- Writes must be JSON and must not come from another origin.
- Customers can read only their own orders. Another customer's order returns "not found".
- The checkout re-prices the cart, re-checks stock and the delivery area, and takes city and state from the store's own data. A retry key (`idempotencyKey`) means a repeated submission returns the original order instead of creating another.

## Design decisions

- **One merchant per cart** in this release. Adding from a second store is refused with a clear message. Multi-merchant checkout (separate merchant orders under one checkout) is a later slice.
- **Money is integer kobo** end to end. Formatting to naira happens only in the browser.
- **Button green is `#047857`**, slightly darker than brand emerald `#059669`, so white text passes WCAG AA contrast.
- **Stock lives in memory** with the sample catalogue, so it resets when the server restarts. Orders and accounts persist in SQLite. Move the catalogue and stock into the database before real use.
- **Carts are in memory** and are lost on restart.

## Next slices

1. ~~Merchant accounts and dashboard~~ (done)
2. Online payments with server-side verification and webhooks (needs a provider and keys)
3. ~~Rider experience and admin panel, with manual dispatch~~ (done). Still to come: rider earnings and settlement records, admin review of merchant applications and listings, disputes, promotions, and platform settings
4. Move catalogue and carts into the database
