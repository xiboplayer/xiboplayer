# Quick Start Guide

Get the PWA player running in 5 minutes.

## Prerequisites

- Node.js 22+ and pnpm
- Access to a Xibo CMS instance
- CMS secret key (from CMS Settings → Display Settings)

## Important: Same-Origin Requirement

The PWA player **must** be served from the same domain as the Xibo CMS.
All API calls (REST, SOAP, file downloads) go to the CMS origin, and
browsers block cross-origin requests.

For local/kiosk use, use the **Electron wrapper** which handles CORS
at the Chromium session level.

## Build

```bash
git clone https://github.com/xibo-players/xiboplayer.git
cd xiboplayer
pnpm install
pnpm --filter @xiboplayer/pwa build    # Production bundle → packages/pwa/dist/
```

## Deploy to CMS

Copy `dist/*` to the CMS `web/chromeos/` directory:

```bash
podman cp dist/. xibo-cms-web:/var/www/cms/web/chromeos/
```

## Access Player

Open: `https://your-cms.example.com/player/pwa/`

Configure with:
- **CMS Address:** `https://your-cms.example.com` (same domain)
- **CMS Key:** Your CMS key
- **Display Name:** Your display name

## Authorize in CMS

1. Open your CMS admin UI
2. Go to Displays
3. Find your display (status: Waiting)
4. Authorize it
5. Refresh the player page

The player should start downloading files and displaying layouts.

## Alternative: Electron (for kiosk/desktop)

See [xiboplayer-electron](https://github.com/xibo-players/xiboplayer-electron).

Electron can connect to any remote CMS — no same-origin restriction.

## Troubleshooting

### "Connection failed: NetworkError"
- Verify the CMS address matches the domain the player is served from
- Check browser console for CORS errors (means player is not same-origin)
- Use Electron for cross-origin setups

### "Display not authorized"
- Go to CMS → Displays → Authorize your display
- Refresh the player page

### Layouts don't show
- Check browser console for download errors
- Verify schedule has active layouts assigned to the display

## Next Steps

- See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment guide
- See [xiboplayer-electron](https://github.com/xibo-players/xiboplayer-electron) for Electron/kiosk setup
