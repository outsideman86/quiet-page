# Quiet Page

A Chrome extension that turns cluttered articles into clean, printer-friendly pages.
Choose which images to keep and how big each one prints, then print, save as PDF,
or collect the page into a library with folders.

- Website: https://outsideman86.github.io/quiet-page/
- Privacy policy: https://outsideman86.github.io/quiet-page/privacy/

## Install from this repository (desktop Chrome)

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the **`extension`** folder (the one containing `manifest.json`).
4. Pin it: puzzle-piece icon in the toolbar → pin **Quiet Page**.

To update later, replace the files in that folder and press the reload arrow on the Quiet Page card.
Don't remove the extension: removing it deletes its library.

## Use

- On any article, click the Quiet Page button or press **Alt+Shift+P**. A clean copy opens in a new tab.
- **Images:** "Keep all" / "Remove all", or untick **Include** on a single image.
- **Sizing:** "Size all" sets every image; each image's own **Size** slider overrides it.
  Images are never stretched past their real resolution.
- **Text:** A− / A+ and a Serif/Sans switch.
- **Print / Save PDF** opens Chrome's print dialog. The toolbar and library never print.

## Library

- Press **Collect** to keep a clean copy. Your image choices are saved with it.
- Click a title in the list on the left to reopen it; **↗** opens the original web page.
- **+ Folder** makes a folder; double-click a folder name to rename it.
- Drag pages onto a folder to move them (dragging a checked page moves all checked pages).
- The **⋯** button on a page has Move to, Download and Delete. Or tick several pages and use
  **Move to**, **Download** or **Delete** at the top of the list.
- **Download** saves one page as `.html`, or several as a `.zip` with your folders kept.
- Deleting a folder moves its pages to Unfiled; it never deletes pages.
- Right-click the toolbar button → **Open library** to open it on its own.

The library lives in this Chrome profile on this computer and doesn't sync between computers.

## Privacy

Quiet Page reads a page only when you press its button. Nothing is sent to the developer or anyone else.
Images load from the websites they came from, and display preferences can sync between your devices
through Chrome Sync. Details: [privacy policy](https://outsideman86.github.io/quiet-page/privacy/).

## Known limits

- Won't run on `chrome://` pages, the Chrome Web Store, or Chrome's PDF viewer.
- Pulls out only what's on the page; paywalled text you can't see won't appear.
- Home pages, search results and web apps usually have no single article to extract.
- Video, embedded tweets and interactive graphics are dropped.
- A few image hosts refuse to serve pictures outside their own site; those are left out.

## Repository layout

| Path | Contents |
| --- | --- |
| `extension/` | The extension itself (Manifest V3). Zip this folder to upload to the Chrome Web Store. |
| `extension/lib/Readability.js` | Mozilla's article-extraction library, v0.6.0 (Apache 2.0). |
| `store/` | Chrome Web Store icon and promo tiles. |
| `docs/` | Website and privacy policy, served by GitHub Pages. |

## License

MIT, see [LICENSE](LICENSE). Readability is © Arc90 Inc and Mozilla, under the Apache License 2.0.
