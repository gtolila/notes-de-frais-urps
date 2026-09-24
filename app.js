(function () {
  "use strict";

  // ================= Domain constants =================
  var DEFAULT_PROFILE = {
    nom: "",
    adresse1: "",
    adresse2: "",
    recipients: [
      { label: "URPS PACA", email: "secretariat@urps-paca-chd.fr" },
      { label: "FSDL PACA", email: "tresorierfsdlpaca@gmail.com" }
    ],
    orgHeader: "URPS Chirurgiens-Dentistes PACA",
    kmRate: 0.697,
    vehicleType: "Auto",
    peageNiceMarseille: 42.4,
    signatureDataUrl: null
  };
  var TRAJET_RATES = { none: 0, lt1h: 65, h1_2: 130, h2_6: 260 };
  var TRAJET_LABELS = { none: "Aucun", lt1h: "< 1h", h1_2: "1-2h", h2_6: "2-6h" };
  var FORFAIT_RATE = 276;
  var QUOTA_MAX = 560;
  var HOTEL_MAX = 250;
  var REPAS_MAX = 30;
  var MONTHS_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

  var state = {
    profile: Object.assign({}, DEFAULT_PROFILE, { recipients: DEFAULT_PROFILE.recipients.map(function (r) { return Object.assign({}, r); }) }),
    expenses: [],
    receipts: [],
    activeTab: "saisie",
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth() + 1,
    recapYear: new Date().getFullYear(),
    editingId: null,
    draftId: null,
    userId: null,
    selectedIds: {}
  };

  var sb = null;             // Supabase client
  var expensesChannel = null;
  var receiptsChannel = null;
  var receiptUrlCache = {};  // storage_path -> signed url (session-lived)

  function genId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ================= formatting / calculation (pure, backend-agnostic) =================
  var fmtEUR = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
  function euro(n) { return fmtEUR.format(Math.round((n + Number.EPSILON) * 100) / 100); }
  function euroPdf(n) { return euro(n).replace(/[  \s]/g, " "); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function monthKey(y, m) { return y + "-" + String(m).padStart(2, "0"); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function slugify(str) {
    return String(str || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sans-nom";
  }
  function displayDate(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    if (p.length !== 3) return iso;
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function computeLine(l) {
    var fraisKm = num(l.km) * num(l.kmRate);
    var frais = num(l.transport) + fraisKm + num(l.parking) + num(l.hotel) + num(l.repas) + num(l.divers);
    var trajetMontant = l.trajet === "none" ? 0 : num(l.trajetRate);
    var forfaitsMontant = num(l.demiJournees) * num(l.forfaitRate) + num(l.visio) * num(l.forfaitRate);
    var indemnites = trajetMontant + forfaitsMontant;
    var total = frais + indemnites;
    return {
      fraisKm: fraisKm, frais: frais, trajetMontant: trajetMontant, forfaitsMontant: forfaitsMontant,
      indemnites: indemnites, total: total,
      quotaDepasse: forfaitsMontant > QUOTA_MAX,
      hotelDepasse: num(l.hotel) > HOTEL_MAX,
      repasDepasse: num(l.repas) > REPAS_MAX
    };
  }
  function linesForMonth(y, m) {
    var key = monthKey(y, m);
    var org = state.profile.orgHeader || DEFAULT_PROFILE.orgHeader;
    return state.expenses.filter(function (l) {
      return (l.date || "").slice(0, 7) === key && (l.orgHeader || DEFAULT_PROFILE.orgHeader) === org;
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }
  function sumLines(lines) {
    var frais = 0, indem = 0;
    lines.forEach(function (l) { var c = computeLine(l); frais += c.frais; indem += c.indemnites; });
    return { frais: frais, indem: indem, total: frais + indem };
  }

  function alertFallback(msg) {
    var b = document.getElementById("storageBanner");
    document.getElementById("storageBannerText").textContent = "⚠ " + msg;
    b.classList.remove("hidden");
    b.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(function () { b.classList.add("hidden"); }, 5000);
  }

  // ================= tabs =================
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.activeTab = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.querySelectorAll(".tab-panel").forEach(function (p) {
        p.classList.toggle("active", p.id === "tab-" + state.activeTab);
      });
    });
  });

  // ================= month / year nav =================
  document.getElementById("prevMonth").addEventListener("click", function () { shiftMonth(-1); });
  document.getElementById("nextMonth").addEventListener("click", function () { shiftMonth(1); });
  function shiftMonth(delta) {
    var d = new Date(state.viewYear, state.viewMonth - 1 + delta, 1);
    state.viewYear = d.getFullYear();
    state.viewMonth = d.getMonth() + 1;
    state.selectedIds = {};
    if (pendingMonthPdf) resetMonthPdfButton();
    renderSaisie();
  }
  document.getElementById("prevYear").addEventListener("click", function () { state.recapYear--; renderRecap(); });
  document.getElementById("nextYear").addEventListener("click", function () { state.recapYear++; renderRecap(); });

  // ================= expense form =================
  function readForm() {
    return {
      date: document.getElementById("f-date").value,
      descriptif: document.getElementById("f-desc").value.trim(),
      transport: num(document.getElementById("f-transport").value),
      km: num(document.getElementById("f-km").value),
      kmRate: state.profile.kmRate,
      parking: num(document.getElementById("f-parking").value),
      hotel: num(document.getElementById("f-hotel").value),
      repas: num(document.getElementById("f-repas").value),
      divers: num(document.getElementById("f-divers").value),
      trajet: document.getElementById("f-trajet").value,
      trajetRate: TRAJET_RATES[document.getElementById("f-trajet").value],
      demiJournees: num(document.getElementById("f-demi").value),
      visio: num(document.getElementById("f-visio").value),
      forfaitRate: FORFAIT_RATE,
      orgHeader: state.profile.orgHeader || DEFAULT_PROFILE.orgHeader
    };
  }
  function updatePreview() {
    var l = readForm();
    var c = computeLine(l);
    document.getElementById("kmPreview").textContent = "Frais km : " + euro(c.fraisKm);
    document.getElementById("lineTotalPreview").textContent = euro(c.total);
  }
  ["f-transport","f-km","f-parking","f-divers","f-hotel","f-repas","f-trajet","f-demi","f-visio"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", updatePreview);
  });
  document.getElementById("tollShortcut").addEventListener("click", function () {
    document.getElementById("f-parking").value = state.profile.peageNiceMarseille || DEFAULT_PROFILE.peageNiceMarseille;
    updatePreview();
  });

  function resetForm() {
    document.getElementById("lineForm").reset();
    document.getElementById("f-date").value = monthKey(state.viewYear, state.viewMonth) + "-" + pad2(Math.min(new Date().getDate(), 28));
    document.getElementById("voiceText").value = "";
    setVoiceStatus("");
    state.editingId = null;
    state.draftId = genId();
    document.getElementById("formTitle").textContent = "Nouvelle dépense";
    document.getElementById("submitBtn").textContent = "Ajouter";
    document.getElementById("cancelEdit").classList.add("hidden");
    updatePreview();
    renderReceipts();
  }
  document.getElementById("cancelEdit").addEventListener("click", resetForm);

  document.getElementById("lineForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var l = readForm();
    if (!l.date) { document.getElementById("f-date").focus(); return; }
    upsertExpense(state.draftId, l).catch(function (err) {
      alertFallback("Échec de l'enregistrement : " + (err.message || "réessaie."));
    });
    resetForm();
  });

  function editLine(id) {
    var l = state.expenses.find(function (x) { return x.id === id; });
    if (!l) return;
    document.getElementById("f-date").value = l.date;
    document.getElementById("f-desc").value = l.descriptif || "";
    document.getElementById("f-transport").value = l.transport || 0;
    document.getElementById("f-km").value = l.km || 0;
    document.getElementById("f-parking").value = l.parking || 0;
    document.getElementById("f-hotel").value = l.hotel || 0;
    document.getElementById("f-repas").value = l.repas || 0;
    document.getElementById("f-divers").value = l.divers || 0;
    document.getElementById("f-trajet").value = l.trajet || "none";
    document.getElementById("f-demi").value = l.demiJournees || 0;
    document.getElementById("f-visio").value = l.visio || 0;
    state.editingId = id;
    state.draftId = id;
    document.getElementById("formTitle").textContent = "Modifier la dépense";
    document.getElementById("submitBtn").textContent = "Enregistrer";
    document.getElementById("cancelEdit").classList.remove("hidden");
    updatePreview();
    renderReceipts();
    document.getElementById("lineForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function deleteLine(id) {
    deleteExpense(id).catch(function (err) {
      alertFallback("Échec de la suppression : " + (err.message || "réessaie."));
    });
  }

  // ================= voice entry =================
  function setVoiceStatus(msg) { document.getElementById("voiceStatus").textContent = msg || ""; }

  function applyParsed(o) {
    o = o || {};
    if (o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) document.getElementById("f-date").value = o.date;
    document.getElementById("f-desc").value = o.descriptif || "";
    document.getElementById("f-transport").value = num(o.transport);
    document.getElementById("f-km").value = num(o.km);
    document.getElementById("f-parking").value = num(o.parking);
    document.getElementById("f-hotel").value = num(o.hotel);
    document.getElementById("f-repas").value = num(o.repas);
    document.getElementById("f-divers").value = num(o.divers);
    document.getElementById("f-trajet").value = ["none", "lt1h", "h1_2", "h2_6"].indexOf(o.trajet) >= 0 ? o.trajet : "none";
    document.getElementById("f-demi").value = num(o.demiJournees);
    document.getElementById("f-visio").value = num(o.visio);
    updatePreview();
  }

  var FR_NUMBER_WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
  function wordToNum(w) {
    if (!w) return 0;
    w = w.toLowerCase();
    if (FR_NUMBER_WORDS[w] !== undefined) return FR_NUMBER_WORDS[w];
    var n = parseInt(w, 10);
    return isFinite(n) ? n : 0;
  }

  function localParseVoiceText(text) {
    var lower = text.toLowerCase();
    var out = { date: null, descriptif: text.trim(), transport: 0, km: 0, parking: 0, hotel: 0, repas: 0, divers: 0, trajet: "none", demiJournees: 0, visio: 0 };

    var monthPattern = MONTHS_FR.join("|");
    var dateRe = new RegExp("(\\d{1,2})(?:er)?\\s+(" + monthPattern + ")(?:\\s+(\\d{4}))?", "i");
    var dm = lower.match(dateRe);
    if (dm) {
      var monthIdx = MONTHS_FR.indexOf(dm[2].toLowerCase());
      var year = dm[3] ? parseInt(dm[3], 10) : new Date().getFullYear();
      if (monthIdx >= 0) out.date = year + "-" + pad2(monthIdx + 1) + "-" + pad2(parseInt(dm[1], 10));
    }

    var moneyRe = /(\d+(?:[.,]\d+)?)\s*(?:€|euros?|eur)\b/gi;
    var m;
    while ((m = moneyRe.exec(lower))) {
      var amount = parseFloat(m[1].replace(",", "."));
      var context = lower.slice(Math.max(0, m.index - 30), m.index);
      if (/h[oô]tel|nuit[ée]e/.test(context)) out.hotel += amount;
      else if (/repas|d[ée]jeuner|d[iî]ner/.test(context)) out.repas += amount;
      else if (/p[ée]age|parking/.test(context)) out.parking += amount;
      else if (/train|taxi|avion|billet/.test(context)) out.transport += amount;
      else out.divers += amount;
    }

    var kmM = lower.match(/(\d+)\s*(?:km|kilom[eè]tres?)\b/i);
    if (kmM) out.km = parseInt(kmM[1], 10);

    var demiM = lower.match(/(\d+|un|une|deux|trois|quatre|cinq)\s*demi[\s-]journ[ée]es?/i);
    if (demiM) out.demiJournees = wordToNum(demiM[1]);
    else if (/demi[\s-]journ[ée]e/i.test(lower)) out.demiJournees = 1;

    var visioM = lower.match(/(\d+|un|une|deux|trois|quatre|cinq)\s*(?:r[ée]unions?\s+)?(?:en\s+)?visio(?:conf[ée]rences?)?/i);
    if (visioM) out.visio = wordToNum(visioM[1]);
    else if (/visio/i.test(lower)) out.visio = 1;

    if (/moins d(?:'|e )une? heure|moins d'1\s*h\b/i.test(lower)) out.trajet = "lt1h";
    else if (/1\s*(?:à|a|-)\s*2\s*h|une? à deux heures/i.test(lower)) out.trajet = "h1_2";
    else if (/2\s*(?:à|a|-)\s*6\s*h|deux à six heures/i.test(lower)) out.trajet = "h2_6";

    if (out.parking === 0 && /aller.?retour/i.test(lower) && /nice/i.test(lower) && /marseille/i.test(lower)) {
      out.parking = state.profile.peageNiceMarseille || DEFAULT_PROFILE.peageNiceMarseille;
    }
    return out;
  }

  function handleParse() {
    var text = document.getElementById("voiceText").value.trim();
    if (!text) { setVoiceStatus("Dictez ou saisissez une phrase décrivant la dépense."); return; }
    applyParsed(localParseVoiceText(text));
    setVoiceStatus("Champs remplis — vérifiez puis cliquez sur Ajouter.");
  }
  document.getElementById("parseBtn").addEventListener("click", handleParse);

  function initMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtn = document.getElementById("micBtn");
    if (!SR) { micBtn.classList.add("hidden"); return; }
    var recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = true;
    var listening = false;
    recognition.onresult = function (e) {
      var transcript = "";
      for (var i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      document.getElementById("voiceText").value = transcript;
    };
    recognition.onerror = function (e) {
      listening = false; micBtn.classList.remove("listening");
      setVoiceStatus(e.error === "not-allowed" ? "Micro refusé — autorise l'accès au micro dans les réglages du navigateur." : "Erreur d'écoute, réessayez.");
    };
    recognition.onend = function () {
      listening = false; micBtn.classList.remove("listening");
      if (document.getElementById("voiceText").value.trim()) handleParse();
    };
    micBtn.addEventListener("click", function () {
      if (listening) { recognition.stop(); return; }
      try {
        document.getElementById("voiceText").value = "";
        recognition.start();
        listening = true;
        micBtn.classList.add("listening");
        setVoiceStatus("Je vous écoute…");
      } catch (err) { setVoiceStatus("Impossible de démarrer l'écoute."); }
    });
  }

  // ================= receipts (Supabase Storage) =================
  function receiptsFor(expenseId) {
    return state.receipts.filter(function (r) { return r.expenseId === expenseId; });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Lecture du fichier impossible.")); };
      reader.onload = function () { resolve(reader.result); };
      reader.readAsDataURL(file);
    });
  }
  function resizeImageDataUrl(sourceDataUrl, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onerror = function () { reject(new Error("Image illisible.")); };
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", quality), width: w, height: h });
      };
      img.src = sourceDataUrl;
    });
  }
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    var mime = parts[0].match(/:(.*?);/)[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  var WORD_MIME_TYPES = ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  function isWordFile(file) {
    return WORD_MIME_TYPES.indexOf(file.type) >= 0 || /\.docx?$/i.test(file.name || "");
  }

  async function prepareReceiptUpload(file) {
    if (file.type === "application/pdf") {
      return { blob: file, mimeType: "application/pdf", width: 0, height: 0, ext: "pdf" };
    }
    if (isWordFile(file)) {
      var ext = /\.docx$/i.test(file.name || "") ? "docx" : "doc";
      return { blob: file, mimeType: file.type || "application/msword", width: 0, height: 0, ext: ext };
    }
    var rawDataUrl = await readFileAsDataUrl(file);
    var resized = await resizeImageDataUrl(rawDataUrl, 2000, 0.85);
    return { blob: dataUrlToBlob(resized.dataUrl), mimeType: "image/jpeg", width: resized.width, height: resized.height, ext: "jpg" };
  }

  function renderReceipts() {
    var list = document.getElementById("receiptList");
    var items = receiptsFor(state.draftId);
    list.innerHTML = "";
    items.forEach(function (r) {
      var chip = document.createElement("div");
      chip.className = "receipt-chip";
      chip.title = r.filename || "Justificatif";
      if (r.mimeType === "application/pdf") {
        chip.innerHTML = '<span class="receipt-pdf-icon">📄</span><button type="button" class="receipt-remove" data-remove-receipt="' + r.id + '">✕</button>';
      } else if (WORD_MIME_TYPES.indexOf(r.mimeType) >= 0) {
        chip.innerHTML = '<span class="receipt-pdf-icon">📝</span><button type="button" class="receipt-remove" data-remove-receipt="' + r.id + '">✕</button>';
      } else {
        var img = document.createElement("img");
        getReceiptUrl(r).then(function (url) { img.src = url; });
        chip.appendChild(img);
        var rm = document.createElement("button");
        rm.type = "button"; rm.className = "receipt-remove"; rm.setAttribute("data-remove-receipt", r.id); rm.textContent = "✕";
        chip.appendChild(rm);
      }
      chip.addEventListener("click", function (e) {
        if (e.target.closest("[data-remove-receipt]")) return;
        openLightbox(r);
      });
      list.appendChild(chip);
    });
    list.querySelectorAll("[data-remove-receipt]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        removeReceipt(btn.getAttribute("data-remove-receipt"));
      });
    });
  }

  async function getReceiptUrl(r) {
    if (receiptUrlCache[r.storagePath]) return receiptUrlCache[r.storagePath];
    var { data, error } = await sb.storage.from("receipts").createSignedUrl(r.storagePath, 3600);
    if (error) throw error;
    receiptUrlCache[r.storagePath] = data.signedUrl;
    return data.signedUrl;
  }

  async function downloadReceiptFile(r) {
    try {
      var url = await getReceiptUrl(r);
      var resp = await fetch(url);
      var blob = await resp.blob();
      var defaultExt = r.mimeType === "application/pdf" ? "pdf" : WORD_MIME_TYPES.indexOf(r.mimeType) >= 0 ? "docx" : "jpg";
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || ("justificatif." + defaultExt);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    } catch (err) {
      alertFallback("Échec du téléchargement : " + (err.message || "réessaie."));
    }
  }

  async function openLightbox(r) {
    var content = document.getElementById("lightboxContent");
    content.innerHTML = "Chargement…";
    document.getElementById("lightbox").classList.remove("hidden");
    try {
      var url = await getReceiptUrl(r);
      var preview;
      if (r.mimeType === "application/pdf") {
        preview = '<iframe src="' + url + '" title="' + escapeHtml(r.filename || "Justificatif") + '"></iframe>';
      } else if (WORD_MIME_TYPES.indexOf(r.mimeType) >= 0) {
        preview = '<div style="background:#fff; padding:24px; border-radius:8px; text-align:center; max-width:320px;"><p>' + escapeHtml(r.filename || "Document Word") + "</p></div>";
      } else {
        preview = '<img src="' + url + '" alt="' + escapeHtml(r.filename || "Justificatif") + '">';
      }
      content.innerHTML = preview + '<div style="text-align:center; margin-top:12px;"><button type="button" class="btn btn-primary" id="btnDownloadReceipt">Télécharger ce fichier</button></div>';
      document.getElementById("btnDownloadReceipt").addEventListener("click", function () { downloadReceiptFile(r); });
    } catch (err) {
      content.innerHTML = "Impossible de charger ce fichier.";
    }
  }
  function closeLightbox() {
    document.getElementById("lightbox").classList.add("hidden");
    document.getElementById("lightboxContent").innerHTML = "";
  }
  document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
  document.getElementById("lightbox").addEventListener("click", function (e) { if (e.target.id === "lightbox") closeLightbox(); });

  function handleAttachFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var status = document.getElementById("receiptStatus");
    files.reduce(function (chain, file) {
      return chain.then(async function () {
        status.textContent = "Envoi de " + file.name + "…";
        try {
          var prepped = await prepareReceiptUpload(file);
          var path = state.userId + "/" + state.draftId + "/" + genId() + "." + prepped.ext;
          var up = await sb.storage.from("receipts").upload(path, prepped.blob, { contentType: prepped.mimeType });
          if (up.error) throw up.error;
          var row = {
            user_id: state.userId, expense_id: state.draftId, filename: file.name,
            storage_path: path, mime_type: prepped.mimeType, width: prepped.width, height: prepped.height
          };
          var ins = await sb.from("receipts").insert(row);
          if (ins.error) throw ins.error;
          status.textContent = "";
        } catch (err) {
          status.textContent = "Échec de l'ajout de " + file.name + " : " + (err.message || "réessaie.");
        }
      });
    }, Promise.resolve());
  }

  document.getElementById("btnAttach").addEventListener("click", function () { document.getElementById("attachInput").click(); });
  document.getElementById("attachInput").addEventListener("change", function (e) {
    handleAttachFiles(e.target.files);
    e.target.value = "";
  });

  document.getElementById("btnScan").addEventListener("click", function () { document.getElementById("scanInput").click(); });
  document.getElementById("scanInput").addEventListener("change", function (e) {
    handleAttachFiles(e.target.files);
    e.target.value = "";
  });

  async function removeReceipt(id) {
    var r = state.receipts.find(function (x) { return x.id === id; });
    if (!r) return;
    try {
      await sb.storage.from("receipts").remove([r.storagePath]);
      await sb.from("receipts").delete().eq("id", id);
    } catch (err) {
      alertFallback("Échec de la suppression du justificatif : " + (err.message || "réessaie."));
    }
  }
  async function removeReceiptsFor(expenseId) {
    var items = receiptsFor(expenseId);
    if (!items.length) return;
    try {
      await sb.storage.from("receipts").remove(items.map(function (r) { return r.storagePath; }));
      await sb.from("receipts").delete().eq("expense_id", expenseId);
    } catch (err) { /* best effort */ }
  }

  // ================= rendering: Saisie =================
  function renderSaisie() {
    var label = MONTHS_FR[state.viewMonth - 1] + " " + state.viewYear;
    document.getElementById("monthLabel").textContent = label;
    document.getElementById("tableMonthTitle").textContent = "Dépenses — " + label;

    var lines = linesForMonth(state.viewYear, state.viewMonth);
    var visibleIds = {};
    lines.forEach(function (l) { visibleIds[l.id] = true; });
    Object.keys(state.selectedIds).forEach(function (id) { if (!visibleIds[id]) delete state.selectedIds[id]; });
    var sums = sumLines(lines);
    document.getElementById("statFrais").textContent = euro(sums.frais);
    document.getElementById("statIndem").textContent = euro(sums.indem);
    document.getElementById("statTotal").textContent = euro(sums.total);

    var warnings = [];
    lines.forEach(function (l) {
      var c = computeLine(l);
      if (c.quotaDepasse) warnings.push("Quota d'indemnités dépassé le " + displayDate(l.date) + " (> " + euro(QUOTA_MAX) + ")");
      if (c.hotelDepasse) warnings.push("Plafond hôtel dépassé le " + displayDate(l.date));
      if (c.repasDepasse) warnings.push("Plafond repas dépassé le " + displayDate(l.date));
    });
    var warnBanner = document.getElementById("monthWarnBanner");
    if (warnings.length) {
      warnBanner.innerHTML = "<span><strong>" + warnings.length + " alerte(s) : </strong>" + warnings.join(" · ") + "</span>";
      warnBanner.classList.remove("hidden");
    } else warnBanner.classList.add("hidden");

    var tbody = document.getElementById("linesTbody");
    var tfoot = document.getElementById("linesTfoot");
    var cards = document.getElementById("lineCards");
    tbody.innerHTML = ""; cards.innerHTML = "";

    if (!lines.length) {
      tbody.innerHTML = '<tr><td colspan="16" class="empty-state">Aucune dépense saisie pour ce mois.</td></tr>';
      tfoot.innerHTML = "";
    } else {
      lines.forEach(function (l) {
        var c = computeLine(l);
        var receiptCount = receiptsFor(l.id).length;
        var receiptBadge = receiptCount ? '<button type="button" class="row-receipt-badge" data-edit="' + l.id + '">📎 ' + receiptCount + '</button>' : "";
        var checked = state.selectedIds[l.id] ? " checked" : "";
        var tr = document.createElement("tr");
        tr.innerHTML =
          '<td class="select-col"><input type="checkbox" class="line-select" data-select="' + l.id + '"' + checked + "></td>" +
          "<td>" + displayDate(l.date) + "</td>" +
          '<td class="wrap">' + escapeHtml(l.descriptif || "—") + "</td>" +
          '<td class="num">' + euro(l.transport) + "</td>" +
          '<td class="num">' + (l.km || 0) + "</td>" +
          '<td class="num">' + euro(c.fraisKm) + "</td>" +
          '<td class="num">' + euro(l.parking) + "</td>" +
          '<td class="num">' + euro(l.hotel) + (c.hotelDepasse ? '<div class="pill pill-warn">Plafond</div>' : "") + "</td>" +
          '<td class="num">' + euro(l.repas) + (c.repasDepasse ? '<div class="pill pill-warn">Plafond</div>' : "") + "</td>" +
          '<td class="num">' + euro(l.divers) + "</td>" +
          "<td>" + TRAJET_LABELS[l.trajet || "none"] + "</td>" +
          '<td class="num">' + (l.demiJournees || 0) + "</td>" +
          '<td class="num">' + (l.visio || 0) + "</td>" +
          '<td class="num">' + euro(c.indemnites) + (c.quotaDepasse ? '<div class="pill pill-warn">Quota</div>' : "") + "</td>" +
          '<td class="num">' + euro(c.total) + "</td>" +
          '<td class="actions-col"><div class="row-actions">' + receiptBadge +
            '<button class="btn btn-small" data-edit="' + l.id + '">✎</button>' +
            '<button class="btn btn-small btn-danger" data-del="' + l.id + '">✕</button>' +
          "</div></td>";
        tbody.appendChild(tr);

        var card = document.createElement("div");
        card.className = "line-card";
        card.innerHTML =
          '<div class="line-card-top"><input type="checkbox" class="line-select" data-select="' + l.id + '"' + checked + '><span class="line-card-date">' + displayDate(l.date) + '</span><span class="line-card-total">' + euro(c.total) + "</span></div>" +
          '<div class="line-card-desc">' + escapeHtml(l.descriptif || "—") + "</div>" +
          '<div class="line-card-grid">' +
            '<div><span class="lbl">Frais </span>' + euro(c.frais) + "</div>" +
            '<div><span class="lbl">Indemnités </span>' + euro(c.indemnites) + "</div>" +
          "</div>" +
          '<div class="row-actions" style="margin-top:8px;">' + receiptBadge +
            '<button class="btn btn-small" data-edit="' + l.id + '">Modifier</button>' +
            '<button class="btn btn-small btn-danger" data-del="' + l.id + '">Supprimer</button>' +
          "</div>";
        cards.appendChild(card);
      });
      tfoot.innerHTML =
        '<tr><td colspan="5">Totaux</td>' +
        '<td class="num">' + euro(lines.reduce(function (s, l) { return s + computeLine(l).fraisKm; }, 0)) + "</td>" +
        '<td class="num">' + euro(lines.reduce(function (s, l) { return s + num(l.parking); }, 0)) + "</td>" +
        '<td class="num">' + euro(lines.reduce(function (s, l) { return s + num(l.hotel); }, 0)) + "</td>" +
        '<td class="num">' + euro(lines.reduce(function (s, l) { return s + num(l.repas); }, 0)) + "</td>" +
        '<td class="num">' + euro(lines.reduce(function (s, l) { return s + num(l.divers); }, 0)) + "</td>" +
        "<td></td>" +
        '<td class="num">' + lines.reduce(function (s, l) { return s + num(l.demiJournees); }, 0) + "</td>" +
        '<td class="num">' + lines.reduce(function (s, l) { return s + num(l.visio); }, 0) + "</td>" +
        '<td class="num">' + euro(sums.indem) + "</td>" +
        '<td class="num">' + euro(sums.total) + "</td>" +
        "<td></td></tr>";
    }
    tbody.querySelectorAll("[data-edit]").forEach(function (b) { b.addEventListener("click", function () { editLine(b.getAttribute("data-edit")); }); });
    tbody.querySelectorAll("[data-del]").forEach(function (b) { b.addEventListener("click", function () { deleteLine(b.getAttribute("data-del")); }); });
    cards.querySelectorAll("[data-edit]").forEach(function (b) { b.addEventListener("click", function () { editLine(b.getAttribute("data-edit")); }); });
    cards.querySelectorAll("[data-del]").forEach(function (b) { b.addEventListener("click", function () { deleteLine(b.getAttribute("data-del")); }); });
    tbody.querySelectorAll(".line-select").forEach(function (cb) {
      cb.addEventListener("change", function () { toggleLineSelect(cb.getAttribute("data-select"), cb.checked); });
    });
    cards.querySelectorAll(".line-select").forEach(function (cb) {
      cb.addEventListener("change", function () { toggleLineSelect(cb.getAttribute("data-select"), cb.checked); });
    });
    var selCount = Object.keys(state.selectedIds).length;
    var selectAll = document.getElementById("selectAllLines");
    selectAll.checked = lines.length > 0 && selCount === lines.length;
    selectAll.indeterminate = selCount > 0 && selCount < lines.length;
    updateSelectionButton();
  }

  function toggleLineSelect(id, checked) {
    if (checked) state.selectedIds[id] = true; else delete state.selectedIds[id];
    var selCount = Object.keys(state.selectedIds).length;
    var lines = linesForMonth(state.viewYear, state.viewMonth);
    var selectAll = document.getElementById("selectAllLines");
    selectAll.checked = lines.length > 0 && selCount === lines.length;
    selectAll.indeterminate = selCount > 0 && selCount < lines.length;
    document.querySelectorAll('.line-select[data-select="' + id + '"]').forEach(function (cb) { cb.checked = checked; });
    updateSelectionButton();
  }

  function updateSelectionButton() {
    var count = Object.keys(state.selectedIds).length;
    var receiptsBtn = document.getElementById("btnDownloadReceiptsSelection");
    receiptsBtn.classList.toggle("hidden", count === 0);
    receiptsBtn.textContent = "Télécharger les justificatifs (" + count + ")";
    resetSelectionPdfButton();
    document.getElementById("btnPrintSelection").classList.toggle("hidden", count === 0);
  }

  document.getElementById("selectAllLines").addEventListener("change", function () {
    var checked = this.checked;
    var lines = linesForMonth(state.viewYear, state.viewMonth);
    state.selectedIds = {};
    if (checked) lines.forEach(function (l) { state.selectedIds[l.id] = true; });
    renderSaisie();
  });

  // ================= rendering: Récapitulatif =================
  function renderRecap() {
    document.getElementById("yearLabel").textContent = state.recapYear;
    var tbody = document.getElementById("recapTbody");
    tbody.innerHTML = "";
    var yearTotal = { frais: 0, indem: 0, total: 0 };
    var monthly = [];
    for (var m = 1; m <= 12; m++) {
      var s = sumLines(linesForMonth(state.recapYear, m));
      monthly.push(s);
      yearTotal.frais += s.frais; yearTotal.indem += s.indem; yearTotal.total += s.total;
    }
    var maxTotal = Math.max.apply(null, monthly.map(function (s) { return s.total; }).concat([1]));
    monthly.forEach(function (s, i) {
      var tr = document.createElement("tr");
      var pct = Math.round((s.total / maxTotal) * 100);
      tr.innerHTML =
        "<td style='text-transform:capitalize;'>" + MONTHS_FR[i] + "</td>" +
        '<td class="num">' + euro(s.indem) + "</td>" +
        '<td class="num">' + euro(s.frais) + "</td>" +
        '<td class="num">' + euro(s.total) + "</td>" +
        '<td class="recap-bar-cell"><div class="recap-bar-track"><div class="recap-bar-fill" style="width:' + pct + '%"></div></div></td>';
      tbody.appendChild(tr);
    });
    var totalTr = document.createElement("tr");
    totalTr.className = "recap-total";
    totalTr.innerHTML = "<td>Année</td><td class='num'>" + euro(yearTotal.indem) + "</td><td class='num'>" + euro(yearTotal.frais) + "</td><td class='num'>" + euro(yearTotal.total) + "</td><td></td>";
    tbody.appendChild(totalTr);

    document.getElementById("yearStatFrais").textContent = euro(yearTotal.frais);
    document.getElementById("yearStatIndem").textContent = euro(yearTotal.indem);
    document.getElementById("yearStatTotal").textContent = euro(yearTotal.total);
  }

  // ================= profile (incl. signature) =================
  var ORG_HEADER_PRESETS = ["URPS Chirurgiens-Dentistes PACA", "FSDL PACA"];
  function renderBrandHeader() {
    var sel = document.getElementById("brandSub");
    var current = state.profile.orgHeader || DEFAULT_PROFILE.orgHeader;
    var opts = ORG_HEADER_PRESETS.slice();
    if (opts.indexOf(current) === -1) opts.push(current);
    sel.innerHTML = opts.map(function (p) {
      return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + "</option>";
    }).join("") + '<option value="__custom__">Autre (modifier dans Profil)…</option>';
    sel.value = current;
  }
  document.getElementById("brandSub").addEventListener("change", function () {
    if (this.value === "__custom__") {
      document.querySelector('.tab[data-tab="profil"]').click();
      renderBrandHeader();
      return;
    }
    state.profile.orgHeader = this.value;
    applyOrgHeaderToProfilForm(this.value);
    state.selectedIds = {};
    renderSaisie(); renderRecap();
    saveProfile(state.profile).catch(function (err) {
      alertFallback("Échec de l'enregistrement : " + (err.message || "réessaie."));
    });
  });
  function applyOrgHeaderToProfilForm(orgHeader) {
    var orgSelect = document.getElementById("p-orgheader");
    var orgCustom = document.getElementById("p-orgheader-custom");
    var isPreset = Array.prototype.some.call(orgSelect.options, function (o) { return o.value === orgHeader; });
    if (isPreset) { orgSelect.value = orgHeader; orgCustom.classList.add("hidden"); orgCustom.value = ""; }
    else { orgSelect.value = "__custom__"; orgCustom.classList.remove("hidden"); orgCustom.value = orgHeader; }
  }
  function renderProfile() {
    document.getElementById("p-nom").value = state.profile.nom;
    document.getElementById("p-adresse1").value = state.profile.adresse1;
    document.getElementById("p-adresse2").value = state.profile.adresse2;
    document.getElementById("p-vehicule").value = state.profile.vehicleType;
    document.getElementById("p-kmrate").value = state.profile.kmRate;
    document.getElementById("p-peage").value = state.profile.peageNiceMarseille;
    var orgHeader = state.profile.orgHeader || DEFAULT_PROFILE.orgHeader;
    renderBrandHeader();
    applyOrgHeaderToProfilForm(orgHeader);
    renderRecipients();
    var img = document.getElementById("sigPreview");
    var removeBtn = document.getElementById("btnSigRemove");
    if (state.profile.signatureDataUrl) {
      img.src = state.profile.signatureDataUrl; img.classList.remove("hidden");
      removeBtn.classList.remove("hidden");
    } else {
      img.classList.add("hidden"); img.src = "";
      removeBtn.classList.add("hidden");
    }
  }
  document.getElementById("btnSigUpload").addEventListener("click", function () { document.getElementById("sigInput").click(); });
  document.getElementById("sigInput").addEventListener("change", async function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      var rawDataUrl = await readFileAsDataUrl(file);
      var resized = await resizeImageDataUrl(rawDataUrl, 600, 0.85);
      state.profile.signatureDataUrl = resized.dataUrl;
      renderProfile();
    } catch (err) {
      alertFallback("Impossible de lire cette image, réessaie.");
    }
  });
  document.getElementById("btnSigRemove").addEventListener("click", function () {
    state.profile.signatureDataUrl = null;
    renderProfile();
  });

  // ---- recipients (destinataires) ----
  function recipientsList() {
    if (state.profile.recipients && state.profile.recipients.length) return state.profile.recipients;
    return DEFAULT_PROFILE.recipients.map(function (r) { return Object.assign({}, r); });
  }
  function defaultRecipientEmail() {
    var list = recipientsList();
    return list[0] ? list[0].email : "";
  }
  function renderRecipients() {
    var list = document.getElementById("recipientList");
    var items = state.profile.recipients || [];
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<div class="helper">Aucun destinataire — ajoute-en un ci-dessous.</div>';
      return;
    }
    items.forEach(function (r, idx) {
      var row = document.createElement("div");
      row.className = "recipient-row";
      row.innerHTML = '<div class="recipient-info"><strong>' + escapeHtml(r.label || "Sans nom") + '</strong><span>' + escapeHtml(r.email) + "</span></div>" +
        '<button type="button" class="btn btn-small btn-danger" data-remove-recipient="' + idx + '">✕</button>';
      list.appendChild(row);
    });
    list.querySelectorAll("[data-remove-recipient]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.profile.recipients.splice(parseInt(btn.getAttribute("data-remove-recipient"), 10), 1);
        renderRecipients();
      });
    });
  }
  document.getElementById("btnAddRecipient").addEventListener("click", function () {
    var label = document.getElementById("p-recipient-label").value.trim();
    var email = document.getElementById("p-recipient-email").value.trim();
    if (!email) { alertFallback("Indique une adresse email pour ce destinataire."); return; }
    if (!state.profile.recipients) state.profile.recipients = [];
    state.profile.recipients.push({ label: label || email, email: email });
    document.getElementById("p-recipient-label").value = "";
    document.getElementById("p-recipient-email").value = "";
    renderRecipients();
  });

  document.getElementById("p-orgheader").addEventListener("change", function () {
    document.getElementById("p-orgheader-custom").classList.toggle("hidden", this.value !== "__custom__");
  });

  document.getElementById("profileForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var orgSelectVal = document.getElementById("p-orgheader").value;
    var orgHeader = orgSelectVal === "__custom__"
      ? (document.getElementById("p-orgheader-custom").value.trim() || DEFAULT_PROFILE.orgHeader)
      : orgSelectVal;
    var p = {
      nom: document.getElementById("p-nom").value.trim(),
      adresse1: document.getElementById("p-adresse1").value.trim(),
      adresse2: document.getElementById("p-adresse2").value.trim(),
      recipients: recipientsList(),
      orgHeader: orgHeader,
      vehicleType: document.getElementById("p-vehicule").value,
      kmRate: num(document.getElementById("p-kmrate").value) || DEFAULT_PROFILE.kmRate,
      peageNiceMarseille: num(document.getElementById("p-peage").value) || 0,
      signatureDataUrl: state.profile.signatureDataUrl || null
    };
    state.profile = p;
    state.selectedIds = {};
    renderBrandHeader(); renderSaisie(); renderRecap();
    saveProfile(p).then(function () {
      var saved = document.getElementById("profileSaved");
      saved.classList.remove("hidden");
      setTimeout(function () { saved.classList.add("hidden"); }, 2000);
    }).catch(function (err) {
      alertFallback("Échec de l'enregistrement du profil : " + (err.message || "réessaie."));
    });
  });

  // ================= PDF export =================
  var ACCENT_RGB = [47, 93, 80];

  function pdfHeader(doc, margin, title) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(20);
    doc.text(title, margin, 18);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(state.profile.orgHeader || DEFAULT_PROFILE.orgHeader, margin, 24);
    doc.setTextColor(20);
  }
  function pdfIdentityBlock(doc, margin, startY) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(20);
    var y = startY;
    [state.profile.nom, state.profile.adresse1, state.profile.adresse2, "Adressé à : " + defaultRecipientEmail()].forEach(function (t) {
      doc.text(t, margin, y);
      y += 5;
    });
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8.5);
    doc.setTextColor(90);
    doc.text("Merci de joindre les justificatifs au format PDF.", margin, y + 1);
    doc.setTextColor(20);
    doc.setFont("helvetica", "normal");
    return y + 9;
  }
  function pdfSignatureBlock(doc, margin, pageWidth, y) {
    var pageHeight = doc.internal.pageSize.getHeight();
    if (y > pageHeight - 55) { doc.addPage(); y = 25; }
    var today = new Date();
    var todayStr = pad2(today.getDate()) + "/" + pad2(today.getMonth() + 1) + "/" + today.getFullYear();
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text("Fait le " + todayStr, margin, y + 22);
    doc.setDrawColor(160);
    doc.line(margin, y + 24, margin + 65, y + 24);

    if (state.profile.signatureDataUrl) {
      var sigW = 42, sigH = 18;
      try {
        var sigX = pageWidth - margin - sigW;
        doc.addImage(state.profile.signatureDataUrl, "JPEG", sigX, y, sigW, sigH);
      } catch (e) { /* unsupported format, skip image */ }
    }
    var sigX2 = pageWidth - margin - 42;
    doc.setDrawColor(160);
    doc.line(sigX2, y + 22, pageWidth - margin, y + 22);
    doc.text("Signature", sigX2, y + 27);
  }
  async function pdfReceiptsAppendix(doc, margin, pageWidth, lines) {
    var pageHeight = doc.internal.pageSize.getHeight();
    for (var li = 0; li < lines.length; li++) {
      var l = lines[li];
      var items = receiptsFor(l.id);
      for (var ri = 0; ri < items.length; ri++) {
        var r = items[ri];
        doc.addPage();
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.setTextColor(20);
        doc.text(displayDate(l.date) + " — " + (l.descriptif || "Justificatif"), margin, 16);
        doc.setFont("helvetica", "normal");
        if (r.mimeType === "application/pdf" || WORD_MIME_TYPES.indexOf(r.mimeType) >= 0) {
          doc.setFontSize(10);
          doc.text("Justificatif : " + (r.filename || "document") + " (à joindre séparément à l'envoi — non affichable ici)", margin, 26);
          continue;
        }
        try {
          var url = await getReceiptUrl(r);
          var resp = await fetch(url);
          var blob = await resp.blob();
          var dataUrl = await new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(fr.result); };
            fr.onerror = reject;
            fr.readAsDataURL(blob);
          });
          var maxW = pageWidth - margin * 2;
          var maxH = pageHeight - 30;
          var rw = r.width || maxW, rh = r.height || maxH;
          var ratio = Math.min(maxW / rw, maxH / rh, 1);
          doc.addImage(dataUrl, "JPEG", margin, 22, rw * ratio, rh * ratio);
        } catch (err) {
          doc.setFontSize(10);
          doc.text("(justificatif indisponible : " + (r.filename || "") + ")", margin, 26);
        }
      }
    }
  }

  async function buildNoteDoc(lines, sums, titleLine) {
    if (!window.jspdf) throw new Error("La bibliothèque PDF n'a pas pu se charger — vérifie ta connexion et recharge la page.");
    var doc = new window.jspdf.jsPDF();
    var margin = 14;
    var pageWidth = doc.internal.pageSize.getWidth();
    pdfHeader(doc, margin, titleLine);
    var y = pdfIdentityBlock(doc, margin, 32);

    var head = [["Date", "Descriptif", "Transport", "Km", "Frais km", "Parking", "Hôtel", "Repas", "Divers", "Trajet", "1/2j", "Visio", "Indemnités", "Total"]];
    var body = lines.map(function (l) {
      var c = computeLine(l);
      return [displayDate(l.date), l.descriptif || "", euroPdf(l.transport), String(l.km || 0), euroPdf(c.fraisKm), euroPdf(l.parking), euroPdf(l.hotel), euroPdf(l.repas), euroPdf(l.divers), TRAJET_LABELS[l.trajet || "none"], String(l.demiJournees || 0), String(l.visio || 0), euroPdf(c.indemnites), euroPdf(c.total)];
    });
    doc.autoTable({
      head: head, body: body, startY: y,
      styles: { fontSize: 6.5, cellPadding: 1.4, textColor: 20 },
      headStyles: { fillColor: ACCENT_RGB, textColor: 255, fontStyle: "bold" },
      columnStyles: {
        2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" },
        6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" }, 10: { halign: "right" },
        11: { halign: "right" }, 12: { halign: "right" }, 13: { halign: "right" }
      },
      margin: { left: margin, right: margin, top: 30 }
    });

    var pageHeight = doc.internal.pageSize.getHeight();
    var afterY = doc.lastAutoTable.finalY + 10;
    if (afterY > pageHeight - 40) { doc.addPage(); afterY = 20; }
    var labelX = pageWidth - margin - 75;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text("Total frais", labelX, afterY);
    doc.text(euroPdf(sums.frais), pageWidth - margin, afterY, { align: "right" });
    doc.text("Total indemnités", labelX, afterY + 6);
    doc.text(euroPdf(sums.indem), pageWidth - margin, afterY + 6, { align: "right" });
    doc.setDrawColor(20);
    doc.line(labelX, afterY + 9, pageWidth - margin, afterY + 9);
    doc.setFont("helvetica", "bold");
    doc.text("Dépenses totales", labelX, afterY + 15);
    doc.text(euroPdf(sums.total), pageWidth - margin, afterY + 15, { align: "right" });
    doc.setFont("helvetica", "normal");

    pdfSignatureBlock(doc, margin, pageWidth, afterY + 22);
    await pdfReceiptsAppendix(doc, margin, pageWidth, lines);
    return doc;
  }

  function buildRecapDoc(year, titleLine) {
    if (!window.jspdf) throw new Error("La bibliothèque PDF n'a pas pu se charger — vérifie ta connexion et recharge la page.");
    var doc = new window.jspdf.jsPDF();
    var margin = 14;
    var pageWidth = doc.internal.pageSize.getWidth();
    pdfHeader(doc, margin, titleLine);
    var y = pdfIdentityBlock(doc, margin, 32);

    var yearTotal = { indem: 0, frais: 0, total: 0 };
    var body = [];
    for (var m = 1; m <= 12; m++) {
      var s = sumLines(linesForMonth(year, m));
      yearTotal.indem += s.indem; yearTotal.frais += s.frais; yearTotal.total += s.total;
      body.push([MONTHS_FR[m - 1], euroPdf(s.indem), euroPdf(s.frais), euroPdf(s.total)]);
    }
    doc.autoTable({
      head: [["Mois", "Indemnités", "Frais", "Total"]], body: body, startY: y,
      styles: { fontSize: 9, cellPadding: 2.2, textColor: 20 },
      headStyles: { fillColor: ACCENT_RGB, textColor: 255, fontStyle: "bold" },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
      margin: { left: margin, right: margin, top: 30 }
    });

    var afterY = doc.lastAutoTable.finalY + 10;
    var labelX = pageWidth - margin - 75;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text("Total " + year, labelX, afterY);
    doc.text(euroPdf(yearTotal.total), pageWidth - margin, afterY, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("dont indemnités", labelX, afterY + 7);
    doc.text(euroPdf(yearTotal.indem), pageWidth - margin, afterY + 7, { align: "right" });
    doc.text("dont frais", labelX, afterY + 13);
    doc.text(euroPdf(yearTotal.frais), pageWidth - margin, afterY + 13, { align: "right" });

    pdfSignatureBlock(doc, margin, pageWidth, afterY + 22);
    return doc;
  }

  // Browsers can silently drop a download triggered after an `await` (the click's "user
  // activation" can expire while the PDF is being built, e.g. while fetching receipt images).
  // So: generate on the first click, then require a second, fully-synchronous click to save —
  // that second click is a fresh user gesture the browser always honors.
  var pendingMonthPdf = null;
  function resetMonthPdfButton() {
    pendingMonthPdf = null;
    var btn = document.getElementById("btnPrintMonth");
    btn.textContent = "Télécharger en PDF";
    btn.disabled = false;
  }
  document.getElementById("btnPrintMonth").addEventListener("click", async function () {
    var btn = this;
    if (pendingMonthPdf) {
      pendingMonthPdf.doc.save(pendingMonthPdf.filename);
      resetMonthPdfButton();
      return;
    }
    btn.textContent = "Génération…"; btn.disabled = true;
    try {
      var lines = linesForMonth(state.viewYear, state.viewMonth);
      var sums = sumLines(lines);
      var label = MONTHS_FR[state.viewMonth - 1] + " " + state.viewYear;
      var doc = await buildNoteDoc(lines, sums, "Note de frais — " + state.profile.nom + " — " + label);
      pendingMonthPdf = { doc: doc, filename: "note-de-frais-" + slugify(state.profile.nom) + "-" + monthKey(state.viewYear, state.viewMonth) + ".pdf" };
      btn.textContent = "✓ Cliquer pour télécharger";
      btn.disabled = false;
    } catch (err) {
      alertFallback("Échec de la génération du PDF : " + (err.message || "réessaie."));
      resetMonthPdfButton();
    }
  });

  var pendingSelectionPdf = null;
  function resetSelectionPdfButton() {
    pendingSelectionPdf = null;
    var btn = document.getElementById("btnPrintSelection");
    btn.textContent = "Télécharger la note (" + Object.keys(state.selectedIds).length + ")";
    btn.disabled = false;
  }
  document.getElementById("btnPrintSelection").addEventListener("click", async function () {
    var btn = this;
    if (pendingSelectionPdf) {
      pendingSelectionPdf.doc.save(pendingSelectionPdf.filename);
      resetSelectionPdfButton();
      return;
    }
    var lines = linesForMonth(state.viewYear, state.viewMonth).filter(function (l) { return state.selectedIds[l.id]; });
    if (!lines.length) { alertFallback("Aucune ligne sélectionnée."); return; }
    btn.textContent = "Génération…"; btn.disabled = true;
    try {
      var sums = sumLines(lines);
      var label = MONTHS_FR[state.viewMonth - 1] + " " + state.viewYear;
      var doc = await buildNoteDoc(lines, sums, "Note de frais (sélection) — " + state.profile.nom + " — " + label);
      pendingSelectionPdf = { doc: doc, filename: "note-de-frais-selection-" + slugify(state.profile.nom) + "-" + monthKey(state.viewYear, state.viewMonth) + ".pdf" };
      btn.textContent = "✓ Cliquer pour télécharger";
      btn.disabled = false;
    } catch (err) {
      alertFallback("Échec de la génération du PDF : " + (err.message || "réessaie."));
      resetSelectionPdfButton();
    }
  });

  document.getElementById("btnPrintYear").addEventListener("click", function () {
    try {
      var doc = buildRecapDoc(state.recapYear, "Récapitulatif annuel — " + state.profile.nom + " — " + state.recapYear);
      doc.save("recapitulatif-" + slugify(state.profile.nom) + "-" + state.recapYear + ".pdf");
    } catch (err) {
      alertFallback("Échec de la génération du PDF : " + (err.message || "réessaie."));
    }
  });

  // ================= CSV export =================
  function csvEscape(v) { v = String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function saveCsv(filename, rows) {
    var csv = "﻿" + rows.map(function (r) { return r.map(csvEscape).join(";"); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  document.getElementById("btnCsvMonth").addEventListener("click", function () {
    var lines = linesForMonth(state.viewYear, state.viewMonth);
    var label = MONTHS_FR[state.viewMonth - 1] + " " + state.viewYear;
    var header = ["Date","Descriptif","Transport","Km","Frais km","Parking","Hôtel","Repas","Divers","Trajet","1/2j présentiel","Visio","Indemnités","Total"];
    var rows = [["Note de frais", state.profile.nom, label], [], header];
    lines.forEach(function (l) {
      var c = computeLine(l);
      rows.push([l.date, l.descriptif || "", l.transport, l.km, c.fraisKm.toFixed(2), l.parking, l.hotel, l.repas, l.divers, TRAJET_LABELS[l.trajet || "none"], l.demiJournees, l.visio, c.indemnites.toFixed(2), c.total.toFixed(2)]);
    });
    saveCsv("note-de-frais-" + slugify(state.profile.nom) + "-" + monthKey(state.viewYear, state.viewMonth) + ".csv", rows);
  });

  async function downloadReceiptsForLines(lines, btn, emptyMessage) {
    var jobs = [];
    lines.forEach(function (l) {
      receiptsFor(l.id).forEach(function (r) {
        jobs.push({ line: l, receipt: r });
      });
    });
    if (!jobs.length) { alertFallback(emptyMessage); return; }
    btn.disabled = true;
    var oldText = btn.textContent;
    for (var i = 0; i < jobs.length; i++) {
      btn.textContent = "Téléchargement " + (i + 1) + "/" + jobs.length + "…";
      var ext = jobs[i].receipt.mimeType === "application/pdf" ? "pdf" : WORD_MIME_TYPES.indexOf(jobs[i].receipt.mimeType) >= 0 ? "docx" : "jpg";
      var name = jobs[i].line.date + "-" + slugify(jobs[i].line.descriptif || "justificatif") + "-" + (i + 1) + "." + ext;
      await downloadReceiptFile(Object.assign({}, jobs[i].receipt, { filename: name }));
      await new Promise(function (resolve) { setTimeout(resolve, 350); });
    }
    btn.textContent = oldText;
    btn.disabled = false;
  }

  document.getElementById("btnDownloadReceiptsMonth").addEventListener("click", function () {
    var lines = linesForMonth(state.viewYear, state.viewMonth);
    downloadReceiptsForLines(lines, this, "Aucun justificatif ce mois-ci.");
  });

  document.getElementById("btnDownloadReceiptsSelection").addEventListener("click", function () {
    var lines = linesForMonth(state.viewYear, state.viewMonth).filter(function (l) { return state.selectedIds[l.id]; });
    downloadReceiptsForLines(lines, this, "Aucun justificatif sur les lignes sélectionnées.");
  });

  document.getElementById("btnCsvYear").addEventListener("click", function () {
    var y = state.recapYear;
    var rows = [["Récapitulatif annuel", state.profile.nom, y], [], ["Mois","Indemnités","Frais","Total"]];
    for (var m = 1; m <= 12; m++) {
      var s = sumLines(linesForMonth(y, m));
      rows.push([MONTHS_FR[m - 1], s.indem.toFixed(2), s.frais.toFixed(2), s.total.toFixed(2)]);
    }
    saveCsv("recapitulatif-" + slugify(state.profile.nom) + "-" + y + ".csv", rows);
  });

  // ================= email (copy-to-clipboard flow) =================
  function selectReadonlyField(el) { el.focus(); el.select(); }
  ["emailSubject", "emailBody"].forEach(function (id) {
    document.getElementById(id).addEventListener("click", function () { selectReadonlyField(this); });
  });

  document.getElementById("btnEmailMonth").addEventListener("click", function () {
    var lines = linesForMonth(state.viewYear, state.viewMonth);
    var sums = sumLines(lines);
    var label = MONTHS_FR[state.viewMonth - 1] + " " + state.viewYear;
    var subject = "Note de frais - " + label + " - " + state.profile.nom;
    var body = "Bonjour,\n\nVeuillez trouver ci-joint ma note de frais pour " + label + " (PDF téléchargé via le bouton \"Télécharger en PDF\").\n\n" +
      "Total frais : " + euro(sums.frais) + "\nTotal indemnités : " + euro(sums.indem) + "\nDépenses totales : " + euro(sums.total) +
      "\n\nCordialement,\n" + state.profile.nom;

    var select = document.getElementById("emailTo");
    select.innerHTML = "";
    recipientsList().forEach(function (r) {
      var opt = document.createElement("option");
      opt.value = r.email;
      opt.textContent = (r.label ? r.label + " — " : "") + r.email;
      select.appendChild(opt);
    });

    document.getElementById("emailSubject").value = subject;
    document.getElementById("emailBody").value = body;
    document.getElementById("emailStatus").textContent = "Choisis le destinataire ci-dessus, puis copie le message ou ouvre-le dans ton appli mail. Joins toi-même le PDF (bouton \"Télécharger en PDF\") et, si tu as des justificatifs PDF/Word, télécharge-les aussi (\"Télécharger les justificatifs\") pour les joindre.";
    var panel = document.getElementById("emailPanel");
    panel.classList.remove("hidden");
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  document.getElementById("btnOpenMail").addEventListener("click", function () {
    var subject = document.getElementById("emailSubject").value;
    var body = document.getElementById("emailBody").value;
    var to = document.getElementById("emailTo").value;
    try {
      var a = document.createElement("a");
      a.href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      alertFallback("Impossible d'ouvrir ton application mail automatiquement — utilise plutôt \"Copier le message\".");
    }
  });

  document.getElementById("btnCopyEmail").addEventListener("click", function () {
    var text = "À : " + document.getElementById("emailTo").value + "\nObjet : " + document.getElementById("emailSubject").value + "\n\n" + document.getElementById("emailBody").value;
    var status = document.getElementById("emailStatus");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        status.textContent = "Copié ✓ — colle-le (Cmd/Ctrl+V) dans un nouveau mail à " + document.getElementById("emailTo").value + ".";
      }).catch(function () {
        selectReadonlyField(document.getElementById("emailBody"));
        status.textContent = "Copie automatique impossible — le message est sélectionné, copie-le avec Cmd/Ctrl+C.";
      });
    } else {
      selectReadonlyField(document.getElementById("emailBody"));
      status.textContent = "Le message est sélectionné — copie-le avec Cmd/Ctrl+C.";
    }
  });

  // ================= Supabase: data layer =================
  function rowToExpense(row) {
    return {
      id: row.id, date: row.date, descriptif: row.descriptif,
      transport: row.transport, km: row.km, kmRate: row.km_rate,
      parking: row.parking, hotel: row.hotel, repas: row.repas, divers: row.divers,
      trajet: row.trajet, trajetRate: row.trajet_rate,
      demiJournees: row.demi_journees, visio: row.visio, forfaitRate: row.forfait_rate,
      orgHeader: row.org_header || DEFAULT_PROFILE.orgHeader
    };
  }
  function expenseToRow(id, l) {
    return {
      id: id, user_id: state.userId, date: l.date, descriptif: l.descriptif,
      transport: l.transport, km: l.km, km_rate: l.kmRate,
      parking: l.parking, hotel: l.hotel, repas: l.repas, divers: l.divers,
      trajet: l.trajet, trajet_rate: l.trajetRate,
      demi_journees: l.demiJournees, visio: l.visio, forfait_rate: l.forfaitRate,
      org_header: l.orgHeader || DEFAULT_PROFILE.orgHeader
    };
  }
  function rowToReceipt(row) {
    return {
      id: row.id, expenseId: row.expense_id, filename: row.filename,
      storagePath: row.storage_path, mimeType: row.mime_type, width: row.width, height: row.height
    };
  }
  function rowToProfile(row) {
    if (!row) return Object.assign({}, DEFAULT_PROFILE, { recipients: DEFAULT_PROFILE.recipients.map(function (r) { return Object.assign({}, r); }) });
    return {
      nom: row.nom || "", adresse1: row.adresse1 || "", adresse2: row.adresse2 || "",
      recipients: (row.recipients && row.recipients.length) ? row.recipients : DEFAULT_PROFILE.recipients.map(function (r) { return Object.assign({}, r); }),
      orgHeader: row.org_header || DEFAULT_PROFILE.orgHeader,
      kmRate: row.km_rate || DEFAULT_PROFILE.kmRate,
      vehicleType: row.vehicle_type || "Auto", peageNiceMarseille: row.peage_nice_marseille || DEFAULT_PROFILE.peageNiceMarseille,
      signatureDataUrl: row.signature_data_url || null,
      email: row.email || "", isApproved: !!row.is_approved, isAdmin: !!row.is_admin
    };
  }

  async function upsertExpense(id, l) {
    var row = expenseToRow(id, l);
    var res = await sb.from("expenses").upsert(row);
    if (res.error) throw res.error;
    await refreshExpenses();
  }
  async function deleteExpense(id) {
    await removeReceiptsFor(id);
    var res = await sb.from("expenses").delete().eq("id", id);
    if (res.error) throw res.error;
    await refreshExpenses();
  }
  async function refreshExpenses() {
    var res = await sb.from("expenses").select("*").eq("user_id", state.userId).order("date", { ascending: false });
    if (res.error) { alertFallback("Erreur de chargement des dépenses."); return; }
    state.expenses = res.data.map(rowToExpense);
    renderSaisie(); renderRecap();
  }
  async function refreshReceipts() {
    var res = await sb.from("receipts").select("*").eq("user_id", state.userId);
    if (res.error) { alertFallback("Erreur de chargement des justificatifs."); return; }
    state.receipts = res.data.map(rowToReceipt);
    renderReceipts(); renderSaisie();
  }
  async function saveProfile(p) {
    var row = {
      id: state.userId, nom: p.nom, adresse1: p.adresse1, adresse2: p.adresse2,
      recipients: p.recipients, org_header: p.orgHeader,
      km_rate: p.kmRate, vehicle_type: p.vehicleType, peage_nice_marseille: p.peageNiceMarseille,
      signature_data_url: p.signatureDataUrl, updated_at: new Date().toISOString()
    };
    var res = await sb.from("profiles").upsert(row);
    if (res.error) throw res.error;
  }
  async function loadProfile() {
    var res = await sb.from("profiles").select("*").eq("id", state.userId).maybeSingle();
    if (res.error) { alertFallback("Erreur de chargement du profil."); return; }
    state.profile = rowToProfile(res.data);
    renderProfile();
  }

  // ================= admin (validation des comptes) =================
  async function refreshAdmin() {
    var pendingRes = await sb.from("profiles").select("*").eq("is_approved", false).order("nom");
    var pendingList = document.getElementById("pendingList");
    pendingList.innerHTML = "";
    if (pendingRes.error) { pendingList.innerHTML = '<div class="admin-empty">Erreur de chargement.</div>'; }
    else if (!pendingRes.data.length) { pendingList.innerHTML = '<div class="admin-empty">Aucune demande en attente.</div>'; }
    else {
      pendingRes.data.forEach(function (row) {
        var div = document.createElement("div");
        div.className = "admin-row";
        div.innerHTML = '<div class="admin-info"><strong>' + escapeHtml(row.nom || "(sans nom)") + '</strong> — ' + escapeHtml(row.email || row.id) + '</div>' +
          '<button type="button" class="btn btn-small btn-primary" data-approve="' + row.id + '">Approuver</button>';
        pendingList.appendChild(div);
      });
      pendingList.querySelectorAll("[data-approve]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          var res = await sb.from("profiles").update({ is_approved: true }).eq("id", btn.getAttribute("data-approve"));
          if (res.error) { alertFallback("Échec de l'approbation : " + res.error.message); btn.disabled = false; }
          else refreshAdmin();
        });
      });
    }

    var allowedRes = await sb.from("allowed_emails").select("*").order("email");
    var allowedList = document.getElementById("allowedList");
    allowedList.innerHTML = "";
    if (allowedRes.error) { allowedList.innerHTML = '<div class="admin-empty">Erreur de chargement.</div>'; }
    else if (!allowedRes.data.length) { allowedList.innerHTML = '<div class="admin-empty">Aucune adresse pré-approuvée.</div>'; }
    else {
      allowedRes.data.forEach(function (row) {
        var div = document.createElement("div");
        div.className = "admin-row";
        div.innerHTML = '<div class="admin-info">' + escapeHtml(row.email) + '</div>' +
          '<button type="button" class="btn btn-small btn-danger" data-remove-allowed="' + escapeHtml(row.email) + '">✕</button>';
        allowedList.appendChild(div);
      });
      allowedList.querySelectorAll("[data-remove-allowed]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          await sb.from("allowed_emails").delete().eq("email", btn.getAttribute("data-remove-allowed"));
          refreshAdmin();
        });
      });
    }
  }
  document.getElementById("btnAddAllowed").addEventListener("click", async function () {
    var input = document.getElementById("p-allowed-email");
    var email = input.value.trim().toLowerCase();
    if (!email) return;
    var res = await sb.from("allowed_emails").insert({ email: email, added_by: state.userId });
    if (res.error) { alertFallback("Échec de l'ajout : " + res.error.message); return; }
    input.value = "";
    refreshAdmin();
  });

  function subscribeRealtime() {
    if (expensesChannel) sb.removeChannel(expensesChannel);
    if (receiptsChannel) sb.removeChannel(receiptsChannel);
    expensesChannel = sb.channel("expenses-" + state.userId)
      .on("postgres_changes", { event: "*", schema: "public", table: "expenses", filter: "user_id=eq." + state.userId }, function () { refreshExpenses(); })
      .subscribe();
    receiptsChannel = sb.channel("receipts-" + state.userId)
      .on("postgres_changes", { event: "*", schema: "public", table: "receipts", filter: "user_id=eq." + state.userId }, function () { refreshReceipts(); })
      .subscribe();
  }

  // ================= auth =================
  var authMode = "login";
  function setAuthMode(mode) {
    authMode = mode;
    document.getElementById("authTabLogin").classList.toggle("active", mode === "login");
    document.getElementById("authTabSignup").classList.toggle("active", mode === "signup");
    document.getElementById("authSubmit").textContent = mode === "login" ? "Se connecter" : "Créer mon compte";
    hideAuthMessages();
  }
  document.getElementById("authTabLogin").addEventListener("click", function () { setAuthMode("login"); });
  document.getElementById("authTabSignup").addEventListener("click", function () { setAuthMode("signup"); });

  function hideAuthMessages() {
    document.getElementById("authError").classList.add("hidden");
    document.getElementById("authInfo").classList.add("hidden");
  }
  function showAuthError(msg) {
    var el = document.getElementById("authError");
    el.textContent = msg; el.classList.remove("hidden");
    document.getElementById("authInfo").classList.add("hidden");
  }
  function showAuthInfo(msg) {
    var el = document.getElementById("authInfo");
    el.textContent = msg; el.classList.remove("hidden");
    document.getElementById("authError").classList.add("hidden");
  }

  document.getElementById("authForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!sb) { showAuthError("Configuration manquante : édite config.js avec l'URL et la clé Supabase du projet, puis recharge la page."); return; }
    hideAuthMessages();
    var email = document.getElementById("auth-email").value.trim();
    var password = document.getElementById("auth-password").value;
    var btn = document.getElementById("authSubmit");
    btn.disabled = true;
    try {
      if (authMode === "signup") {
        var res = await sb.auth.signUp({ email: email, password: password });
        if (res.error) throw res.error;
        if (res.data.session) { /* auto-logged in, onAuthStateChange handles it */ }
        else showAuthInfo("Compte créé — vérifie ta boîte mail pour confirmer ton adresse, puis connecte-toi.");
      } else {
        var res2 = await sb.auth.signInWithPassword({ email: email, password: password });
        if (res2.error) throw res2.error;
      }
    } catch (err) {
      showAuthError(err.message === "Invalid login credentials" ? "Email ou mot de passe incorrect." : (err.message || "Erreur, réessaie."));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("authForgot").addEventListener("click", async function (e) {
    e.preventDefault();
    if (!sb) { showAuthError("Configuration manquante : édite config.js avec l'URL et la clé Supabase du projet, puis recharge la page."); return; }
    hideAuthMessages();
    var email = document.getElementById("auth-email").value.trim();
    if (!email) { showAuthError("Saisis ton email ci-dessus puis clique à nouveau sur ce lien."); return; }
    try {
      var res = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
      if (res.error) throw res.error;
      showAuthInfo("Email de réinitialisation envoyé si ce compte existe.");
    } catch (err) {
      showAuthError(err.message || "Erreur, réessaie.");
    }
  });

  document.getElementById("btnLogout").addEventListener("click", function () {
    sb.auth.signOut();
  });

  function hideAllScreens() {
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("appScreen").classList.add("hidden");
    document.getElementById("pendingApprovalScreen").classList.add("hidden");
  }
  function showAuthScreen() {
    hideAllScreens();
    document.getElementById("authScreen").classList.remove("hidden");
  }
  function showPendingScreen() {
    hideAllScreens();
    document.getElementById("pendingApprovalScreen").classList.remove("hidden");
  }
  document.getElementById("btnPendingLogout").addEventListener("click", function () { sb.auth.signOut(); });

  async function showAppScreen(user) {
    try {
      state.userId = user.id;
      document.getElementById("userEmail").textContent = user.email;
      await loadProfile();
      if (!state.profile.isApproved && !state.profile.isAdmin) {
        showPendingScreen();
        return;
      }
      hideAllScreens();
      document.getElementById("appScreen").classList.remove("hidden");
      document.getElementById("tabAdmin").classList.toggle("hidden", !state.profile.isAdmin);
      resetForm();
      await refreshExpenses();
      await refreshReceipts();
      subscribeRealtime();
      if (state.profile.isAdmin) {
        refreshAdmin().catch(function (err) { console.error("refreshAdmin failed", err); });
      }
    } catch (err) {
      // Whatever went wrong, never leave the viewer on a blank page.
      console.error("showAppScreen failed", err);
      hideAllScreens();
      document.getElementById("appScreen").classList.remove("hidden");
      alertFallback("Erreur au chargement : " + (err.message || "réessaie ou recharge la page.") + " (détails dans la console)");
    }
  }

  // ================= init =================
  function init() {
    renderSaisie();
    renderRecap();
    renderProfile();
    initMic();

    if (!window.SUPABASE_URL || !window.supabase || window.SUPABASE_URL.indexOf("xxxx") >= 0) {
      showAuthError("Configuration manquante : édite config.js avec l'URL et la clé Supabase du projet.");
      return;
    }
    sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    // onAuthStateChange alone already fires once immediately with the current session
    // (restored, or none) — calling getSession() as well raced it and could invoke
    // showAppScreen twice concurrently, which crashed inconsistently across browsers.
    var appScreenBusy = false;
    sb.auth.onAuthStateChange(function (event, session) {
      if (session && session.user) {
        if (appScreenBusy) return;
        appScreenBusy = true;
        showAppScreen(session.user).finally(function () { appScreenBusy = false; });
      } else {
        showAuthScreen();
      }
    });
  }
  init();
})();
