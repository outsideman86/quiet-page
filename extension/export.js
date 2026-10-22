// Quiet Page — turns a collected page into a standalone .html file for download.
// Keeps the reader layout and print styles, applies the saved image choices, and
// embeds pictures in the file when the image host allows it (so it works offline).

"use strict";

const QPExport = (() => {
  const MAX_INLINE_BYTES = 6 * 1024 * 1024; // per image

  const CSS = `
:root{--ink:#1d1b18;--muted:#6b655c;--rule:#ddd6cb;--accent:#2f5d50}
*{box-sizing:border-box}
html,body{margin:0;background:#ece8e1;color:var(--ink)}
.page{max-width:760px;margin:28px auto 80px;padding:56px 64px 72px;background:#fff;border:1px solid var(--rule);border-radius:4px}
@media (max-width:820px){.page{margin:0;border:none;padding:28px 20px 48px}}
article{font-family:Charter,"Bitstream Charter","Sitka Text",Cambria,Georgia,serif;font-size:19px;line-height:1.6;overflow-wrap:break-word}
.meta{margin-bottom:2em;padding-bottom:1.2em;border-bottom:1px solid var(--rule)}
.site{margin:0 0 .6em;font:600 12px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1.title{margin:0 0 .45em;font-size:1.9em;line-height:1.18}
.byline{margin:0 0 .3em;color:var(--muted);font-size:.9em}
.source{margin:0;font:12px/1.4 system-ui,sans-serif;color:var(--muted);word-break:break-all}
.source a{color:inherit}
.content h1,.content h2,.content h3,.content h4{line-height:1.25;margin:1.6em 0 .5em}
.content h1{font-size:1.5em}.content h2{font-size:1.3em}.content h3{font-size:1.12em}
.content p{margin:0 0 1em}
.content a{color:var(--accent)}
.content blockquote{margin:1.2em 0;padding:0 0 0 1em;border-left:3px solid var(--rule);color:var(--muted)}
.content pre,.content code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
.content pre{white-space:pre-wrap;background:#f7f4ef;padding:.8em 1em}
.content table{border-collapse:collapse;width:100%;font-size:.9em;margin:1em 0}
.content th,.content td{border:1px solid var(--rule);padding:.35em .5em;text-align:left;vertical-align:top}
.content figure{margin:0}
.content figcaption{margin-top:.45em;font:13px/1.45 system-ui,sans-serif;color:var(--muted)}
.content img{max-width:100%;height:auto}
.qp-media{margin:1.6em auto}
.qp-media img{display:block;width:100%;height:auto;margin:0 auto}
.saved-note{margin-top:3em;font:11px/1.4 system-ui,sans-serif;color:var(--muted)}
@page{margin:.75in}
@media print{
  html,body{background:#fff}
  .page{max-width:none;margin:0;padding:0;border:none}
  article{font-size:11.5pt;line-height:1.5}
  .content a{color:#000;text-decoration:none}
  .qp-media,figure,img,table,pre,blockquote{break-inside:avoid}
  h1,h2,h3,h4{break-after:avoid}
  p{orphans:3;widows:3}
}`;

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function fetchAsDataUrl(src) {
    if (!/^https?:/i.test(src)) return null;
    try {
      const res = await fetch(src, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.type.startsWith("image/") || blob.size > MAX_INLINE_BYTES) return null;
      return await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      });
    } catch {
      return null; // host doesn't allow it; the file will link to the online image instead
    }
  }

  // page = { article, imageState, savedAt }
  async function buildHtml(page) {
    const a = page.article;
    const state = page.imageState || {};
    const sizeAll = state.sizeAll || 75;
    const holder = document.createElement("div");
    holder.append(buildContent(a));

    const jobs = [];
    for (const { root, img } of findImageUnits(holder)) {
      const saved = state.images ? state.images[imageKey(img)] : null;
      if (saved && saved.inc === false) { root.remove(); continue; }
      const wrap = document.createElement("div");
      wrap.className = "qp-media";
      wrap.style.width = `${(saved && saved.size) || sizeAll}%`;
      root.replaceWith(wrap);
      wrap.append(root);

      // Use one plain src so the file doesn't depend on responsive image lists.
      const picture = img.closest("picture");
      if (picture) picture.querySelectorAll("source").forEach((s) => s.remove());
      if (!img.getAttribute("src") && img.getAttribute("srcset")) {
        img.setAttribute("src", img.getAttribute("srcset").split(",").pop().trim().split(/\s+/)[0]);
      }
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      const src = img.getAttribute("src");
      if (src) jobs.push(fetchAsDataUrl(src).then((data) => { if (data) img.setAttribute("src", data); }));
    }
    await Promise.all(jobs);

    const meta = [a.byline, formatDate(a.publishedTime)].filter(Boolean).join(" · ");
    const site = a.siteName || hostOf(a.url);
    const saved = new Date(page.savedAt || Date.now()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const url = /^https?:/i.test(a.url || "") ? a.url : "";

    return `<!doctype html>
<html lang="${esc(a.lang || "en")}"${a.dir ? ` dir="${esc(a.dir)}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(a.title || a.sourceTitle || "Untitled")}</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
<article>
<header class="meta">
${site ? `<p class="site">${esc(site)}</p>` : ""}
<h1 class="title">${esc(a.title || a.sourceTitle || "Untitled")}</h1>
${meta ? `<p class="byline">${esc(meta)}</p>` : ""}
${url ? `<p class="source">Source: <a href="${esc(url)}">${esc(url)}</a></p>` : ""}
</header>
<div class="content">
${holder.innerHTML}
</div>
<p class="saved-note">Saved with Quiet Page on ${esc(saved)}.</p>
</article>
</main>
</body>
</html>
`;
  }

  // Safe, readable file name from a title.
  function fileName(title, used) {
    let base = String(title || "Untitled")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, "") || "Untitled";
    let name = base;
    let n = 2;
    while (used && used.has(name.toLowerCase())) name = `${base} (${n++})`;
    if (used) used.add(name.toLowerCase());
    return name;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return { buildHtml, fileName, saveBlob };
})();
