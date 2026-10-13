# ZENVORA

A commerce and delivery platform for the Nigerian market. This is the first slice: a storefront with browsing, search, delivery-area selection, and a server-side cart.

> **All stores, products and prices in this build are sample data for development.** They are not real businesses.

## What works now

- Home page, shop and search with filters, sorting and paging
- Product pages with variants (for example portion size) and quantity
- Delivery-area selection. Stores only show for areas they serve
- Cart held on the server. Prices, stock, delivery fees and totals are calculated server-side and the browser never sets them
- Mobile-first layout, bottom navigation, reduced-motion support, keyboard focus states

## Not built yet

Accounts and login, checkout, payments, merchant dashboard, rider app, admin panel, a real database. The cart's **Checkout** button is disabled on purpose: nothing is charged and no order is placed.

## Run it

Requires Node 22 or newer. There are no npm dependencies to install.

```bash
cd server
npm start          # http://localhost:4000
npm test           # server tests
```

Set `PORT` to use another port.

## Layout

```
server/   Node http API and static file server (no dependencies)
  src/catalogue.js   sample merchants and products (prices in kobo)
  src/cart.js        cart rules, pure functions
  src/app.js         API routes
web/      Browser app (plain ES modules, no build step)
  css/               design tokens, layout, components
  js/                router, views, API client
```

## Design decisions

- **One merchant per cart** in this release. Adding from a second store is refused with a clear message. Multi-merchant checkout (separate merchant orders under one checkout) is a later slice.
- **Money is integer kobo** end to end. Formatting to naira happens only in the browser.
- **Button green is `#047857`**, slightly darker than brand emerald `#059669`, so white text passes WCAG AA contrast.
- **Carts are in memory** and are lost on restart. Replace with a database before any real deployment.

## Next slices

1. Accounts, sessions and password reset
2. Database, then multi-merchant checkout with idempotent order submission
3. Payments (for example Paystack or Flutterwave) with server-side verification and webhooks
4. Merchant dashboard, rider experience, admin panel
