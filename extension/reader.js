// Quiet Page — reader page logic.
// Renders an article (a fresh conversion or one from the library), then gives each
// image its own Include / Size controls.

"use strict";

const DEFAULT_PREFS = {
  scale: 1,            // text size multiplier
  fontFamily: "serif", // "serif" | "sans"
  startRemoved: false, // start new articles with every image removed
  sizeAll: 75,         // default image width, as % of the text column
  libraryOpen: true,   // sidebar visible
};
const SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
const TINY_IMAGE_PX = 48; // icons, emoji, tracking pixels — left alone, no controls

const $ = (id) => document.getElementById(id);
let prefs = { ...DEFAULT_PREFS };
const units = []; // { el, body, check, slider, out, img, key }

// What this tab is showing.
//   kind: "home" | "session" | "library" | "message"
//   libId: library id when this article is collected (set after Collect, too)
const current = { kind: "home", libId: null, article: null, sizeAll: 75 };

// ---------------------------------------------------------------------------
// Startup

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    console.error(err);
    showMessage("Something went wrong", "Quiet Page hit an unexpected error while building this page.", "");
  });
});

// Library links change only the #hash; rebuild the page when that happens.
window.addEventListener("hashchange", () => location.reload());

async function init() {
  prefs = { ...DEFAULT_PREFS, ...(await chrome.storage.sync.get(DEFAULT_PREFS)) };
  applyTextPrefs();
  wireToolbar();

  const hash = decodeURIComponent(location.hash.slice(1));

  if (hash.startsWith("lib:")) {
    const id = hash.slice(4);
    const page = await Library.getPage(id);
    if (!page) {
      current.kind = "message";
      showMessage("This page is no longer in your library", "It may have been deleted from another tab.", "");
    } else {
      current.kind = "library";
      current.libId = id;
      renderArticle(page.article, page.imageState);
    }
  } else if (hash && hash !== "library") {
    const key = `article:${hash}`;
    const stored = (await chrome.storage.session.get(key))[key];
    if (!stored) {
      current.kind = "message";
      showMessage(
        "This clean copy has expired",
        "Clean copies are kept only until you close Chrome, unless you collect them. Go back to the original page and press the Quiet Page button again.",
        ""
      );
    } else if (stored.error) {
      current.kind = "message";
      showError(stored);
    } else {
      current.kind = "session";
      renderArticle(stored, null);
    }
  } else {
    current.kind = "home";
    showHome();
  }

  await Library.init();
  updateCollectButton();
}

// ---------------------------------------------------------------------------
// Rendering

function renderArticle(a, imageState) {
  current.article = a;
  document.title = a.title || a.sourceTitle || "Quiet Page";
  if (a.lang) document.documentElement.lang = a.lang;
  if (a.dir) $("article").dir = a.dir;

  $("title").textContent = a.title || a.sourceTitle || "Untitled";
  setOrHide($("site"), a.siteName || hostOf(a.url));
  setOrHide($("byline"), [a.byline, formatDate(a.publishedTime)].filter(Boolean).join(" · "));

  const source = $("source");
  if (a.url && /^https?:/i.test(a.url)) {
    source.append("Source: ");
    const link = document.createElement("a");
    link.href = a.url;
    link.textContent = a.url;
    link.rel = "noopener noreferrer";
    source.append(link);
  } else {
    source.hidden = true;
  }

  const content = $("content");
  content.append(buildContent(a));

  current.sizeAll = imageState && imageState.sizeAll ? imageState.sizeAll : prefs.sizeAll;
  setupImages(content, imageState);

  $("size-all").value = String(current.sizeAll);
  $("size-all-out").textContent = `${current.sizeAll}%`;

  $("article").hidden = false;
  $("article-tools").hidden = false;
}

// Sanitized article body, with duplicate headline / byline removed. Shared with export.js.
function buildContent(a) {
  const holder = document.createElement("div");
  holder.append(sanitize(a.content));
  dropDuplicateTitle(holder, a.title);
  dropDuplicateByline(holder, a.byline);
  const frag = document.createDocumentFragment();
  while (holder.firstChild) frag.append(holder.firstChild);
  return frag;
}

