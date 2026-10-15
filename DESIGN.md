# Shop n Delight + Puff & Sip — Design Direction

## Product context
Shop n Delight is the main storefront. Puff & Sip is a distinct section within it, not a separate website. The current Zenvora codebase is the starting template; Zenvora is not the customer-facing brand. The Shop n Delight logo is still pending, so its final visual identity should not be treated as approved yet.

## Puff & Sip palette
Use this palette for the dedicated Puff & Sip route only, based on the section logo shared by the owner:
- Orange: `#F47721` — primary action and energetic accents.
- Deep orange: `#D95B16` — accessible orange for text and hover states.
- Navy: `#12243A` — strong contrast, headings, dark surfaces.
- Warm white: `#FFFAF5` — section canvas.
- White: `#FFFFFF` — cards and clean surfaces.
- Muted slate: `#65717D` — supporting copy.

Do not apply this sub-brand palette indiscriminately to Shop n Delight pages until its own logo is supplied and the shared brand system is approved.

## Typography
Use the system sans stack for dependable rendering on low-end and mid-range Android devices. Display headings are bold, tightly tracked, and oversized only where they add brand personality. Body copy remains calm and readable. Do not make remote fonts a requirement for core layout.

## Puff & Sip signature
The memorable signature is the oversized editorial headline beside a layered orange-and-navy graphic with a floating cup motif, orbiting linework, and a small label inspired by the section's playful logo. The art is CSS-based and decorative; it must not be mistaken for real product photography. Product images should come from the owner's future uploads.

## Layout and motion
Mobile-first, responsive down to narrow phones. Use one strong hero moment, then three useful collection links and a concise explanation of the shopping flow. Motion should feel light and deliberate: floating hero artwork and small card lifts, with all animation disabled or reduced when the user requests reduced motion. Avoid movement that obscures text or controls.

## Shared storefront principles
- Keep product search, prices, availability, and checkout actions easy to find.
- Preserve existing routes and API contracts while the frontend is being branded.
- Never present placeholder products as real inventory or claim that Paystack, pickup, dispatch, QR verification, or automated payment confirmation is live until those integrations are implemented and tested.
- Use semantic links and buttons, visible keyboard focus, readable contrast, and stable mobile layouts.
- The logo currently shown in the Shop n Delight shell is a temporary typographic mark, not the final official logo. Replace it when the owner supplies the Shop n Delight logo.
