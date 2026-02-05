/* ================================
   Song Picker - app.js (Module)
   Manual local import/export
   Manual Firebase pull/push
   ================================ */

/* ---------- Constants ---------- */

const GENRES = [
  "Random",
  "Pop",
  "Country",
  "Rock/Alt",
  "R&B/HipHop",
  "Other",
  "Tv/Movie/Kids",
  "Metal/Hard Rock"
];
const DISPLAY_GENRES = GENRES.filter(g => g !== "Random");

const STORAGE_KEY = "songPicker.songs";
const ARCHIVE_KEY = "songPicker.archive";
const RECENT_KEY = "songPicker.recent";
const LAST_IMPORT_META_KEY = "songPicker.lastImportMeta";
const PROVIDER_KEY = "songPicker.provider";
const CSV_DELIM = "@";
const RECENT_MAX = 4;

/* ---------- Firebase (Manual) ----------
   This uses Firestore as a "single master doc" store (manual pull/push).
   IMPORTANT: Firestore docs have a ~1 MiB limit. If you may exceed it, we should chunk.
*/
const FIREBASE_ENABLED = true;

const firebaseConfig = {
 apiKey: "AIzaSyBnIwX-F4YoxXW4gatIwvJD-NF23XcdwaI",
  authDomain: "sturdy-device-485320-s2.firebaseapp.com",
  projectId: "sturdy-device-485320-s2",
  storageBucket: "sturdy-device-485320-s2.firebasestorage.app",
  messagingSenderId: "467108248130",
  appId: "1:467108248130:web:a40f601be2544a2c088bdb",
  measurementId: "G-3NZ9TM8Y8C"
};

// Firestore document path to store the master CSV: "collection/docId"
const FIREBASE_DOC_PATH = "songs/state";

/* Firebase SDK imports (ESM) */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ---------- Firebase init ---------- */

let fbApp = null;
let fbDb = null;

function initFirebase() {
  if (!FIREBASE_ENABLED) return false;
  try {
    fbApp = initializeApp(firebaseConfig);
    fbDb = getFirestore(fbApp);
    return true;
  } catch (e) {
    console.warn("Firebase init failed:", e);
    return false;
  }
}

function getFirebaseDocRef() {
  if (!fbDb) return null;
  const parts = FIREBASE_DOC_PATH.split("/");
  if (parts.length !== 2) throw new Error("FIREBASE_DOC_PATH must be 'collection/docId'");
  return doc(fbDb, parts[0], parts[1]);
}

/* ---------- State ---------- */

let songs = loadSongs();
let archive = loadArchive();
let recent = loadRecent();

let isBulkOperationInProgress = false;
let importMode = "merge"; 
let provider = loadProvider(); // "apple" | "ytm"

function loadProvider() {
  const v = localStorage.getItem(PROVIDER_KEY);
  return (v === "ytm" || v === "apple") ? v : "apple";
}
function saveProvider(v) {
  provider = v;
  localStorage.setItem(PROVIDER_KEY, v);
}

/* ---------- Filter state ---------- */

const filters = {
  current: { query: "", genre: "" },
  archive: { query: "", genre: "" }
};

/* ---------- Elements ---------- */

const screens = {
  main: document.getElementById("main-screen"),
  add: document.getElementById("add-screen"),
  archive: document.getElementById("archive-screen"),
};

const resultEl = document.getElementById("result");
const recentListEl = document.getElementById("recentList");

// Main bar buttons
const providerSelect = document.getElementById("providerSelect");
if (providerSelect) {
  providerSelect.value = provider;
  providerSelect.addEventListener("change", () => {
    saveProvider(providerSelect.value);
    notify(`Playback: ${provider === "ytm" ? "YouTube Music" : "Apple Music"}`);
  });
}
const addSongNavBtn = document.getElementById("add-song-nav");
const importCsvBtn = document.getElementById("import-csv-btn");
const importReplaceBtn = document.getElementById("import-replace-btn");
const exportCsvBtn = document.getElementById("export-csv-btn");
const firebasePullBtn = document.getElementById("firebase-pull-btn");
const firebasePushBtn = document.getElementById("firebase-push-btn");
const importCsvFileInput = document.getElementById("import-csv-file");

// Genre grid + copy
const genreButtons = Array.from(document.querySelectorAll(".genre-btn"));
const copySongBtn = document.getElementById("copySongBtn");

// Add screen
const songForm = document.getElementById("song-form");
const cancelAddBtn = document.getElementById("cancel-add");
const songListEl = document.getElementById("song-list");
const goArchiveBtn = document.getElementById("go-archive");
const backCurrentBtn = document.getElementById("back-current");
const navArchiveBtn = document.getElementById("nav-archive");
const currentCountsEl = document.getElementById("current-counts");
const archiveAllCurrentBtn = document.getElementById("archive-all-current");

// Archive screen
const backArchiveBtn = document.getElementById("back-archive");
const navCurrentBtn = document.getElementById("nav-current");
const archiveListEl = document.getElementById("archive-list");
const archiveCountsEl = document.getElementById("archive-counts");
const deleteAllArchiveTopBtn = document.getElementById("delete-all-archive");
const unarchiveAllTopBtn = document.getElementById("unarchive-all");
const deleteAllArchiveBottomBtn = document.getElementById("delete-all-archive-view");
const unarchiveAllBottomBtn = document.getElementById("unarchive-all-bottom");

/* Import report target under main screen buttons */
const importReportTarget = (() => {
  const leftActions = document.querySelector("#main-screen .bottom-actions .left-actions");
  if (!leftActions) return null;
  let el = leftActions.querySelector("#mainImportReport");
  if (el) return el;
  el = document.createElement("div");
  el.id = "mainImportReport";
  el.style.marginTop = "8px";
  leftActions.appendChild(el);
  return el;
})();
/* ---------- Core helpers that were missing ---------- */

function validateSong({ artist, title, year, genre }) {
  const errs = [];
  if (!artist) errs.push("Artist is required.");
  if (!title) errs.push("Song title is required.");
  if (year != null) {
    if (!Number.isFinite(year) || year < 1900 || year > 2100) errs.push("Year must be between 1900 and 2100.");
  }
  if (!DISPLAY_GENRES.includes(genre)) errs.push("Genre must be selected.");
  return errs;
}

