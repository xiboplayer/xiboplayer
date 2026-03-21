# PWA Player Deployment Guide

## Architecture

```
User Browser
    ↓ HTTPS
https://your-cms.example.com/player/pwa/
    ↓
Reverse Proxy (SWAG/nginx, Port 443)
    ↓
Xibo CMS container
    ↓
web/chromeos/ → PWA Player Files (HTML/JS/CSS)
```

**Same origin = No CORS issues.**

The PWA player must be served from the same domain as the CMS. All API calls
(REST, SOAP `/xmds.php`, file downloads) target the CMS origin.
Browsers block cross-origin requests, so the player cannot run from a
different host or `localhost`.

## Build

```bash
git clone https://github.com/xibo-players/xiboplayer.git
cd xiboplayer
pnpm install
pnpm --filter @xiboplayer/pwa build    # Production bundle → packages/pwa/dist/
```

## Deploy to CMS

Copy `dist/*` into the CMS container's `web/chromeos/` directory.
The CMS `.htaccess` rewrites `/player/pwa/*` → `web/chromeos/*`.

```bash
# Example with podman
podman cp dist/. xibo-cms-web:/var/www/cms/web/chromeos/
```

## Verify

1. Open `https://your-cms.example.com/player/pwa/`
2. Setup page should appear on first visit
3. Enter CMS address (same domain), CMS key, display name
4. Player connects and starts showing layouts

## Alternative: Electron (for kiosk/desktop)

For local or kiosk deployments where same-origin hosting isn't available,
use the Electron wrapper. It injects CORS headers at the Chromium session
level, allowing the PWA to connect to any remote CMS.

See [xiboplayer-electron](https://github.com/xibo-players/xiboplayer-electron).

## Development

`pnpm run dev` starts a Vite dev server on `localhost:5174`. This is only
useful for UI development or testing with Electron. The dev server cannot
connect to a remote CMS due to CORS — use Electron or deploy to the CMS
for end-to-end testing.

## File Locations

| Environment | Path |
|-------------|------|
| Source | `src/` |
| Build output | `dist/` |
| CMS container | `/var/www/cms/web/chromeos/` |
| URL | `https://your-cms.example.com/player/pwa/` |
