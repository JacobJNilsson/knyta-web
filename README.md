# knyta-web

The marketing site for [Knyta](https://knyta.net) — an AI-assisted data-ingestion engine. Postgres is the supported destination today; APIs, other databases, and more are in the works.

Fully static: no client-side JavaScript, no cookies, no trackers. Dark mode follows `prefers-color-scheme`.

## Stack

- [Astro](https://astro.build) — static output only
- Self-hosted fonts via Fontsource (Bricolage Grotesque + IBM Plex Mono)
- Hand-rolled CSS in `src/styles/global.css` (design tokens at the top)

The knot mark is a parametric trefoil (`x = sin t + 2 sin 2t, y = cos t − 2 cos 2t`) rendered as a single SVG stroke — the path string lives in `src/pages/index.astro` and `public/favicon.svg`.

## Development

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # static output in dist/
npm run preview
```

## Deployment (Vercel)

The repo is imported as a Vercel project; Vercel auto-detects Astro (build `astro build`, output `dist/`). Every push to `main` deploys production; PRs get preview deployments.

Domain: `knyta.net` (+ `www` redirect) is attached to the Vercel project. DNS lives wherever the domain is registered — point `A @ → 76.76.21.21` and `CNAME www → cname.vercel-dns.com` if not using Vercel nameservers.

## TODO

- [ ] **Set up email for `hello@knyta.net`.** `dig MX knyta.net` returns nothing
      on 2026-08-04, so the domain accepts no mail. Every call to action on the
      site points at that address, so every visitor who answers gets a bounce.
      Use registrar forwarding or Cloudflare Email Routing, then send a test
      message from an outside account before the next deploy.
- [ ] Redraw `public/og.png`. The card still shows the old headline
      ("Customer data arrives messy. Yours lands clean."), so a shared link
      contradicts the page. Set it to "Their export is a mess. Your table
      isn't." in the same layout.
