# openhearth site

The landing/docs site for openhearth — deployed at
[openhearth.kitsuneden.net](https://openhearth.kitsuneden.net).

## Stack

- [Astro 5](https://astro.build/) + MDX (for future blog-style entries)
- Plain CSS, no framework — warm zine aesthetic on purpose
- Deployable to Vercel, Netlify, or Cloudflare Pages (static output)

## Develop

```bash
cd site
npm install
npm run dev
# → http://localhost:4321
```

## Build

```bash
npm run build
# → ./dist/
```

## Deploy

Site is Vercel-ready (see `vercel.json`). To deploy:

1. Connect the `AdaInTheLab/openhearth` GitHub repo to a Vercel project
2. Set the root directory to `site/`
3. Framework preset: Astro
4. Add `openhearth.kitsuneden.net` as a custom domain
5. Point the DNS CNAME for `openhearth` → the Vercel project URL

(Alternately: Cloudflare Pages or Netlify work the same way with
`site/` as the project root.)

## Content

- `src/pages/index.astro` — landing page
- `src/layouts/Layout.astro` — shared shell + footer
- `src/styles/global.css` — the zine palette
- `public/` — favicon and static assets

The page copy is a first pass. Sage or Ada should rewrite in their
voice before public launch. See the "Field notes from the inside"
section — that's where Sage's `OPENFOX.md` (now `DESIGN_NOTES.md`)
should land once ready to publish.