function setOrHide(el, text) {
  if (text) el.textContent = text;
  else el.hidden = true;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Some sites repeat the headline as the first heading in the body.
function dropDuplicateTitle(content, title) {
  if (!title) return;
  const first = content.querySelector("h1, h2");
  if (!first) return;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const before = content.textContent.indexOf(first.textContent);
  if (norm(first.textContent) === norm(title) && before >= 0 && before < 5) first.remove();
}

// The byline is already shown in the header; drop a lone "By …" line at the top of the body.
function dropDuplicateByline(content, byline) {
  if (!byline) return;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase().replace(/^by\s+/, "");
  const want = norm(byline);
  const candidates = Array.from(content.querySelectorAll("p, div, span")).slice(0, 6);
  for (const el of candidates) {
    if (el.querySelector("img")) continue;
    if (norm(el.textContent) === want) { el.remove(); return; }
  }
}

// ---------------------------------------------------------------------------
// Sanitizing: the article HTML came from an arbitrary website. Keep only plain
// content tags and safe attributes; drop anything that could run or embed code.

const KEEP_TAGS = new Set(("a abbr article aside b bdi bdo blockquote br caption cite code col colgroup " +
  "dd del dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main " +
  "mark ol p picture pre q s samp section small source span strong sub sup table tbody td tfoot th " +
  "thead time tr u ul wbr").split(" "));
const DROP_TAGS = new Set(("script style link meta base iframe frame frameset object embed applet form " +
  "input button select option textarea noscript template svg math video audio canvas dialog portal " +
  "slot title head").split(" "));
const KEEP_ATTRS = {
  "*": ["title", "lang", "dir"],
  a: ["href"],
  img: ["src", "srcset", "sizes", "alt", "width", "height"],
  source: ["srcset", "sizes", "media", "type"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "reversed", "type"],
  time: ["datetime"],
  blockquote: ["cite"],
  q: ["cite"],
};

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ""}</body>`, "text/html");
  cleanChildren(doc.body);
  const frag = document.createDocumentFragment();
  while (doc.body.firstChild) frag.append(document.adoptNode(doc.body.firstChild));
  return frag;
}

function cleanChildren(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) { node.remove(); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = node.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) { node.remove(); continue; }

    cleanChildren(node);

    if (!KEEP_TAGS.has(tag)) {
      node.replaceWith(...node.childNodes); // unknown wrapper: keep its contents
      continue;
    }
    cleanAttributes(node, tag);
  }
}

function cleanAttributes(el, tag) {
  const allowed = new Set([...(KEEP_ATTRS["*"]), ...(KEEP_ATTRS[tag] || [])]);
  for (const attr of Array.from(el.attributes)) {
    if (!allowed.has(attr.name)) el.removeAttribute(attr.name);
  }
  if (tag === "a") {
    const href = el.getAttribute("href") || "";
    if (!/^(https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute("href");
    else if (!href.startsWith("#")) { el.target = "_blank"; el.rel = "noopener noreferrer"; }
  }
  if (tag === "img") {
    const src = (el.getAttribute("src") || "").trim();
    if (!/^(https?:|data:image\/)/i.test(src)) el.removeAttribute("src");
  }
  if (el.hasAttribute("srcset")) {
    const ok = el.getAttribute("srcset").split(",").every((c) => /^\s*(https?:|data:image\/)/i.test(c) || !c.trim());
    if (!ok) el.removeAttribute("srcset");
  }
}

// ---------------------------------------------------------------------------
// Images

// A stable key for an image, so saved Include/Size choices find it again later.
function imageKey(img) {
  return img.getAttribute("src") || img.getAttribute("srcset") || "";
}

// Image units in document order: [{ root, img }]. Shared with export.js.
function findImageUnits(container) {
  const seen = new Set();
  const out = [];
  for (const img of Array.from(container.querySelectorAll("img"))) {
    if (looksTiny(img)) continue;
    const root = findUnitRoot(img, container);
    if (seen.has(root)) continue;
    seen.add(root);
    out.push({ root, img });
  }
  return out;
}

function setupImages(content, imageState) {
  for (const { root, img } of findImageUnits(content)) wrapUnit(root, img, imageState);
  updateCount();
}

function looksTiny(img) {
  const w = parseInt(img.getAttribute("width"), 10);
  const h = parseInt(img.getAttribute("height"), 10);
  return w > 0 && h > 0 && w < TINY_IMAGE_PX && h < TINY_IMAGE_PX;
}

// Treat a <figure> (image + caption) as one unit. Otherwise climb out of wrappers
// like <a>, <p>, <picture> that contain nothing but the image.
function findUnitRoot(img, content) {
  const figure = img.closest("figure");
  if (figure && content.contains(figure)) return figure;
  let node = img;
  const wrappers = new Set(["A", "P", "SPAN", "DIV", "PICTURE"]);
  while (
    node.parentElement &&
    node.parentElement !== content &&
    wrappers.has(node.parentElement.tagName) &&
    node.parentElement.children.length === 1 &&
    node.parentElement.textContent.trim() === node.textContent.trim()
  ) {
    node = node.parentElement;
  }
  return node;
}

function wrapUnit(root, img, imageState) {
  const unit = document.createElement("div");
  unit.className = "qp-media";

  const controls = document.createElement("div");
  controls.className = "qp-controls";

  const includeLabel = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox";
  includeLabel.append(check, "Include");

  const sizeWrap = document.createElement("span");
  sizeWrap.className = "qp-size";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "10";
  slider.max = "100";
  slider.step = "5";
  slider.setAttribute("aria-label", "Image size");
  const out = document.createElement("output");
  sizeWrap.append("Size", slider, out);

  controls.append(includeLabel, sizeWrap);

  const body = document.createElement("div");
  body.className = "qp-body";

  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "qp-restore";
  const thumb = document.createElement("img");
  thumb.className = "qp-thumb";
  thumb.alt = "";
  thumb.src = img.currentSrc || img.getAttribute("src") || "";
  restore.append(thumb, "Image removed — click to put it back");

  root.replaceWith(unit);
  body.append(root);
  unit.append(controls, body, restore);

  const key = imageKey(img);
  const record = { el: unit, body, check, slider, out, img, key };
  units.push(record);

  const saved = imageState && imageState.images ? imageState.images[key] : null;
  if (saved) {
    setIncluded(record, saved.inc !== false);
    setSize(record, saved.size || current.sizeAll);
  } else {
    setIncluded(record, imageState ? true : !prefs.startRemoved);
    setSize(record, current.sizeAll);
  }

  check.addEventListener("change", () => { setIncluded(record, check.checked); updateCount(); imagesChanged(); });
  restore.addEventListener("click", () => { setIncluded(record, true); updateCount(); imagesChanged(); });
  slider.addEventListener("input", () => setSize(record, Number(slider.value)));
  slider.addEventListener("change", imagesChanged);

  const onLoad = () => {
    if (!thumb.getAttribute("src")) thumb.src = img.currentSrc || img.src;
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w && h && w < TINY_IMAGE_PX && h < TINY_IMAGE_PX) return unwrap(record, root);
    // Never stretch an image beyond its real size (it would print blurry).
    if (w) img.style.maxWidth = `${w}px`;
  };
  const onError = () => {
    unit.dataset.broken = "true";
    updateCount();
  };
  if (img.complete && img.naturalWidth) onLoad();
  else if (img.complete && img.getAttribute("src")) onError();
  else if (!img.getAttribute("src") && !img.getAttribute("srcset")) onError();
  else {
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
  }
}

function unwrap(record, root) {
  record.el.replaceWith(root);
  units.splice(units.indexOf(record), 1);
  updateCount();
}

function setIncluded(record, included) {
  record.check.checked = included;
  record.el.dataset.included = String(included);
}

function setSize(record, pct) {
  record.slider.value = String(pct);
  record.out.textContent = `${pct}%`;
  record.body.style.width = `${pct}%`;
}

function updateCount() {
  const usable = units.filter((u) => u.el.dataset.broken !== "true");
  const kept = usable.filter((u) => u.el.dataset.included === "true").length;
  const count = $("img-count");
  if (!usable.length) {
    count.textContent = "None in article";
    $("img-keep-all").disabled = $("img-remove-all").disabled = $("size-all").disabled = true;
    $("size-tools").style.opacity = ".5";
    return;
  }
  count.textContent = `${kept} of ${usable.length} kept`;
}

// The image choices on screen right now, in the form the library stores.
function currentImageState() {
  const images = {};
  for (const u of units) {
    if (!u.key) continue;
    images[u.key] = { inc: u.el.dataset.included === "true", size: Number(u.slider.value) };
  }
  return { sizeAll: current.sizeAll, images };
}

// Collected pages remember image choices; save shortly after each change.
let saveTimer = null;
function imagesChanged() {
  if (!current.libId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => Library.savePageState(current.libId, currentImageState()), 400);
}

// ---------------------------------------------------------------------------
// Toolbar

function wireToolbar() {
  $("img-keep-all").addEventListener("click", () => { units.forEach((u) => setIncluded(u, true)); updateCount(); imagesChanged(); });
  $("img-remove-all").addEventListener("click", () => { units.forEach((u) => setIncluded(u, false)); updateCount(); imagesChanged(); });

  const sizeAll = $("size-all");
  sizeAll.addEventListener("input", () => {
    const pct = Number(sizeAll.value);
    current.sizeAll = pct;
    $("size-all-out").textContent = `${pct}%`;
    units.forEach((u) => setSize(u, pct));
  });
  sizeAll.addEventListener("change", () => {
    savePref({ sizeAll: Number(sizeAll.value) });
    imagesChanged();
  });

  $("font-down").addEventListener("click", () => stepScale(-1));
  $("font-up").addEventListener("click", () => stepScale(1));
  $("font-family").addEventListener("click", () => {
    prefs.fontFamily = prefs.fontFamily === "serif" ? "sans" : "serif";
    applyTextPrefs();
    savePref({ fontFamily: prefs.fontFamily });
  });

  const startRemoved = $("pref-start-removed");
  startRemoved.checked = prefs.startRemoved;
  startRemoved.addEventListener("change", () => savePref({ startRemoved: startRemoved.checked }));

  $("collect").addEventListener("click", onCollect);
  $("print").addEventListener("click", () => window.print());

  setLibraryOpen(prefs.libraryOpen);
  $("lib-toggle").addEventListener("click", () => {
    const open = !document.body.classList.contains("lib-open");
    setLibraryOpen(open);
    savePref({ libraryOpen: open });
  });
  $("lib-close").addEventListener("click", () => { setLibraryOpen(false); savePref({ libraryOpen: false }); });
}

function setLibraryOpen(open) {
  document.body.classList.toggle("lib-open", open);
  $("lib-toggle").setAttribute("aria-expanded", String(open));
}

async function onCollect() {
  if (!current.article) return;
  if (current.libId) {
    // Already collected: just show it in the library.
    setLibraryOpen(true);
    Library.reveal(current.libId);
    return;
  }
  const btn = $("collect");
  btn.disabled = true;
  try {
    current.libId = await Library.collect(current.article, currentImageState());
    current.kind = "library";
    // Point this tab at the saved copy so a reload keeps working after Chrome restarts.
    history.replaceState(null, "", `#lib:${encodeURIComponent(current.libId)}`);
    setLibraryOpen(true);
    Library.reveal(current.libId);
  } catch (err) {
    console.error(err);
    Library.status("Couldn’t collect this page: " + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
    updateCollectButton();
  }
}