function genreClass(genre) {
  const key = String(genre || "").toLowerCase();
  const simple = key.replace(/\s+/g, "");
  if (simple.includes("pop")) return "genre-pop";
  if (simple.includes("country")) return "genre-country";
  if (simple.includes("rock/alt") || key === "rock" || simple.includes("alt")) return "genre-rock";
  if (simple.includes("r&b") || simple.includes("hiphop") || simple.includes("hip-hop")) return "genre-rnb";
  if (simple.includes("tv") || simple.includes("movie") || simple.includes("kids")) return "genre-tv";
  if (simple.includes("metal")) return "genre-metal";
  return "genre-other";
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Replace-import from raw text (CSV or @-delimited), overwriting songs+archive.
 * Returns { report, routed, duplicatesInCsv } for consistent UI + meta.
 */
function importReplaceFromText(text) {
  const smart = parseCsvSmart(text, []); // ignore existing list for replace
  const { validSongs, failedLines, duplicatesInCsv, __routed } = smart;

  let currentRows = [];
  let archiveRows = [];

  if (__routed === "status") {
    const { currentRows: cr, archiveRows: ar } = parseCsvWithStatus(text);
    currentRows = cr.map(s => normalizeSongStrings(s));
    archiveRows = ar.map(s => normalizeSongStrings(s));
  } else {
    currentRows = validSongs.map(s => normalizeSongStrings(s));
    archiveRows = [];
  }

  const { current, archived } = ensureUniqueIdsAcrossLists(currentRows, archiveRows);
  songs = current;
  archive = archived;

  saveSongs(songs);
  saveArchive(archive);

  refreshSongList();
  refreshArchiveList();

  return {
    routed: __routed,
    duplicatesInCsv,
    report: {
      successCount: songs.length + archive.length,
      duplicatesTotal: duplicatesInCsv,
      failedCount: failedLines.length,
      failedLines
    }
  };
}

/* ---------- Inject filter controls ---------- */

injectFilterControls({
  containerSelector: "#add-screen .list-preview",
  scope: "current",
  onChange: () => refreshSongList()
});
injectFilterControls({
  containerSelector: "#archive-screen .list-preview",
  scope: "archive",
  onChange: () => refreshArchiveList()
});

/* ---------- Navigation ---------- */

addSongNavBtn?.addEventListener("click", () => showScreen("add"));
cancelAddBtn?.addEventListener("click", () => showScreen("main"));
backCurrentBtn?.addEventListener("click", () => showScreen("main"));

navArchiveBtn?.addEventListener("click", () => {
  refreshArchiveList();
  showScreen("archive");
});
goArchiveBtn?.addEventListener("click", () => {
  refreshArchiveList();
  showScreen("archive");
});
backArchiveBtn?.addEventListener("click", () => showScreen("main"));
navCurrentBtn?.addEventListener("click", () => {
  refreshSongList();
  showScreen("add");
});

/* ---------- Genre buttons ---------- */

genreButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const genre = btn.dataset.genre;
    if (genre === "Random") {
      const genresWithSongs = DISPLAY_GENRES.filter(g => songs.some(s => s.genre === g));
      if (genresWithSongs.length === 0) {
        renderResult(null, "No songs yet. Add or import some!");
        return;
      }
      pickAndArchiveForGenre(randomItem(genresWithSongs));
    } else {
      pickAndArchiveForGenre(genre);
    }
  });
});

/* ---------- Pick and archive ---------- */

async function pickAndArchiveForGenre(genre) {
  const pool = songs.filter(s => s.genre === genre);
  if (pool.length === 0) {
    renderResult(null, `No songs in ${genre} yet. Add or import some!`);
    return;
  }

  const song = randomItem(pool);
  renderResultWithDelay(song, 500);

 try { await PlaybackManager.playSong(song); } catch (err) { console.warn("Playback error", err); notify(err?.message || "Playback failed."); }
   
  pushRecent(song);
  renderRecent();

  const idx = songs.findIndex(s => s.id === song.id);
  if (idx !== -1) {
    archive.push(songs[idx]);
    saveArchive(archive);
    songs.splice(idx, 1);
    saveSongs(songs);
    refreshSongList();
    refreshArchiveList();
  }
}

/* ---------- Copy current song text ---------- */

copySongBtn?.addEventListener("click", () => {
  const nowPlayingEl = resultEl?.querySelector("#nowPlayingText");
  const txt = nowPlayingEl?.textContent || "";
  if (!txt || txt === "No song selected yet") {
    notify("Nothing to copy yet.");
    return;
  }

  let title = "";
  let artist = "";
  const emDashParts = txt.split(" — ");
  if (emDashParts.length >= 2) {
    title = emDashParts[0].trim();
    artist = emDashParts[1].replace(/\s*\(\d{4}\)\s*$/, "").trim();
  } else {
    const hyphenParts = txt.split(" - ");
    if (hyphenParts.length >= 2) {
      title = hyphenParts[0].trim();
      artist = hyphenParts[1].replace(/\s*\(\d{4}\)\s*$/, "").trim();
    } else {
      title = txt.trim();
    }
  }

  const toCopy = artist ? `${title} — ${artist}` : title;
  navigator.clipboard.writeText(toCopy)
    .then(() => notify("Copied Title — Artist to clipboard."))
    .catch(() => notify("Copy failed."));
});

/* ---------- Local Import buttons ---------- */

importCsvBtn?.addEventListener("click", () => {
  if (!importCsvFileInput) return alert("File input not found.");
  importMode = "merge";
  importCsvFileInput.value = "";
  importCsvFileInput.click();
});

importReplaceBtn?.addEventListener("click", () => {
  if (!importCsvFileInput) return alert("File input not found.");
  const ok = confirm("Import & Replace will overwrite Current + Archive on this device. Continue?");
  if (!ok) return;

  importMode = "replace";
  importCsvFileInput.value = "";
  importCsvFileInput.click();
});

