---
version: alpha
colors:
  primary: "#6d28d9"
  primaryDeep: "#281447"
  primaryBright: "#8b5cf6"
  lavender: "#eee7ff"
  paper: "#fcfbff"
  white: "#ffffff"
  ink: "#211a2e"
  muted: "#6f687b"
  border: "#ece7f4"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
rounded:
  card: "22px"
  control: "14px"
  pill: "999px"
spacing:
  base: "4px"
  section: "clamp(30px, 4.6vw, 66px)"
components:
  productCard:
    radius: "22px"
    border: "#eee7f6"
    surface: "rgba(255,255,255,.94)"
  primaryButton:
    background: "linear-gradient(135deg, #7c3aed, #5b21b6)"
    radius: "14px"
omitted:
  - section: elevation
    reason: "Elevation is defined by runtime shadow tokens and contextual CSS recipes."
---
# ZENVORA Design Direction

## Overview
ZENVORA is a Nigeria-first marketplace for food, groceries, fashion, electronics, home goods, books, beauty, and everyday essentials. The interface should feel like a beautifully art-directed night market translated into a bright, trustworthy digital storefront: lively violet energy, porcelain whitespace, rich aubergine contrast, and tactile shopping surfaces. It serves customers on phones first, while supporting merchants, riders, and administrators in the same web app.

The memorable signature is the **violet night-market panel**: a deep aubergine hero surface with orbiting lavender light, paired with a bright editorial shopping canvas. Keep the rest disciplined so products and prices stay easy to scan.

## Colors
Use violet for actions and active states, aubergine for deep brand moments, lavender for supporting surfaces, porcelain for the page canvas, and near-black plum for text. Status colors remain semantic; do not recolor warnings, errors, or success merely for branding.

## Typography
Use the system sans stack for readable, dependable rendering on low-end and mid-range Android devices. Give display headings tight tracking and strong scale; body copy remains comfortably spaced and calm. Avoid loading remote font files as a requirement for core layout.

## Layout
The marketplace is mobile-first. Keep the primary shopping path visible early: search, choose a delivery area, browse categories, then scan product cards. Use generous desktop gutters and compact-but-comfortable phone layouts. Cards should have stable image geometry, clear pricing, and a single obvious action.

## Elevation & Depth
Use shadows sparingly to establish hierarchy rather than adding a shadow to every surface. The hero panel can be dramatic; product and form surfaces should use soft, low-contrast elevation.

## Shapes
Use rounded rectangular cards and controls with a consistent family: about 14px for controls, 17–22px for product surfaces, and pill shapes only for status/chip controls.

## Components
- Primary actions: saturated violet gradient, white text, 14–15px radius, visible focus ring.
- Search: wide white surface with inset padding and an elevated focus state.
- Category tiles: lavender icon block, short label, subtle border.
- Product cards: stable media ratio, merchant label, two-line product name, strong price, availability, then action.
- Forms: clear labels, 52px touch-friendly controls, and one clear primary action.
- Mobile navigation: fixed, translucent white surface with a clear active marker and safe-area padding.

## Do's and Don'ts
- Do make shopping feel alive through one strong branded hero and restrained micro-interactions.
- Do preserve the same interaction behavior and product hierarchy on desktop and mobile.
- Do use product photos when supplied; never fabricate product images or pretend placeholders are real photography.
- Don't add decorative cards around every piece of content.
- Don't let animation, gradients, or glass effects reduce legibility.
- Don't touch backend contracts when improving presentation.