function updateCollectButton() {
  const btn = $("collect");
  if (current.libId) {
    btn.innerHTML = "&#10003; Collected";
    btn.classList.add("is-collected");
    btn.title = "In your library. Click to show it in the list.";
  } else {
    btn.innerHTML = "&#9734; Collect";
    btn.classList.remove("is-collected");
    btn.title = "Keep this clean copy in your library";
  }
}

// Called by the library when the page open in this tab gets deleted elsewhere.
function currentPageDeleted() {
  current.libId = null;
  current.kind = "session";
  updateCollectButton();
  Library.status("This page was removed from your library. Press Collect to keep it again.");
}

function stepScale(direction) {
  let i = SCALE_STEPS.indexOf(prefs.scale);
  if (i < 0) i = SCALE_STEPS.indexOf(1);
  i = Math.min(SCALE_STEPS.length - 1, Math.max(0, i + direction));
  prefs.scale = SCALE_STEPS[i];
  applyTextPrefs();
  savePref({ scale: prefs.scale });
}

function applyTextPrefs() {
  document.documentElement.style.setProperty("--scale", String(prefs.scale));
  document.body.classList.toggle("font-sans", prefs.fontFamily === "sans");
  const btn = $("font-family");
  if (btn) btn.textContent = prefs.fontFamily === "serif" ? "Sans" : "Serif";
}