/* Local Import handler */
importCsvFileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await decodeFileText(file);

    if (importMode === "replace") {
      const outcome = importReplaceFromText(text);

      renderImportReport(outcome.report);
      saveLastImportMeta({
        mode: "replace",
        filename: file.name || "",
        size: file.size || 0,
        importedAt: new Date().toISOString(),
        routed: outcome.routed,
        currentCount: songs.length,
        archiveCount: archive.length,
        failedCount: outcome.report.failedCount,
        duplicatesInCsv: outcome.duplicatesInCsv
      });
      renderLastImportMeta();

      notify(`Replaced with ${songs.length} current and ${archive.length} archived.`);
      renderResult(null, "Imported & replaced data.");
      showScreen("main");
      return;
    }

    // Merge mode
    const report = parseCsvSmart(text, songs);
    const { validSongs, failedLines, duplicatesInCsv, duplicatesVsCurrent, __routed } = report;

    const normalized = validSongs.map(s => normalizeSongStrings(s));
    const addedCount = mergeImportedSongs(normalized);
    const duplicatesTotal = duplicatesInCsv + duplicatesVsCurrent;

    renderImportReport({
      successCount: addedCount,
      duplicatesTotal,
      failedCount: failedLines.length,
      failedLines
    });

    saveLastImportMeta({
      mode: "merge",
      filename: file.name || "",
      size: file.size || 0,
      importedAt: new Date().toISOString(),
      routed: __routed,
      addedCount,
      duplicatesTotal,
      failedCount: failedLines.length
    });
    renderLastImportMeta();

    notify(`Import: ${addedCount} added, ${duplicatesTotal} duplicates, ${failedLines.length} failed.`);
    refreshSongList();
    renderResult(null, `Imported ${addedCount} song(s).`);
    showScreen("main");
  } catch (err) {
    console.error(err);
    renderImportReport({
      successCount: 0,
      duplicatesTotal: 0,
      failedCount: 1,
      failedLines: [`Import failed: ${err?.message || String(err)}`]
    });
    notify("Import failed.");
  } finally {
    importMode = "merge";
    importCsvFileInput.value = "";
  }
});

/* ---------- Local Export ---------- */

exportCsvBtn?.addEventListener("click", async () => {
  const csv = allSongsToCsv(songs, archive, { withBom: true });
  const filename = makeTimestampedFilename();

  const canSave = typeof window.showSaveFilePicker === "function" && isSecureContext;
  if (canSave) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "CSV Files", accept: { "text/csv": [".csv"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(csv);
      await writable.close();
      notify(`Exported to chosen location as ${filename}`);
      return;
    } catch (err) {
      if (err?.name === "AbortError") return notify("Export canceled.");
      console.warn("Save dialog failed; falling back to download.", err);
    }
  }

  try {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, filename);
    notify(`Exported as ${filename}`);
  } catch (err) {
    console.error("Fallback download failed:", err);
    alert("Export failed. Try a supported browser or run over HTTPS/localhost.");
  }
});

/* ---------- Firebase Manual Pull / Push ---------- */

const firebaseOk = initFirebase();

firebasePullBtn?.addEventListener("click", async () => {
  if (!firebaseOk) return alert("Firebase is not configured. Paste firebaseConfig values in app.js.");
  const ok = confirm("Firebase Pull will overwrite Current + Archive on this device. Continue?");
  if (!ok) return;

  try {
    const ref = getFirebaseDocRef();
    if (!ref) throw new Error("Firebase ref not available.");

    const snap = await getDoc(ref);
    if (!snap.exists()) {
      notify("Firebase dataset not found. Use Firebase Push first.");
      return;
    }

    const data = snap.data() || {};
    const csv = String(data.csv || "");
    if (!csv.trim()) {
      notify("Firebase has no CSV data.");
      return;
    }

    const outcome = importReplaceFromText(csv);

    renderImportReport(outcome.report);
    saveLastImportMeta({
      mode: "firebase-pull",
      filename: "Firebase:" + FIREBASE_DOC_PATH,
      size: csv.length,
      importedAt: new Date().toISOString(),
      routed: outcome.routed,
      currentCount: songs.length,
      archiveCount: archive.length,
      failedCount: outcome.report.failedCount,
      duplicatesInCsv: outcome.duplicatesInCsv
    });
    renderLastImportMeta();

    notify(`Firebase Pull: ${songs.length} current, ${archive.length} archived.`);
    showScreen("main");
  } catch (err) {
    console.error(err);
    notify("Firebase Pull failed.");
    alert("Firebase Pull failed: " + (err?.message || String(err)));
  }
});

firebasePushBtn?.addEventListener("click", async () => {
  if (!firebaseOk) return alert("Firebase is not configured. Paste firebaseConfig values in app.js.");
  const ok = confirm("Firebase Push will overwrite the dataset in Firebase. Continue?");
  if (!ok) return;

  try {
    const ref = getFirebaseDocRef();
    if (!ref) throw new Error("Firebase ref not available.");

    const csv = allSongsToCsv(songs, archive, { withBom: false });

    await setDoc(ref, {
      csv,
      updatedAt: serverTimestamp(),
      version: Date.now()
    }, { merge: true });

    notify("Firebase Push complete.");
  } catch (err) {
    console.error(err);
    notify("Firebase Push failed.");
    alert("Firebase Push failed: " + (err?.message || String(err)));
  }
});

/* ---------- Bulk ops ---------- */

archiveAllCurrentBtn?.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (songs.length === 0) return notify("No current songs to archive.");
  const ok = confirm("Archive ALL current songs?");
  if (!ok) return;

  isBulkOperationInProgress = true;
  try {
    archive.push(...songs);
    saveArchive(archive);
    songs = [];
    saveSongs(songs);
    refreshSongList();
    refreshArchiveList();
    notify("All current songs archived.");
  } finally {
    isBulkOperationInProgress = false;
  }
});

/* ---------- Current list actions ---------- */

songListEl?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action][data-id]");
  if (!btn || !songListEl.contains(btn)) return;
  e.stopPropagation();

  const id = String(btn.dataset.id || "");
  const action = btn.dataset.action;

  if (action === "delete") {
    const beforeLen = songs.length;
    songs = songs.filter(s => String(s.id) !== id);
    if (songs.length !== beforeLen) {
      saveSongs(songs);
      refreshSongList();
      notify("Song deleted from Current.");
    }
  } else if (action === "archive") {
    const idx = songs.findIndex(s => String(s.id) === id);
    if (idx !== -1) {
      archive.push(songs[idx]);
      saveArchive(archive);
      songs.splice(idx, 1);
      saveSongs(songs);
      refreshSongList();
      refreshArchiveList();
      notify("Song archived.");
    }
  }
});

/* ---------- Archive list actions ---------- */

archiveListEl?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action][data-id]");
  if (!btn || !archiveListEl.contains(btn)) return;
  e.stopPropagation();

  const id = String(btn.dataset.id || "");
  const action = btn.dataset.action;

  if (action === "delete") {
    const beforeLen = archive.length;
    archive = archive.filter(s => String(s.id) !== id);
    if (archive.length !== beforeLen) {
      saveArchive(archive);
      refreshArchiveList();
      notify("Song deleted from Archive.");
    }
  } else if (action === "restore") {
    const idx = archive.findIndex(s => String(s.id) === id);
    if (idx !== -1) {
      const restored = archive[idx];
      songs.push(restored);
      saveSongs(songs);
      archive.splice(idx, 1);
      saveArchive(archive);
      refreshArchiveList();
      refreshSongList();
      notify("Song returned to Current.");
    }
  }
});

