const $ = (selector) => document.querySelector(selector);
let site;

const encodePath = (file) => `./${file.split("/").map(encodeURIComponent).join("/")}`;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function field(label, value, onInput, options = {}) {
  const wrapper = document.createElement("label");
  if (options.span) wrapper.classList.add("span-2");
  wrapper.textContent = label;
  const input = document.createElement(options.textarea ? "textarea" : "input");
  input.value = value || "";
  input.placeholder = options.placeholder || "";
  input.addEventListener("input", () => onInput(input.value));
  wrapper.append(input);
  return wrapper;
}

function selectField(label, value, choices, onInput) {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const select = document.createElement("select");
  choices.forEach((choice) => {
    const option = document.createElement("option");
    option.value = choice;
    option.textContent = choice;
    option.selected = choice === value;
    select.append(option);
  });
  select.addEventListener("change", () => onInput(select.value));
  wrapper.append(select);
  return wrapper;
}

function renderStats(stats = {}) {
  const today = new Date().toISOString().slice(0, 10);
  $("#statsGrid").innerHTML = `
    <article class="stat-card"><span>Total Views</span><strong>${stats.totalViews || 0}</strong></article>
    <article class="stat-card"><span>Today</span><strong>${stats.todayViews?.[today] || 0}</strong></article>
    <article class="stat-card"><span>Recent Logs</span><strong>${stats.lastViews?.length || 0}</strong></article>
  `;
}

function renderGeneral() {
  const config = site.config;
  const form = $("#generalForm");
  form.innerHTML = "";
  [
    ["Groom", config.groom, (v) => { config.groom = v; }],
    ["Bride", config.bride, (v) => { config.bride = v; }],
    ["Display Names", config.displayNames, (v) => { config.displayNames = v; }],
    ["Wedding Date", config.weddingDate, (v) => { config.weddingDate = v; }],
    ["Display Date", config.displayDate, (v) => { config.displayDate = v; }],
    ["Ceremony Time", config.ceremonyTime, (v) => { config.ceremonyTime = v; }],
    ["Ceremony Display Time", config.ceremonyDisplayTime, (v) => { config.ceremonyDisplayTime = v; }],
    ["Reception Time", config.receptionTime, (v) => { config.receptionTime = v; }],
    ["Music Path", config.musicPath, (v) => { config.musicPath = v; }, true],
    ["Hero Photo", config.heroPhoto, (v) => { config.heroPhoto = v; }, true],
    ["Church Map Link", config.mapLinks.church, (v) => { config.mapLinks.church = v; }, true],
    ["Reception Map Link", config.mapLinks.reception, (v) => { config.mapLinks.reception = v; }, true],
    ["Groom Portrait", config.heroPortraits.groom.file, (v) => { config.heroPortraits.groom.file = v; }, true],
    ["Bride Portrait", config.heroPortraits.bride.file, (v) => { config.heroPortraits.bride.file = v; }, true]
  ].forEach(([label, value, onInput, span]) => form.append(field(label, value, onInput, { span })));
}

function renderTexts() {
  const en = site.i18n.en;
  const events = en.events;
  const form = $("#textsForm");
  form.innerHTML = "";
  [
    ["Hero Eyebrow", en.heroEyebrow, (v) => { en.heroEyebrow = v; }],
    ["Hero Names HTML", en.heroNames, (v) => { en.heroNames = v; }],
    ["Featured Verse", en.featuredVerse, (v) => { en.featuredVerse = v; }, true],
    ["Featured Reference", en.featuredReference, (v) => { en.featuredReference = v; }],
    ["Story Eyebrow", en.storyEyebrow, (v) => { en.storyEyebrow = v; }],
    ["Story Title", en.storyTitle, (v) => { en.storyTitle = v; }],
    ["Events Eyebrow", en.eventsEyebrow, (v) => { en.eventsEyebrow = v; }],
    ["Events Title", en.eventsTitle, (v) => { en.eventsTitle = v; }],
    ["Gallery Eyebrow", en.galleryEyebrow, (v) => { en.galleryEyebrow = v; }],
    ["Gallery Title", en.galleryTitle, (v) => { en.galleryTitle = v; }],
    ["Closing Eyebrow", en.closingEyebrow, (v) => { en.closingEyebrow = v; }],
    ["Closing Title", en.closingTitle, (v) => { en.closingTitle = v; }],
    ["Closing Copy", en.closingCopy, (v) => { en.closingCopy = v; }, true],
    ["Ceremony Title", events.ceremonyTitle, (v) => { events.ceremonyTitle = v; }],
    ["Ceremony Location", events.churchLocation, (v) => { events.churchLocation = v; }, true],
    ["Reception Title", events.receptionTitle, (v) => { events.receptionTitle = v; }],
    ["Reception Location", events.receptionLocation, (v) => { events.receptionLocation = v; }, true],
    ["Map Button", events.map, (v) => { events.map = v; }],
    ["Calendar Button", events.google, (v) => { events.google = v; }]
  ].forEach(([label, value, onInput, span]) => form.append(field(label, value, onInput, { span, textarea: span })));
}

