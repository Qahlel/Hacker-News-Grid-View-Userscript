# Hacker News Grid View Userscript

A Tampermonkey/Greasemonkey userscript that transforms the default Hacker News listing into a visual card grid with lazy-loaded thumbnails and a split-pane reader.

Inspired by [Show HN: A native macOS client for Hacker News, built with SwiftUI](https://news.ycombinator.com/item?id=47088166) — built for those of us on Windows/Linux.

---

## Screenshot

![HN Grid View](https://raw.githubusercontent.com/Qahlel/Hacker-News-Grid-View-Userscript/main/firefox-2026-0222-1158-48.jpg)

---

## Features

- **Card grid layout** — replaces the default list with a responsive grid (auto-fills based on viewport width)
- **Lazy thumbnails** — fetches `og:image` / `twitter:image` per story as you scroll; falls back to favicon + domain
- **Split-pane reader** — article on the left, HN comments on the right, no tab switching required
- **Draggable divider** — resize the two panes by dragging the handle
- **Swap panes** — flip article and comments sides with one click
- **Inline article rendering** — fetches and inlines external stylesheets to work around CSP restrictions; falls back gracefully with an "Open in new tab" link
- **Algolia search** — search bar in the topbar opens HN Algolia search in a new tab
- **Toggle view** — switch between grid and the original HN list view at any time
- **Thumbnail cache** — resolved `og:image` URLs are cached in `sessionStorage` to avoid redundant fetches

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox/Safari) or [Greasemonkey](https://www.greasespot.net/) (Firefox)
2. Click **[Install Script](./Hacker-News-Grid-View-Userscript-7.0.0.js)** — your userscript manager will prompt for confirmation
3. Navigate to [news.ycombinator.com](https://news.ycombinator.com)

---

## Permissions

| Permission | Reason |
|---|---|
| `GM_xmlhttpRequest` | Fetch external pages and stylesheets, bypassing CORS |
| `GM_addElement` | Inject thumbnail/favicon `<img>` elements outside HN's `img-src` CSP |
| `@connect *` | Required by `GM_xmlhttpRequest` to reach arbitrary article domains |

---

## Known Limitations

- Some sites block iframe embedding (`X-Frame-Options: DENY`), which prevents inline article rendering. The pane will display a fallback "Open in new tab" link in these cases.
- A small number of sites serve stylesheets that fail to rewrite correctly, which may result in unstyled article content.
- HN's comment iframe is scaled to 140% font size for readability — this is hardcoded and not yet configurable.

---

## Contributing

Issues and PRs are welcome. The script is intentionally single-file to stay compatible with userscript managers without a build step.

---

## License

MIT