/* ---------- Recent list actions: unarchive by artist+title ---------- */

recentListEl?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action][data-id]");
  if (!btn || !recentListEl.contains(btn)) return;
  const action = btn.dataset.action;
  if (action !== "recent-unarchive") return;

  const idx = Number(btn.dataset.id ?? -1);
  if (!Number.isFinite(idx) || idx < 0 || idx >= recent.length) return;

  const entry = recent[idx];
  const targetArtist = String(entry.artist || "").trim().toLowerCase();
  const targetTitle = String(entry.title || "").trim().toLowerCase();

  const toRestoreIndexes = [];
  for (let i = 0; i < archive.length; i++) {
    const s = archive[i];
    if (
      String(s.artist || "").trim().toLowerCase() === targetArtist &&
      String(s.title || "").trim().toLowerCase() === targetTitle
    ) {
      toRestoreIndexes.push(i);
    }
  }

  if (toRestoreIndexes.length === 0) return notify("No matching archived song found to unarchive.");

  for (let i = toRestoreIndexes.length - 1; i >= 0; i--) {
    const aIdx = toRestoreIndexes[i];
    songs.push(archive[aIdx]);
    archive.splice(aIdx, 1);
  }
  saveSongs(songs);
  saveArchive(archive);

  refreshSongList();
  refreshArchiveList();
  notify(`Returned ${toRestoreIndexes.length} song(s) to Current.`);
});

/* ---------- Unarchive All ---------- */

unarchiveAllTopBtn?.addEventListener("click", () => unarchiveAll());
unarchiveAllBottomBtn?.addEventListener("click", () => unarchiveAll());

async function unarchiveAll() {
  if (archive.length === 0) return notify("No archived songs to unarchive.");
  const ok = confirm("Move ALL archived songs back to Current?");
  if (!ok) return;

  songs.push(...archive);
  saveSongs(songs);
  archive = [];
  saveArchive(archive);
  refreshSongList();
  refreshArchiveList();
  notify("All archived songs moved back to Current.");
}

/* ---------- Delete All Archive ---------- */

deleteAllArchiveTopBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  deleteAllArchive();
});
deleteAllArchiveBottomBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  deleteAllArchive();
});

async function deleteAllArchive() {
  if (archive.length === 0) return notify("No archived songs to delete.");
  const ok = confirm("Delete ALL archived songs? This cannot be undone.");
  if (!ok) return;

  archive = [];
  saveArchive(archive);
  refreshArchiveList();
  notify("All archived songs deleted.");
}

/* ---------- Add Song form ---------- */

songForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(songForm);

  const artistInput = normalizeText(String(formData.get("artist") || "")).trim();
  const titleInput = normalizeText(String(formData.get("title") || "")).trim();
  const year = normalizeYearOptional(formData.get("year"));
  const genre = String(formData.get("genre") || "");

  const errors = validateSong({ artist: artistInput, title: titleInput, year, genre });
  if (errors.length) {
    alert("Please fix:\n\n" + errors.join("\n"));
    return;
  }

  const targetArtist = artistInput.toLowerCase();
  const targetTitle = titleInput.toLowerCase();
  const dup = [...songs, ...archive].some(s =>
    String(s.artist || "").trim().toLowerCase() === targetArtist &&
    String(s.title || "").trim().toLowerCase() === targetTitle
  );
  if (dup) {
    alert(`That song already exists:\n\n${titleInput} — ${artistInput}`);
    return;
  }

  const newSong = { id: makeId(), artist: artistInput, title: titleInput, year, genre };
  songs.push(newSong);
  saveSongs(songs);
  songForm.reset();
  refreshSongList();
  showScreen("main");

  const yearText = year != null ? `(${year})` : "";
  renderResult(null, `Added: ${titleInput} by ${artistInput}${yearText} in ${genre}`);
});

/* ---------- Playback Integration (Apple Music + YouTube Music) ---------- */
const YT_API_KEY = "AIzaSyDE4RjoYFYADsg3YVkJg6AUniegOtM7f3c";
/**
 * Build YouTube queries based on genre.
 * - Tv/Movie/Kids: ONLY "Title Artist"
 * - Others: include variants, ending with plain "Title Artist"
 */
 Build YouTube queries based on genre.
 - Tv/Movie/Kids: ONLY "Title Artist"
 - Others: include a few helpful variants, ending with plain "Title Artist"
 
function buildYouTubeQueries({ title, artist, genre }) {
  const base = `${title} ${artist}`.trim();
  const isTvMovieKids = /tv|movie|kids/i.test(String(genre || ""));
  if (isTvMovieKids) return [base];
  return [`${base} lyrics`, `${base} audio`, base];
}