async function uploadFile(file) {
  const data = new FormData();
  data.append("file", file);
  const result = await api("/api/admin/upload", { method: "POST", body: data });
  return result.file;
}

function mediaUpload(item, preview) {
  const wrapper = document.createElement("label");
  wrapper.className = "upload-line span-2";
  wrapper.textContent = "Upload New File";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,audio/*,video/*";
  input.addEventListener("change", async () => {
    if (!input.files[0]) return;
    const file = await uploadFile(input.files[0]);
    item.file = file;
    if (preview) preview.src = encodePath(file);
    renderAll();
    setMessage(`Uploaded ${file}`);
  });
  wrapper.append(input);
  return wrapper;
}

function moveItem(list, index, direction) {
  const next = index + direction;
  if (next < 0 || next >= list.length) return;
  [list[index], list[next]] = [list[next], list[index]];
}

function editorCard(item, index, list, type) {
  const card = document.createElement("article");
  card.className = "editor-card";
  const img = document.createElement("img");
  img.className = "preview";
  img.src = encodePath(item.photo || item.file || "");
  img.alt = "";
  card.append(img);

  const fields = document.createElement("div");
  fields.className = "editor-fields";
  if (type === "story") {
    fields.append(
      field("Title", item.title, (v) => { item.title = v; }),
      field("Date", item.date, (v) => { item.date = v; }),
      field("Photo", item.photo, (v) => { item.photo = v; img.src = encodePath(v); }, { span: true }),
      field("Text", item.text, (v) => { item.text = v; }, { span: true, textarea: true }),
      field("Object Position", item.position || "50% 35%", (v) => { item.position = v; }),
      mediaUpload({ get file() { return item.photo; }, set file(v) { item.photo = v; } }, img)
    );
  } else {
    fields.append(
      field("File", item.file, (v) => { item.file = v; img.src = encodePath(v); }, { span: true }),
      selectField("Orientation", item.orientation || "portrait", ["portrait", "landscape"], (v) => { item.orientation = v; }),
      field("Position", item.position || "50% 34%", (v) => { item.position = v; }),
      field("Section", item.section || "gallery", (v) => { item.section = v; }),
      field("Alt", item.alt || "", (v) => { item.alt = v; }, { span: true }),
      mediaUpload(item, img)
    );
  }

  const actions = document.createElement("div");
  actions.className = "row-actions span-2";
  [["Up", -1], ["Down", 1]].forEach(([label, direction]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = label;
    button.addEventListener("click", () => {
      moveItem(list, index, direction);
      renderAll();
    });
    actions.append(button);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    if (!confirm("Delete this item?")) return;
    list.splice(index, 1);
    renderAll();
  });
  actions.append(remove);
  fields.append(actions);
  card.append(fields);
  return card;
}

function renderStoryEditor() {
  const editor = $("#storyEditor");
  editor.innerHTML = "";
  site.config.story.forEach((item, index, list) => editor.append(editorCard(item, index, list, "story")));
}

function renderGalleryEditor() {
  const editor = $("#galleryEditor");
  editor.innerHTML = "";
  site.config.photos.forEach((item, index, list) => editor.append(editorCard(item, index, list, "gallery")));
}

function syncStoryText() {
  site.i18n.en.story = site.config.story.map(({ title, date, text }) => ({ title, date, text }));
}

function renderAll() {
  renderGeneral();
  renderTexts();
  renderStoryEditor();
  renderGalleryEditor();
}

function setMessage(text) {
  $("#saveState").textContent = text;
}

async function loadDashboard() {
  site = await api("/api/admin/site");
  renderAll();
  renderStats(await api("/api/admin/stats"));
  $("#loginView").classList.add("hidden");
  $("#dashboardView").classList.remove("hidden");
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#passwordInput").value })
    });
    if (!result.ok) throw new Error("Login failed");
    await loadDashboard();
  } catch (error) {
    $("#loginMessage").textContent = error.message;
  }
});

$("#saveAll").addEventListener("click", async () => {
  syncStoryText();
  await api("/api/admin/site", { method: "PUT", body: JSON.stringify(site) });
  setMessage(`Saved at ${new Date().toLocaleTimeString()}`);
});

$("#logoutBtn").addEventListener("click", () => {
  api("/api/admin/logout", { method: "POST" }).finally(() => location.reload());
});

$("#addStory").addEventListener("click", () => {
  site.config.story.push({ title: "New Story", date: "Date", text: "Story text", photo: "صورة الخطوبة.jpeg", position: "50% 35%" });
  renderAll();
});

$("#addGallery").addEventListener("click", () => {
  site.config.photos.push({ file: "صورة الخطوبة.jpeg", orientation: "portrait", position: "50% 34%", section: "gallery", alt: "Wedding memory" });
  renderAll();
});

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $(`#tab-${button.dataset.tab}`).classList.add("active");
  });
});

loadDashboard().catch(() => {});
