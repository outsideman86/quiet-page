// Quiet Page — background service worker.
// When the toolbar button (or Alt+Shift+P) is pressed, pull the article out of the
// current tab with Mozilla's Readability, stash it in session storage, and open the
// clean reader page in a new tab next to the original.

const MAX_SAVED_ARTICLES = 15;

chrome.action.onClicked.addListener((tab) => {
  openCleanCopy(tab);
});

// Right-click the toolbar button → "Open library".
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "open-library", title: "Open library", contexts: ["action"] });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-library") {
    chrome.tabs.create({ url: chrome.runtime.getURL("reader.html#library") });
  }
});

async function openCleanCopy(tab) {
  let payload;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/Readability.js"],
    });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractArticle,
    });
    payload = (injection && injection.result) || { error: "NO_ARTICLE" };
  } catch (err) {
    // Chrome blocks extensions on chrome:// pages, the Web Store, some PDF viewers, etc.
    payload = { error: "CANT_ACCESS", detail: String((err && err.message) || err) };
  }

  payload.url = payload.url || tab.url || "";
  payload.sourceTitle = payload.sourceTitle || tab.title || "";
  payload.savedAt = Date.now();

  const id = `${payload.savedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await saveArticle(id, payload);
  } catch (err) {
    await saveArticle(id, {
      error: "TOO_LARGE",
      url: payload.url,
      savedAt: payload.savedAt,
      detail: String((err && err.message) || err),
    });
  }

  const createProps = { url: chrome.runtime.getURL(`reader.html#${id}`) };
  if (typeof tab.index === "number") createProps.index = tab.index + 1;
  if (typeof tab.id === "number") createProps.openerTabId = tab.id;
  await chrome.tabs.create(createProps);
}

async function saveArticle(id, payload) {
  const everything = await chrome.storage.session.get(null);
  const oldKeys = Object.keys(everything)
    .filter((k) => k.startsWith("article:"))
    .sort((a, b) => (everything[a].savedAt || 0) - (everything[b].savedAt || 0));
  const toRemove = oldKeys.slice(0, Math.max(0, oldKeys.length - (MAX_SAVED_ARTICLES - 1)));
  if (toRemove.length) await chrome.storage.session.remove(toRemove);
  await chrome.storage.session.set({ [`article:${id}`]: payload });
}

// Runs inside the web page (isolated world), after lib/Readability.js has been injected.
// Must be self-contained: Chrome serializes this function and runs it in the page.
function extractArticle() {
  /* global Readability */
  const MIN_TEXT = 250;

  function preparedClone() {
    const clone = document.cloneNode(true);
    // Lazy-loaded images often keep a placeholder in `src` while the browser shows
    // the real picture. Copy the real one across so it survives extraction.
    const live = document.querySelectorAll("img");
    const copies = clone.querySelectorAll("img");
    if (live.length === copies.length) {
      for (let i = 0; i < live.length; i++) {
        const real = live[i].currentSrc || "";
        const src = copies[i].getAttribute("src") || "";
        if (/^https?:/i.test(real) && (!src || /^data:/i.test(src) || src === "about:blank")) {
          copies[i].setAttribute("src", real);
        }
      }
    }
    return clone;
  }

  function run(options) {
    try {
      return new Readability(preparedClone(), options).parse();
    } catch (e) {
      return null;
    }
  }

  function textLength(a) {
    return a && a.textContent ? a.textContent.trim().length : 0;
  }

  let article = run({});
  if (textLength(article) < MIN_TEXT) {
    // Short pages (or unusual layouts) — try again with a looser threshold.
    const retry = run({ charThreshold: 100 });
    if (textLength(retry) > textLength(article)) article = retry;
  }

  if (!article || !article.content || textLength(article) < 40) {
    return { error: "NO_ARTICLE", url: location.href, sourceTitle: document.title };
  }

  return {
    title: article.title || document.title || "",
    byline: article.byline || "",
    siteName: article.siteName || "",
    publishedTime: article.publishedTime || "",
    excerpt: article.excerpt || "",
    lang: article.lang || document.documentElement.lang || "",
    dir: article.dir || "",
    content: article.content,
    url: location.href,
    sourceTitle: document.title,
  };
}
