# robworks-code

Source for [code.robworks.info](https://code.robworks.info) — Ryan Robson's portfolio and the Claude Code plugin marketplace landing page.

## Pages

- `/` — Portfolio: services, featured projects, writing, contact.
- `/plugins/` — Claude Code plugin marketplace catalog (live-fetches [`marketplace.json`](https://github.com/robworks-code/robworks-claude-code-plugins) at runtime).

## Dev

The site is plain HTML/CSS — no framework, no bundler. GitHub Pages serves `docs/` on `main`.

```bash
# Local server
(cd docs && python3 -m http.server 8765)
# → http://localhost:8765/  and  http://localhost:8765/plugins/

# Regenerate plugin cards, JSON-LD, and sitemap from the live marketplace
node scripts/build-site.js

# Offline / pre-publish (use a local marketplace.json)
MARKETPLACE_JSON_PATH=../robworks-claude-code-plugins/.claude-plugin/marketplace.json \
  node scripts/build-site.js
```

The build script is idempotent — a second run produces zero diff.

## Sentinels

`scripts/build-site.js` owns these regions:

| File | Sentinel |
| --- | --- |
| `docs/plugins/index.html` | `<!-- BEGIN:PLUGIN-CARDS -->` … `<!-- END:PLUGIN-CARDS -->` |
| `docs/plugins/index.html` | `<!-- BEGIN:JSONLD -->` … `<!-- END:JSONLD -->` |
| `docs/index.html` | `<!-- BEGIN:PROJECTS-PLUGINS -->` … `<!-- END:PROJECTS-PLUGINS -->` |
| `docs/index.html` | `<!-- BEGIN:PROJECTS-OTHER -->` … `<!-- END:PROJECTS-OTHER -->` |
| `docs/index.html` | `<!-- BEGIN:POSTS -->` … `<!-- END:POSTS -->` |
| `docs/sitemap.xml` | `<lastmod>` |

Don't hand-edit content inside the sentinels. To add a non-plugin project, append to `data/projects.json`. To add a writing post, append to `data/posts.json`.

## OG images

The portfolio OG image is generated from `scripts/og-image.html`. Render at a slightly taller viewport and crop — headless Chrome has a layout quirk where `position: absolute; bottom:` doesn't render when the body height equals the viewport exactly:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --hide-scrollbars --window-size=1200,700 \
  --screenshot=/tmp/og-raw.png \
  file:///$(pwd)/scripts/og-image.html
python3 -c "from PIL import Image; \
  Image.open('/tmp/og-raw.png').crop((0,0,1200,630)).save('docs/og-image.png')"
```

The plugins-page OG image at `docs/plugins/og-image.png` is generated the same way from `scripts/og-image-plugins.html`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --force-device-scale-factor=1 --window-size=1200,700 \
  --screenshot=/tmp/og-plugins-raw.png \
  file:///$(pwd)/scripts/og-image-plugins.html
python3 -c "from PIL import Image; \
  Image.open('/tmp/og-plugins-raw.png').crop((0,0,1200,630)).save('docs/plugins/og-image.png')"
```

It previously had no generator (it was inherited from the original catalog repo as a flat PNG), which is how its tagline kept asserting every plugin was MIT-licensed after that stopped being true. The card carries a licensing claim, so it needs to be rebuildable when the catalog's licensing changes.

## Hosting

- DNS: Namecheap zone `robworks.info`, CNAME `code → ringo380.github.io.`
- GitHub Pages: `main` branch, `/docs` folder, custom domain `code.robworks.info`, HTTPS enforced.
