// Quiet Page — the library sidebar: collected pages, folders, drag-and-drop,
// and single or bulk Delete / Move to / Download.
//
// Storage (chrome.storage.local, kept until the user deletes it):
//   "lib:index"      { folders: [{ id, name, created }], pages: [{ id, title, url, site, folderId, savedAt }] }
//   "lib:page:<id>"  { article, imageState, savedAt }

"use strict";

const Library = (() => {
  const INDEX_KEY = "lib:index";
  const pageKey = (id) => `lib:page:${id}`;
  const DRAG_TYPE = "application/x-quiet-page-ids";
  const UNFILED = "";

  let index = { folders: [], pages: [] };
  const selected = new Set();
  let collapsed = new Set(readLocal("qp-collapsed", []));
  let editing = null; // { mode: "new" | "rename", folderId?, thenMove?: [ids] }
  let statusTimer = null;

  // ---------------------------------------------------------------------------
  // Storage

  function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  async function loadIndex() {
    const got = await chrome.storage.local.get(INDEX_KEY);
    const ix = got[INDEX_KEY] || {};
    return { folders: ix.folders || [], pages: ix.pages || [] };
  }

  async function mutateIndex(fn) {
    const ix = await loadIndex();
    fn(ix);
    await chrome.storage.local.set({ [INDEX_KEY]: ix });
    index = ix;
    render();
  }

  async function getPage(id) {
    const key = pageKey(id);
    return (await chrome.storage.local.get(key))[key] || null;
  }

  async function collect(article, imageState) {
    const id = newId();
    const savedAt = Date.now();
    await chrome.storage.local.set({ [pageKey(id)]: { article, imageState, savedAt } });
    await mutateIndex((ix) => {
      ix.pages.unshift({
        id,
        title: article.title || article.sourceTitle || "Untitled",
        url: article.url || "",
        site: article.siteName || hostOf(article.url),
        folderId: null,
        savedAt,
      });
    });
    status("Collected. Drag it into a folder, or use the ⋯ menu to move it.");
    return id;
  }

  async function savePageState(id, imageState) {
    const page = await getPage(id);
    if (!page) return;
    page.imageState = imageState;
    await chrome.storage.local.set({ [pageKey(id)]: page });
  }

  async function deletePages(ids) {
    if (!ids.length) return;
    await chrome.storage.local.remove(ids.map(pageKey));
    const gone = new Set(ids);
    ids.forEach((id) => selected.delete(id));
    await mutateIndex((ix) => { ix.pages = ix.pages.filter((p) => !gone.has(p.id)); });
    status(ids.length === 1 ? "Deleted 1 page." : `Deleted ${ids.length} pages.`);
  }

  async function movePages(ids, folderId) {
    if (!ids.length) return;
    const moving = new Set(ids);
    const target = folderId || null;
    await mutateIndex((ix) => {
      for (const p of ix.pages) if (moving.has(p.id)) p.folderId = target;
    });
    if (target) { collapsed.delete(target); saveCollapsed(); render(); }
    const where = target ? `“${folderName(target)}”` : "Unfiled";
    status(ids.length === 1 ? `Moved to ${where}.` : `Moved ${ids.length} pages to ${where}.`);
  }

  async function createFolder(name) {
    const id = newId();
    await mutateIndex((ix) => { ix.folders.push({ id, name, created: Date.now() }); });
    return id;
  }

  async function renameFolder(id, name) {
    await mutateIndex((ix) => {
      const f = ix.folders.find((x) => x.id === id);
      if (f) f.name = name;
    });
  }

  async function deleteFolder(id) {
    const f = index.folders.find((x) => x.id === id);
    if (!f) return;
    const count = index.pages.filter((p) => p.folderId === id).length;
    const msg = count
      ? `Delete the folder “${f.name}”?\n\nThe ${count === 1 ? "page" : `${count} pages`} inside will move to Unfiled. Nothing else is deleted.`
      : `Delete the empty folder “${f.name}”?`;
    if (!confirm(msg)) return;
    await mutateIndex((ix) => {
      ix.folders = ix.folders.filter((x) => x.id !== id);
      for (const p of ix.pages) if (p.folderId === id) p.folderId = null;
    });
    status(`Deleted folder “${f.name}”.`);
  }

  function confirmDelete(ids) {
    if (!ids.length) return;
    const one = index.pages.find((p) => p.id === ids[0]);
    const msg = ids.length === 1
      ? `Delete “${one ? one.title : "this page"}” from your library?\n\nThe original web page isn’t affected.`
      : `Delete ${ids.length} pages from your library?\n\nThe original web pages aren’t affected.`;
    if (confirm(msg)) deletePages(ids);
  }

  // ---------------------------------------------------------------------------
  // Downloads

  async function download(ids) {
    const pages = index.pages.filter((p) => ids.includes(p.id));
    if (!pages.length) return;
    status(pages.length === 1 ? "Preparing download…" : `Preparing ${pages.length} pages…`);
    try {
      if (pages.length === 1) {
        const data = await getPage(pages[0].id);
        if (!data) throw new Error("page not found");
        const html = await QPExport.buildHtml(data);
        QPExport.saveBlob(new Blob([html], { type: "text/html" }), `${QPExport.fileName(pages[0].title)}.html`);
        status("Downloaded 1 page.");
        return;
      }
      const usedByFolder = new Map();
      const files = [];
      for (const p of pages) {
        const data = await getPage(p.id);
        if (!data) continue;
        const folder = p.folderId ? QPExport.fileName(folderName(p.folderId)) : "";
        if (!usedByFolder.has(folder)) usedByFolder.set(folder, new Set());
        const name = QPExport.fileName(p.title, usedByFolder.get(folder));
        files.push({ name: `${folder ? folder + "/" : ""}${name}.html`, data: await QPExport.buildHtml(data) });
      }
      const stamp = new Date().toISOString().slice(0, 10);
      QPExport.saveBlob(QPZip.makeZip(files), `Quiet Page ${stamp}.zip`);
      status(`Downloaded ${files.length} pages as a .zip file.`);
    } catch (err) {
      console.error(err);
      status("Download failed: " + (err && err.message ? err.message : err));
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers

  function folderName(id) {
    const f = index.folders.find((x) => x.id === id);
    return f ? f.name : "Unfiled";
  }

  function readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }

  function saveCollapsed() {
    try { localStorage.setItem("qp-collapsed", JSON.stringify([...collapsed])); } catch {}
  }

  function shortDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
    node.append(...kids.filter((k) => k !== null && k !== undefined));
    return node;
  }

  function status(text) {
    const s = $("lib-status");
    s.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { s.textContent = ""; }, 6000);
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render() {
    const tree = $("lib-tree");
    const scroll = tree.scrollTop;
    tree.textContent = "";

    const folders = [...index.folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const pagesIn = (fid) => index.pages
      .filter((p) => (p.folderId || null) === fid)
      .sort((a, b) => b.savedAt - a.savedAt);

    if (editing && editing.mode === "new") tree.append(folderEditor(null));

    for (const f of folders) tree.append(folderBlock(f.id, f.name, pagesIn(f.id)));

    const unfiled = pagesIn(null);
    if (unfiled.length || folders.length) tree.append(folderBlock(UNFILED, "Unfiled", unfiled));

    $("lib-empty").hidden = index.pages.length > 0 || index.folders.length > 0 || !!editing;
    updateBulk();
    tree.scrollTop = scroll;
  }

  function folderBlock(fid, name, pages) {
    const isUnfiled = fid === UNFILED;
    const isCollapsed = collapsed.has(fid || "unfiled");

    const caret = el("button", {
      type: "button",
      class: "lib-caret",
      "aria-label": isCollapsed ? `Expand ${name}` : `Collapse ${name}`,
      "aria-expanded": String(!isCollapsed),
      onclick: () => {
        const k = fid || "unfiled";
        collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
        saveCollapsed();
        render();
      },
    }, isCollapsed ? "▸" : "▾");

    const ids = pages.map((p) => p.id);
    const chosen = ids.filter((id) => selected.has(id)).length;
    const check = el("input", {
      type: "checkbox",
      "aria-label": `Select every page in ${name}`,
      disabled: !ids.length,
      onchange: () => {
        if (check.checked) ids.forEach((id) => selected.add(id));
        else ids.forEach((id) => selected.delete(id));
        render();
      },
    });
    check.checked = !!ids.length && chosen === ids.length;
    check.indeterminate = chosen > 0 && chosen < ids.length;

    let label;
    if (editing && editing.mode === "rename" && editing.folderId === fid) {
      label = folderEditor(fid, name);
    } else {
      label = el("span", {
        class: "lib-folder-name",
        title: isUnfiled ? "Pages not in a folder" : `${name} — double-click to rename`,
        ondblclick: isUnfiled ? null : () => { editing = { mode: "rename", folderId: fid }; render(); },
      }, isUnfiled ? "" : "📁 ", name);
    }

    const more = isUnfiled ? null : el("button", {
      type: "button",
      class: "lib-icon lib-more",
      "aria-label": `Options for folder ${name}`,
      title: "Folder options",
      onclick: (e) => openMenu(e.currentTarget, [
        { label: "Rename", onClick: () => { editing = { mode: "rename", folderId: fid }; render(); } },
        { label: "Download folder", disabled: !ids.length, onClick: () => download(ids) },
        { sep: true },
        { label: "Delete folder", danger: true, onClick: () => deleteFolder(fid) },
      ]),
    }, "⋯");

    const row = el("div", { class: "lib-folder-row" },
      caret, check, label, el("span", { class: "lib-count" }, String(pages.length)), more);

    const list = el("ul", { class: "lib-pages", hidden: isCollapsed });
    for (const p of pages) list.append(pageRow(p));
    if (!pages.length && !isCollapsed) {
      list.append(el("li", { class: "lib-drop-hint" }, isUnfiled ? "Drag pages here to take them out of a folder" : "Empty — drag pages here"));
    }

    const block = el("section", { class: "lib-folder", dataset: { folder: fid } }, row, list);
    makeDropTarget(block, fid || null);
    return block;
  }

  function folderEditor(fid, value = "") {
    const input = el("input", {
      type: "text",
      class: "lib-folder-input",
      value,
      maxLength: 80,
      placeholder: "Folder name",
      "aria-label": "Folder name",
    });
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const job = editing;
      editing = null;
      if (save && name) {
        if (job.mode === "new") {
          const id = await createFolder(name);
          if (job.thenMove && job.thenMove.length) await movePages(job.thenMove, id);
          else status(`Created folder “${name}”.`);
        } else {
          await renameFolder(job.folderId, name);
        }
      } else {
        render();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    requestAnimationFrame(() => { input.focus(); input.select(); });
    if (fid === null) return el("div", { class: "lib-folder lib-folder-new" }, el("div", { class: "lib-folder-row" }, el("span", { class: "lib-caret" }, "📁"), input));
    return input;
  }

  function pageRow(p) {
    const isCurrent = current.libId === p.id;
    const check = el("input", {
      type: "checkbox",
      checked: selected.has(p.id),
      "aria-label": `Select ${p.title}`,
      onchange: () => {
        check.checked ? selected.add(p.id) : selected.delete(p.id);
        render();
      },
    });

    const title = el("a", {
      class: "lib-title",
      href: `reader.html#lib:${encodeURIComponent(p.id)}`,
      title: p.title,
      draggable: false,
    }, el("span", { class: "lib-title-text" }, p.title),
       el("span", { class: "lib-sub" }, [p.site, shortDate(p.savedAt)].filter(Boolean).join(" · ")));

    const original = /^https?:/i.test(p.url)
      ? el("a", {
          class: "lib-icon lib-orig",
          href: p.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: `Open the original page\n${p.url}`,
          "aria-label": "Open the original page",
          draggable: false,
        }, "↗")
      : null;

    const more = el("button", {
      type: "button",
      class: "lib-icon lib-more",
      "aria-label": `Options for ${p.title}`,
      title: "Page options",
      onclick: (e) => openMenu(e.currentTarget, [
        { label: "Open clean copy", onClick: () => { location.href = title.href; } },
        original ? { label: "Open original page", onClick: () => window.open(p.url, "_blank", "noopener") } : null,
        { sep: true },
        ...moveItems([p.id], p.folderId || null),
        { sep: true },
        { label: "Download", onClick: () => download([p.id]) },
        { label: "Delete", danger: true, onClick: () => confirmDelete([p.id]) },
      ]),
    }, "⋯");

    const li = el("li", {
      class: "lib-page" + (isCurrent ? " is-current" : "") + (selected.has(p.id) ? " is-selected" : ""),
      draggable: true,
      dataset: { id: p.id },
    }, check, title, original, more);

    li.addEventListener("dragstart", (e) => {
      const ids = selected.has(p.id) ? [...selected] : [p.id];
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.setData("text/plain", ids.length === 1 ? p.title : `${ids.length} pages`);
      e.dataTransfer.effectAllowed = "move";
      document.body.classList.add("lib-dragging");
      li.classList.add("is-dragging");
    });
    li.addEventListener("dragend", () => {
      document.body.classList.remove("lib-dragging");
      li.classList.remove("is-dragging");
      document.querySelectorAll(".lib-folder.is-drop").forEach((n) => n.classList.remove("is-drop"));
    });
    return li;
  }

  // Menu entries for "Move to": every folder except the one it's already in.
  function moveItems(ids, fromFolder) {
    const items = [{ heading: "Move to" }];
    const folders = [...index.folders].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      items.push({ label: `📁 ${f.name}`, disabled: fromFolder === f.id, onClick: () => movePages(ids, f.id) });
    }
    items.push({ label: "Unfiled", disabled: fromFolder === null, onClick: () => movePages(ids, null) });
    items.push({ label: "+ New folder…", onClick: () => startNewFolder(ids) });
    return items;
  }

  function makeDropTarget(node, folderId) {
    node.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      node.classList.add("is-drop");
    });
    node.addEventListener("dragleave", (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove("is-drop");
    });
    node.addEventListener("drop", (e) => {
      node.classList.remove("is-drop");
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      let ids = [];
      try { ids = JSON.parse(raw); } catch {}
      ids = ids.filter((id) => {
        const p = index.pages.find((x) => x.id === id);
        return p && (p.folderId || null) !== folderId;
      });
      if (ids.length) movePages(ids, folderId);
    });
  }

  function startNewFolder(thenMove) {
    editing = { mode: "new", thenMove: thenMove || null };
    render();
    $("lib-tree").scrollTop = 0;
  }

  function updateBulk() {
    // Forget selections for pages that no longer exist.
    const live = new Set(index.pages.map((p) => p.id));
    for (const id of [...selected]) if (!live.has(id)) selected.delete(id);

    const n = selected.size;
    const total = index.pages.length;
    const all = $("lib-select-all");
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    all.disabled = total === 0;
    $("lib-sel-count").textContent = n ? `${n} selected` : "Select all";
    for (const id of ["lib-bulk-move", "lib-bulk-download", "lib-bulk-delete"]) $(id).disabled = n === 0;
  }

  function reveal(id) {
    const p = index.pages.find((x) => x.id === id);
    if (!p) return;
    const k = p.folderId || "unfiled";
    if (collapsed.delete(k)) { saveCollapsed(); render(); }
    const li = document.querySelector(`.lib-page[data-id="${CSS.escape(id)}"]`);
    if (li) {
      li.scrollIntoView({ block: "nearest" });
      li.classList.add("is-flash");
      setTimeout(() => li.classList.remove("is-flash"), 1200);
    }
  }

  // ---------------------------------------------------------------------------
  // Pop-up menu

  function openMenu(anchor, items) {
    const menu = $("lib-menu");
    menu.textContent = "";
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { menu.append(el("div", { class: "lib-menu-sep", role: "separator" })); continue; }
      if (it.heading) { menu.append(el("div", { class: "lib-menu-heading" }, it.heading)); continue; }
      menu.append(el("button", {
        type: "button",
        role: "menuitem",
        class: "lib-menu-item" + (it.danger ? " danger" : ""),
        disabled: !!it.disabled,
        onclick: () => { closeMenu(); it.onClick(); },
      }, it.label));
    }
    // Drop separators left dangling at the edges.
    while (menu.firstChild && menu.firstChild.classList.contains("lib-menu-sep")) menu.firstChild.remove();
    while (menu.lastChild && menu.lastChild.classList.contains("lib-menu-sep")) menu.lastChild.remove();

    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    menu.dataset.anchor = "1";
    const first = menu.querySelector("button:not(:disabled)");
    if (first) first.focus();
  }

  function closeMenu() {
    $("lib-menu").hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Wiring

  async function init() {
    index = await loadIndex();

    $("lib-new-folder").addEventListener("click", () => startNewFolder(null));

    $("lib-select-all").addEventListener("change", (e) => {
      if (e.target.checked) index.pages.forEach((p) => selected.add(p.id));
      else selected.clear();
      render();
    });
    $("lib-bulk-delete").addEventListener("click", () => confirmDelete([...selected]));
    $("lib-bulk-download").addEventListener("click", () => download([...selected]));
    $("lib-bulk-move").addEventListener("click", (e) => {
      const ids = [...selected];
      const folders = new Set(index.pages.filter((p) => selected.has(p.id)).map((p) => p.folderId || null));
      openMenu(e.currentTarget, moveItems(ids, folders.size === 1 ? [...folders][0] : undefined));
    });

    document.addEventListener("mousedown", (e) => {
      const menu = $("lib-menu");
      if (!menu.hidden && !menu.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
    window.addEventListener("resize", closeMenu);
    $("lib-tree").addEventListener("scroll", closeMenu);

    // Keep every open Quiet Page tab in step.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[INDEX_KEY]) return;
      const v = changes[INDEX_KEY].newValue || {};
      index = { folders: v.folders || [], pages: v.pages || [] };
      if (current.libId && !index.pages.some((p) => p.id === current.libId)) currentPageDeleted();
      render();
    });

    render();
    if (current.libId) reveal(current.libId);
  }

  return { init, collect, getPage, savePageState, reveal, status, movePages, deletePages, download, createFolder };
})();