const PlaybackManager = (() => {
  const TAB_TARGET = "player-tab"; // reuse same external tab

  async function playSong({ title, artist, genre }) {
    if (!title || !artist) return;

    if (provider === "ytm") {
      await playYouTubeMusic({ title, artist, genre });
      return;
    }

    playAppleMusic({ title, artist });
  }

  function playAppleMusic({ title, artist }) {
    const query = encodeURIComponent(`${title} ${artist}`);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    const url = isIOS
      ? `music://music.apple.com/search?term=${query}`
      : `https://music.apple.com/us/search?term=${query}`;

    openInTab(url);
    notify(`Opening "${title}" in Apple Music...`);
  }

  async function playYouTubeMusic({ title, artist, genre }) {
    // Open something immediately to reduce popup blocking on iOS.
    // If the API succeeds, we navigate the same tab to the final watch URL.
    const fallbackSearchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(`${title} ${artist}`)}`;

    // Best-effort immediate open (counts as user gesture)
    const win = openInTab(fallbackSearchUrl);

    notify(`Searching YouTube Music for "${title}"...`);

    // Try multiple query variants
    const queries = buildYouTubeQueries({ title, artist, genre });

    let videoId = null;
    for (let i = 0; i < queries.length; i++) {
      // Bias toward "audio" if present in the query list
      videoId = await findYouTubeVideoId(queries[i]);
      if (videoId) break;
    }

    if (videoId) {
      const url = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      navigateTab(win, url);
      notify(`Opening "${title}" in YouTube Music...`);
    } else {
      // Keep the fallback search tab (already open)
      notify("Could not find a direct match. Showing YouTube Music search results.");
    }
  }

  function openInTab(url) {
    const win = window.open(url, TAB_TARGET);
    if (!win) {
      alert("Please allow popups for this site to open the music player.");
      return null;
    }
    try { win.focus(); } catch (_) {}
    return win;
  }

  function navigateTab(win, url) {
    // If we have a handle, navigate it. Otherwise try opening again.
    try {
      if (win && !win.closed) {
        win.location.href = url;
        win.focus();
        return;
      }
    } catch (_) {}
    openInTab(url);
  }

  async function findYouTubeVideoId(query) {
    if (!YT_API_KEY) {
      console.warn("No YT_API_KEY provided.");
      return null;
    }

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "video");
    url.searchParams.set("videoCategoryId", "10"); // Music
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("key", YT_API_KEY);

    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) {
        // Helpful debug info in console; keep UI quiet
        const t = await resp.text().catch(() => "");
        console.warn("YouTube API non-OK:", resp.status, t);
        return null;
      }
      const data = await resp.json();
      const id = data?.items?.[0]?.id?.videoId || null;
      return id;
    } catch (err) {
      console.error("YouTube API Error:", err);
      return null;
    }
  }

  return { playSong };
})();

/* ---------- Filtering helpers ---------- */

function injectFilterControls({ containerSelector, scope, onChange }) {
  const container = document.querySelector(containerSelector);
  if (!container) return null;

  const wrap = document.createElement("div");
  wrap.className = "list-filters";
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.alignItems = "center";
  wrap.style.margin = "8px 0";

  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search...";
  search.value = filters[scope].query;
  search.style.flex = "1";
  search.style.padding = "8px";
  search.style.borderRadius = "8px";
  search.style.border = "1px solid #334155";
  search.style.background = "#0b1221";
  search.style.color = "inherit";

  const select = document.createElement("select");
  select.style.padding = "8px";
  select.style.borderRadius = "8px";
  select.style.border = "1px solid #334155";
  select.style.background = "#0b1221";
  select.style.color = "inherit";

  const anyOpt = document.createElement("option");
  anyOpt.value = "";
  anyOpt.textContent = "All genres";
  select.appendChild(anyOpt);

  DISPLAY_GENRES.forEach(g => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    select.appendChild(opt);
  });
  select.value = filters[scope].genre;

  search.addEventListener("input", () => {
    filters[scope].query = search.value.trim();
    onChange?.();
  });
  select.addEventListener("change", () => {
    filters[scope].genre = select.value;
    onChange?.();
  });

  wrap.appendChild(search);
  wrap.appendChild(select);

  const listHeader = container.querySelector(".list-header");
  if (listHeader) container.insertBefore(wrap, listHeader.nextSibling);
  else container.insertBefore(wrap, container.firstChild);

  return { search, select, wrap };
}

function applyFilters(list, scope) {
  const { query, genre } = filters[scope];
  const q = query.toLowerCase();
  return list.filter(s => {
    const matchesGenre = !genre || s.genre === genre;
    const matchesQuery =
      !q ||
      String(s.title || "").toLowerCase().includes(q) ||
      String(s.artist || "").toLowerCase().includes(q);
    return matchesGenre && matchesQuery;
  });
}

/* ---------- Rendering ---------- */

function showScreen(which) {
  screens.main.classList.toggle("active", which === "main");
  screens.add.classList.toggle("active", which === "add");
  screens.archive.classList.toggle("active", which === "archive");
  if (which === "add") refreshSongList();
  if (which === "archive") refreshArchiveList();
}

function renderResultWithDelay(song, delayMs = 500) {
  if (!resultEl) return;
  if (!song) return renderResult(null, "No selection");

  const { title, artist, genre, year } = song;
  const yearText = year != null ? `(${year})` : "";

  const genreHtml = `<span id="nowPlayingGenrePill" class="badge genre-pill ${genreClass(genre)}">${escapeHtml(genre)}</span>`;
  resultEl.innerHTML = `
    <div class="meta">
      <div id="nowPlayingText" class="title" style="visibility:hidden;"></div>
      <div class="subtitle">${genreHtml}</div>
    </div>
  `;

  const show = () => {
    const nowPlayingEl = resultEl.querySelector("#nowPlayingText");
    if (nowPlayingEl) {
      nowPlayingEl.textContent = `${title} — ${artist}${yearText}`;
      nowPlayingEl.style.visibility = "visible";
    }
  };

  if (resultEl._revealTimer) clearTimeout(resultEl._revealTimer);
  resultEl._revealTimer = setTimeout(show, delayMs);
}

function renderResult(song, message) {
  if (!resultEl) return;
  if (!song) {
    resultEl.innerHTML =
      '<div class="meta">' +
        '<div class="title">' + escapeHtml(message || "No selection") + '</div>' +
        '<div class="subtitle">Use the genre grid to pick a song.</div>' +
      '</div>';
    return;
  }
   function openYouTubeMusicByVideoId(videoId) {
  // YouTube Music can play a YouTube video ID
  // Most reliable: open the music.youtube.com watch URL
  const url = `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  window.open(url, "_blank");
}

  var yearText = (song.year != null) ? "(" + song.year + ")" : "";
  var text = escapeHtml(song.title) + " — " + escapeHtml(song.artist) + escapeHtml(yearText);

  resultEl.innerHTML =
    '<div class="meta">' +
      '<div id="nowPlayingText" class="title">' + text + '</div>' +
      '<div class="subtitle">' +
        '<span id="nowPlayingGenrePill" class="badge genre-pill ' + genreClass(song.genre) + '">' + escapeHtml(song.genre) + '</span>' +
      '</div>' +
    '</div>';
}

function refreshSongList() {
  if (currentCountsEl) currentCountsEl.innerHTML = renderCounts(songs);
  if (!songListEl) return;

  var filtered = applyFilters(songs, "current");
  if (filtered.length === 0) {
    songListEl.innerHTML = "<li>No songs match your filter.</li>";
    return;
  }

  songListEl.innerHTML = filtered
    .map(function(s) {
      var yearText = (s.year != null) ? "(" + s.year + ")" : "";
      return '<li>' +
        '<div class="item-row">' +
          '<div class="item-meta">' +
            '<span class="title">' + escapeHtml(s.title) + ' — ' + escapeHtml(s.artist) + escapeHtml(yearText) + '</span>' +
            '<span class="badge genre-pill ' + genreClass(s.genre) + '">' + escapeHtml(s.genre) + '</span>' +
          '</div>' +
          '<div class="actions">' +
            '<button type="button" class="icon-btn" data-action="archive" data-id="' + escapeHtml(String(s.id)) + '">Archive</button>' +
            '<button type="button" class="icon-btn danger" data-action="delete" data-id="' + escapeHtml(String(s.id)) + '">Delete</button>' +
          '</div>' +
        '</div>' +
      '</li>';
    })
    .join("");
}