function savePref(patch) {
  Object.assign(prefs, patch);
  chrome.storage.sync.set(patch).catch(() => {});
}

// ---------------------------------------------------------------------------
// Messages

function showHome() {
  document.title = "Quiet Page library";
  $("message-title").textContent = "Your library";
  $("message-body").textContent =
    "Pick a page from the list on the left to read it again. To add pages, press the Quiet Page button on any article, then press Collect.";
  $("message").hidden = false;
  setLibraryOpen(true);
}

function showError(data) {
  const url = data.url || "";
  if (data.error === "CANT_ACCESS") {
    return showMessage(
      "Chrome won’t let extensions read this page",
      "Built-in pages (like chrome:// pages and the Chrome Web Store), some PDF viewers, and a few protected sites block extensions. Try it on a regular article page.",
      url
    );
  }
  if (data.error === "TOO_LARGE") {
    return showMessage("This page is too large", "The article was too big to hold in memory for a clean copy.", url);
  }
  return showMessage(
    "Couldn’t find an article on this page",
    "Quiet Page works best on single articles and blog posts. Home pages, search results, comment threads and web apps usually don’t have one main block of text to pull out.",
    url
  );
}

function showMessage(title, body, url) {
  document.title = "Quiet Page";
  $("message-title").textContent = title;
  $("message-body").textContent = body;
  if (url && /^https?:/i.test(url)) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = "Back to the original page";
    $("message-link").append(link);
  }
  $("message").hidden = false;
}
