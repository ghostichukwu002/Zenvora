# Moderator product photos and Cloudinary setup

The moderator listing form uploads product images directly to Cloudinary using short-lived signed upload parameters. The Cloudinary API secret stays on the server; it is never sent to the browser. Product records, photo URLs/public IDs, alt text, and flexible specifications are stored in the server's SQLite database.

## Required server environment variables

Set these in the backend host's environment settings (for example, Render), then redeploy/restart the backend:

- `CLOUDINARY_CLOUD_NAME` — Cloudinary cloud name.
- `CLOUDINARY_API_KEY` — Cloudinary API key.
- `CLOUDINARY_API_SECRET` — Cloudinary API secret. Keep this private; do not add its value to GitHub or frontend/Vercel variables.

The values are available from the Cloudinary Console dashboard. Do not commit real credentials to this repository.

## Listing rules

- JPG/JPEG, PNG, or WebP images only.
- Maximum 5 MB per image and 6 images per listing.
- One image is required; the first selected cover image is shown first in the storefront gallery.
- Every photo gets editable alt text; product specifications are entered as `Label: value`, one per line.
- A product must use a category and store from the same storefront.
- Product details and photo references are persisted in SQLite. The Cloudinary account stores the actual image files.

## Deployment note

The backend must use persistent storage for its SQLite database if listings need to survive host instance replacement, not merely process restarts. On hosts with ephemeral filesystems, attach a persistent disk and point the server's data directory at it. If the three Cloudinary variables are missing, the signing endpoint returns a clear configuration error rather than pretending an upload succeeded.