function refreshArchiveList() {
  if (archiveCountsEl) archiveCountsEl.innerHTML = renderCounts(archive);
  if (!archiveListEl) return;

  var filtered = applyFilters(archive, "archive");
  if (filtered.length === 0) {
    archiveListEl.innerHTML = "<li>No archived songs match your filter.</li>";
    return;
  }

  archiveListEl.innerHTML = filtered
    .map(function(s) {
      var yearText = (s.year != null) ? "(" + s.year + ")" : "";
      return '<li>' +
        '<div class="item-row">' +
          '<div class="item-meta">' +
            '<span class="title">' + escapeHtml(s.title) + ' — ' + escapeHtml(s.artist) + escapeHtml(yearText) + '</span>' +
            '<span class="badge genre-pill ' + genreClass(s.genre) + '">' + escapeHtml(s.genre) + '</span>' +
          '</div>' +
          '<div class="actions">' +
            '<button type="button" class="icon-btn" data-action="restore" data-id="' + escapeHtml(String(s.id)) + '">Return</button>' +
            '<button type="button" class="icon-btn danger" data-action="delete" data-id="' + escapeHtml(String(s.id)) + '">Delete</button>' +
          '</div>' +
        '</div>' +
      '</li>';
    })
    .join("");
}

function renderCounts(list) {
  const counts = Object.fromEntries(DISPLAY_GENRES.map(function(g) { return [g, 0]; }));
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (counts[s.genre] !== undefined) counts[s.genre]++;
  }
  const total = list.length;
  const badges = DISPLAY_GENRES
    .map(function(g) {
      return '<span class="count-badge">' + g + ": " + counts[g] + "</span>";
    })
    .join(" ");
  return '<span class="count-badge">Total: ' + total + "</span> " + badges;
}

/* ---------- Storage helpers ---------- */

function saveSongs(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
function loadSongs() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

function saveArchive(list) { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list)); }
function loadArchive() {
  try { const raw = localStorage.getItem(ARCHIVE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

function saveRecent(list) { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }
function loadRecent() {
  try { const raw = localStorage.getItem(RECENT_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

/* ---------- Recent ---------- */

function pushRecent(song) {
  const entry = { artist: song.artist, title: song.title, genre: song.genre, year: song.year ?? null };
  recent.unshift(entry);
  recent = recent.slice(0, RECENT_MAX);
  saveRecent(recent);
}

function renderRecent() {
  if (!recentListEl) return;
  if (!recent || recent.length === 0) {
    recentListEl.innerHTML = "";
    return;
  }
  recentListEl.innerHTML = recent
    .map(function (r, idx) {
      var yearText = (r.year != null) ? "(" + r.year + ")" : "";
      var safeIdx = String(idx);
      return '<div class="item-row">' +
        '<div class="item-meta">' +
          '<span class="title">' + escapeHtml(r.title) + " — " + escapeHtml(r.artist) + escapeHtml(yearText) + "</span>" +
          '<span class="badge genre-pill ' + genreClass(r.genre) + '">' + escapeHtml(r.genre) + "</span>" +
        "</div>" +
        '<div class="actions">' +
          '<button type="button" class="icon-btn" data-action="recent-unarchive" data-id="' + safeIdx + '">Unarchive</button>' +
        "</div>" +
      "</div>";
    })
    .join("");
}

/* ---------- HTML escape + notify + download ---------- */

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function notify(text) {
  console.log(text);
  try {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.style.position = "fixed";
      toast.style.bottom = "80px";
      toast.style.left = "50%";
      toast.style.transform = "translateX(-50%)";
      toast.style.background = "#111827";
      toast.style.color = "#e5e7eb";
      toast.style.border = "1px solid #334155";
      toast.style.borderRadius = "8px";
      toast.style.padding = "8px 12px";
      toast.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
      toast.style.zIndex = "9999";
      toast.style.fontSize = "0.9rem";
      document.body.appendChild(toast);
    }
    toast.textContent = String(text || "");
    toast.style.opacity = "1";
    clearTimeout(notify._t);
    notify._t = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
  } catch (_) {}
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- Normalizers + IDs ---------- */

function normalizeText(s) {
  if (!s) return s;
  return String(s)
    .replace(/\uFFFD/g, "")
    .replace(/\u2018|\u2019|\u02BC/g, "’")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2013/g, "–")
    .replace(/\u2014/g, "—")
    .replace(/\u2026/g, "…")
    .replace(/\u00A0/g, " ");
}

function normalizeSongStrings(s) {
  return {
    ...s,
    artist: normalizeText(s.artist),
    title: normalizeText(s.title),
    genre: s.genre
  };
}

function normalizeYearOptional(y) {
  const str = String(y ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (str === "") return null;

  const m = str.match(/\b(19\d{2}|20\d{2})\b/);
  if (!m) return null;

  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}

function normalizeGenre(genreRaw) {
  const g = String(genreRaw || "").trim();
  if (DISPLAY_GENRES.includes(g)) return g;

  const k = g.toLowerCase().replace(/\s+/g, "");
  if (k.includes("pop")) return "Pop";
  if (k.includes("country")) return "Country";
  if (k.includes("rock") || k.includes("alt")) return "Rock/Alt";
  if (k.includes("r&b") || k.includes("hiphop") || k.includes("hip-hop")) return "R&B/HipHop";
  if (k.includes("tv") || k.includes("movie") || k.includes("kids")) return "Tv/Movie/Kids";
  if (k.includes("metal")) return "Metal/Hard Rock";
  return "Other";
}

function makeId() {
  if (window.crypto?.getRandomValues) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2, 10);
}

function ensureUniqueIdsAcrossLists(currentRows, archiveRows) {
  const seen = new Set();
  function fix(list) {
    return list.map(s => {
      let id = s?.id ? String(s.id) : "";
      if (!id || seen.has(id)) id = makeId();
      seen.add(id);
      return { ...s, id };
    });
  }
  return { current: fix(currentRows), archived: fix(archiveRows) };
}

/* ---------- File decode ---------- */

async function decodeFileText(file) {
  const buf = await file.arrayBuffer();

  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!looksCorrupt(text)) return text;

  try {
    const cp1252Decoder = new TextDecoder("windows-1252", { fatal: false });
    const cpText = cp1252Decoder.decode(buf);
    if (countReplacement(cpText) < countReplacement(text)) return cpText;
    return text;
  } catch {
    return text;
  }
}

function looksCorrupt(s) { return countReplacement(s) >= 2; }
function countReplacement(s) {
  const m = s.match(/\uFFFD/g);
  return m ? m.length : 0;
}

/* ---------- CSV export + filename ---------- */

function allSongsToCsv(currentList, archiveList, opts = {}) {
  const header = ["Status", "Artist", "Title", "Year", "Genre"].join(CSV_DELIM);
  const toRows = (status, list) => list.map(s =>
    [ status, csvEscape(s.artist), csvEscape(s.title), s.year ?? "", csvEscape(s.genre) ].join(CSV_DELIM)
  );
  const body = [header, ...toRows("Current", currentList), ...toRows("Archive", archiveList)].join("\n");
  return opts.withBom ? "\uFEFF" + body : body;
}

function csvEscape(val) {
  var str = String(val == null ? "" : val);
  var needsQuotes =
    (str.indexOf('"') !== -1) ||
    (str.indexOf(CSV_DELIM) !== -1) ||
    /\r|\n/.test(str);

  var escaped = str.replace(/"/g, '""');
  return needsQuotes ? '"' + escaped + '"' : escaped;
}

function makeTimestampedFilename() {
  var d = new Date();
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  var yearShort = String(d.getFullYear()).slice(-2);
  var hours = String(d.getHours()).padStart(2, "0");
  var minutes = String(d.getMinutes()).padStart(2, "0");
  return "(songs " + month + "-" + day + "-" + yearShort + ") " + hours + "-" + minutes + ".csv";
}

function detectDelimiter(text, defaultDelim) {
  const firstLine = (text.split(/\r?\n/)[0] || "");
  const commaCount = (firstLine.match(/,/g) || []).length;
  const atCount = (firstLine.match(/@/g) || []).length;
  if (commaCount > atCount) return ",";
  if (atCount > 0) return "@";
  return defaultDelim;
}

function parseCsvSmart(text, existingSongs = []) {
  const delim = detectDelimiter(text, CSV_DELIM);
  const lines = text.split(/\r?\n/);

  // Remove ASCII control characters except tab (0x09)
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  }

  if (lines.length === 0) {
    return {
      validSongs: [],
      failedLines: [],
      duplicatesInCsv: 0,
      duplicatesVsCurrent: 0,
      __routed: "empty"
    };
  }

  // Peek header
  const headerLine = lines[0] || "";
  const headerCols = parseDelimitedLine(headerLine, delim).map(s => s.toLowerCase());
  const hasHeader = headerCols.some(c => ["status", "artist", "title", "year", "genre"].includes(c));

  // Find first non-empty data line
  let firstDataIdx = hasHeader ? 1 : 0;
  while (firstDataIdx < lines.length && (!lines[firstDataIdx] || !lines[firstDataIdx].trim())) {
    firstDataIdx++;
  }
  const firstDataLine = lines[firstDataIdx] || "";
  const firstCols = firstDataLine ? parseDelimitedLine(firstDataLine, delim) : [];

  const looksStatusFirst =
    firstCols.length >= 1 &&
    ["current", "archive"].includes(String(firstCols[0] || "").trim().toLowerCase());

  // Route
  if ((hasHeader && headerCols.includes("status")) || looksStatusFirst) {
    const { currentRows, archiveRows, failedLines, duplicatesInCsv } = parseCsvWithStatus(lines.join("\n"));
    const validSongs = [...currentRows, ...archiveRows];
    return {
      validSongs,
      failedLines,
      duplicatesInCsv,
      duplicatesVsCurrent: 0,
      __routed: "status"
    };
  }

  // Default
  const report = parseCsvWithReport(lines.join("\n"), existingSongs);
  return { ...report, __routed: "report" };
}

function parseDelimitedLine(line, delim) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCsvWithReport(text, existingSongs = []) {
  const delim = detectDelimiter(text, CSV_DELIM);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  }

  if (lines.length === 0) {
    return { validSongs: [], failedLines: [], duplicatesInCsv: 0, duplicatesVsCurrent: 0 };
  }

  const headerLine = lines[0] || "";
  const headerCols = parseDelimitedLine(headerLine, delim).map(s => s.toLowerCase());
  const hasHeader = headerCols.some(c => ["artist", "title", "genre", "status", "year"].includes(c));
  const startIdx = hasHeader ? 1 : 0;

  // Column indexes (default order if no header)
  let idxArtist = 0, idxTitle = 1, idxYear = 2, idxGenre = 3;
  if (hasHeader) {
    idxArtist = headerCols.indexOf("artist");
    idxTitle  = headerCols.indexOf("title");
    idxYear   = headerCols.indexOf("year");
    idxGenre  = headerCols.indexOf("genre");
  }

  const validSongs = [];
  const failedLines = [];
  let duplicatesInCsv = 0;
  let duplicatesVsCurrent = 0;

  const seenKeys = new Set();
  const keyOf = (s) => [
    String(s.artist || "").trim().toLowerCase(),
    String(s.title || "").trim().toLowerCase(),
    s.year ?? "",
    String(s.genre || "").trim().toLowerCase()
  ].join("|");
  const existingSet = new Set(existingSongs.map(keyOf));

  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || rawLine.trim().length === 0) continue;

    let cols;
    try {
      cols = parseDelimitedLine(rawLine, delim);
    } catch {
      failedLines.push(rawLine);
      continue;
    }

    const artistRaw = cols[idxArtist] ?? "";
    const titleRaw  = cols[idxTitle] ?? "";
    const yearRaw   = cols[idxYear] ?? "";
    const genreRaw  = cols[idxGenre] ?? "";

    const artist = String(artistRaw || "").trim();
    const title  = String(titleRaw || "").trim();

    const yearClean = String(yearRaw)
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
    const year = normalizeYearOptional(yearClean);

    const genre = normalizeGenre(genreRaw);

    const errors = validateSong({ artist, title, year, genre });
    if (errors.length > 0) {
      failedLines.push(rawLine);
      continue;
    }

    const k = [artist.toLowerCase(), title.toLowerCase(), year ?? "", genre.toLowerCase()].join("|");

    if (seenKeys.has(k)) {
      duplicatesInCsv++;
      continue;
    }
    seenKeys.add(k);

    if (existingSet.has(k)) {
      duplicatesVsCurrent++;
      continue;
    }

    validSongs.push({ id: makeId(), artist, title, year, genre });
  }

  return { validSongs, failedLines, duplicatesInCsv, duplicatesVsCurrent };
}

function parseCsvWithStatus(text) {
  const delim = detectDelimiter(text, CSV_DELIM);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  }

  if (lines.length === 0) {
    return { currentRows: [], archiveRows: [], failedLines: [], duplicatesInCsv: 0 };
  }

  const headerLine = lines[0] || "";
  const headerCols = parseDelimitedLine(headerLine, delim).map(s => s.toLowerCase());
  const hasHeader =
    headerCols.includes("status") &&
    headerCols.includes("artist") &&
    headerCols.includes("title") &&
    headerCols.includes("genre");

  const startIdx = hasHeader ? 1 : 0;

  // Indexes (default order if no header)
  let idxStatus = 0, idxArtist = 1, idxTitle = 2, idxYear = 3, idxGenre = 4;
  if (hasHeader) {
    idxStatus = headerCols.indexOf("status");
    idxArtist = headerCols.indexOf("artist");
    idxTitle  = headerCols.indexOf("title");
    idxYear   = headerCols.indexOf("year");
    idxGenre  = headerCols.indexOf("genre");
  }

  const currentRows = [];
  const archiveRows = [];
  const failedLines = [];
  let duplicatesInCsv = 0;

  const seenKeys = new Set();

  for (let i = startIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || rawLine.trim().length === 0) continue;

    let cols;
    try {
      cols = parseDelimitedLine(rawLine, delim);
    } catch {
      failedLines.push(rawLine);
      continue;
    }

    const statusRaw = cols[idxStatus] ?? "";
    const artistRaw = cols[idxArtist] ?? "";
    const titleRaw  = cols[idxTitle] ?? "";
    const yearRaw   = idxYear >= 0 ? (cols[idxYear] ?? "") : "";
    const genreRaw  = cols[idxGenre] ?? "";

    const status = String(statusRaw || "").trim();
    const artist = String(artistRaw || "").trim();
    const title  = String(titleRaw  || "").trim();

    const yearClean = String(yearRaw)
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
    const year = normalizeYearOptional(yearClean);

    const genre = normalizeGenre(genreRaw);

    const validStatus = (status === "Current" || status === "Archive");
    const errors = validateSong({ artist, title, year, genre });
    if (!validStatus || errors.length > 0) {
      failedLines.push(rawLine);
      continue;
    }

    const k = [status.toLowerCase(), artist.toLowerCase(), title.toLowerCase(), (year ?? ""), genre.toLowerCase()].join("|");
    if (seenKeys.has(k)) {
      duplicatesInCsv++;
      continue;
    }
    seenKeys.add(k);

    const entry = { id: makeId(), artist, title, year, genre };
    if (status === "Current") currentRows.push(entry);
    else archiveRows.push(entry);
  }

  return { currentRows, archiveRows, failedLines, duplicatesInCsv };
}

/* -------- Merge with existing list -------- */

function mergeImportedSongs(imported) {
  const keyOf = function(s) {
    return [
      s.artist.trim().toLowerCase(),
      s.title.trim().toLowerCase(),
      (s.year ?? ""),
      s.genre.trim().toLowerCase()
    ].join("|");
  };

  const existing = new Set(songs.map(keyOf));
  let added = 0;
  for (let i = 0; i < imported.length; i++) {
    const s = imported[i];
    const k = keyOf(s);
    if (!existing.has(k)) {
      songs.push(s);
      existing.add(k);
      added++;
    }
  }
  saveSongs(songs);
  return added;
}

/* -------- Import report rendering -------- */

function renderImportReport(params) {
  if (!importReportTarget) return;

  var successCount = params.successCount;
  var duplicatesTotal = params.duplicatesTotal;
  var failedCount = params.failedCount;
  var failedLines = params.failedLines || [];

  var failedBlock = "";
  if (failedCount > 0) {
    var failedContent = failedLines.map(function(l) { return escapeHtml(l); }).join("\n");
    failedBlock =
      '<div style="margin-top:8px;">' +
        '<div><strong>Failed lines (' + failedCount + '):</strong></div>' +
        '<div style="font-family: monospace; font-size: 0.9rem; white-space: pre-wrap; background:#0b1221; border:1px solid #334155; padding:8px; border-radius:8px; max-height:160px; overflow:auto;">' +
          failedContent +
        '</div>' +
      '</div>';
  }

  importReportTarget.innerHTML =
    '<div class="count-badge">Imported: ' + successCount + '</div>' +
    '<div class="count-badge">Duplicates: ' + duplicatesTotal + '</div>' +
    '<div class="count-badge">Failed: ' + failedCount + '</div>' +
    failedBlock;
}

/* -------- Last import meta -------- */

function saveLastImportMeta(meta) {
  try { localStorage.setItem(LAST_IMPORT_META_KEY, JSON.stringify(meta)); } catch {}
}

function loadLastImportMeta() {
  try {
    const raw = localStorage.getItem(LAST_IMPORT_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function renderLastImportMeta() {
  if (!importReportTarget) return;

  const meta = loadLastImportMeta();
  if (!meta) return;

  const when = meta.importedAt ? new Date(meta.importedAt) : null;
  const whenText = when ? when.toLocaleString() : "";

  const lines = [
    `Last import: ${meta.mode || ""}`.trim(),
    meta.filename ? `File: ${meta.filename} (${formatBytes(meta.size)})` : "",
    whenText ? `When: ${whenText}` : "",
    (meta.mode === "replace" || meta.mode === "firebase-pull")
      ? `Now: ${meta.currentCount ?? 0} current, ${meta.archiveCount ?? 0} archive`
      : (meta.addedCount != null ? `Added: ${meta.addedCount}` : ""),
    (meta.duplicatesTotal != null
      ? `Duplicates: ${meta.duplicatesTotal}`
      : (meta.duplicatesInCsv != null ? `Duplicates in file: ${meta.duplicatesInCsv}` : "")),
    (meta.failedCount != null ? `Failed: ${meta.failedCount}` : "")
  ].filter(Boolean);

  const metaDivId = "lastImportMeta";
  let el = document.getElementById(metaDivId);
  if (!el) {
    el = document.createElement("div");
    el.id = metaDivId;
    el.style.marginTop = "8px";
    importReportTarget.appendChild(el);
  }

  el.innerHTML =
    '<div class="count-badge" style="display:block;">' +
      lines.map(escapeHtml).join("<br>") +
    "</div>";
}

/* ---------- Startup ---------- */

refreshSongList();
refreshArchiveList();
renderRecent();

renderLastImportMeta();





