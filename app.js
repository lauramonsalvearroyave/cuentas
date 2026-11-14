import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  signInWithEmailAndPassword, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, deleteDoc, onSnapshot, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const col = collection(db, "movimientos");

const $ = id => document.getElementById(id);
const fmt = n => "$" + Math.round(n).toLocaleString("es-CO");
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const MES_CORTO = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const parseMonto = s => +String(s).replace(/\D/g, "") || 0;
const sinTildes = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const store = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
                set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} } };

/* ================= Categorías ================= */
// Orden fijo: cada categoría conserva su color aunque cambie el filtro.
const CATS = [
  { id: "proveedores", name: "Proveedores y negocio" },
  { id: "viajes",      name: "Viajes y tiquetes" },
  { id: "seguridad",   name: "Seguridad social y ARL" },
  { id: "familia",     name: "Familia y personal" },
  { id: "personas",    name: "Pagos a personas" },
  { id: "tramites",    name: "Trámites" },
  { id: "otros",       name: "Sin identificar" },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const catColor = id => `var(--cat-${id})`;

// Sugerencia automática según la descripción (el orden importa: "seguridad social mamá" es seguridad, no familia).
const REGLAS = [
  ["otros",       /\bno se\b|no se sabe|desconocid/],
  ["seguridad",   /seguridad social|\barl\b|\beps\b|pension|salud|caja de compensacion/],
  ["viajes",      /tiquete|vuelo|viaje|hotel|bus\b|peaje|avion|hospedaje/],
  ["tramites",    /prenda|transito|notaria|impuesto|soat|tecnomecanica|tramite|registro/],
  ["proveedores", /proveedor|material|sticker|tarjeta|trans-?port|ferro|insumo|mercancia|factura|bodega|flete/],
  ["familia",     /colegio|comida|mercado|mama|papa|blusa|ropa|cita|medic|droga|arriendo|servicios|amelia/],
];
function sugerir(desc) {
  const d = sinTildes(desc);
  if (!d.trim()) return null;
  for (const [id, re] of REGLAS) if (re.test(d)) return id;
  return null;
}
const catOf = r => (r.categoria && CAT[r.categoria]) ? r.categoria : (sugerir(r.descripcion) || "otros");

/* ================= Estado ================= */
let tipo = "gasto", editId = null, rows = [], unsub = null, loaded = false, catTocada = false;
let tab = ["gasto", "ingreso", "todo"].includes(store.get("tab")) ? store.get("tab") : "gasto";
let mes = "todos", catFiltro = null, busqueda = "";

/* ================= Sesión ================= */
function loginMsg(t, err) { $("login-msg").textContent = t; $("login-msg").className = "msg" + (err ? " err" : ""); }

$("login").onclick = async () => {
  loginMsg("");
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    loginMsg(e.code === "auth/unauthorized-domain"
      ? "Esta dirección web no está autorizada en Firebase. Agrégala en Authentication > Configuración > Dominios autorizados."
      : "No se pudo entrar. Intenta de nuevo.", true);
  }
};

$("pw-form").addEventListener("submit", async e => {
  e.preventDefault();
  loginMsg("");
  $("pw-submit").disabled = true;
  try { await signInWithEmailAndPassword(auth, $("pw-email").value.trim(), $("pw-pass").value); }
  catch (err) {
    loginMsg(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err.code)
      ? "El correo o la contraseña no coinciden. Si no la recuerdas, toca “Olvidé mi contraseña”."
      : err.code === "auth/too-many-requests"
        ? "Demasiados intentos. Espera unos minutos y vuelve a intentar."
        : "No se pudo entrar. Revisa la conexión e intenta de nuevo.", true);
  } finally { $("pw-submit").disabled = false; }
});

$("pw-reset").onclick = async () => {
  const email = $("pw-email").value.trim();
  if (!email) { loginMsg("Escribe tu correo arriba y vuelve a tocar “Olvidé mi contraseña”.", true); $("pw-email").focus(); return; }
  try { await sendPasswordResetEmail(auth, email); } catch (_) {}
  loginMsg(`Si ${email} tiene acceso, le llegará un correo para crear una contraseña nueva. Revisa también el correo no deseado.`);
};

$("avatar").onclick = e => {
  e.stopPropagation();
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("avatar").setAttribute("aria-expanded", open);
};
document.addEventListener("click", e => { if (!e.target.closest(".who-menu")) { $("menu").hidden = true; $("avatar").setAttribute("aria-expanded", false); } });
$("logout").onclick = () => { $("menu").hidden = true; signOut(auth); };

onAuthStateChanged(auth, user => {
  if (unsub) { unsub(); unsub = null; }
  rows = []; loaded = false;
  $("login-view").hidden = !!user;
  $("app-view").hidden = !user;
  closeSheet();
  if (!user) return;
  $("me-email").textContent = user.email;
  $("avatar").textContent = (user.displayName || user.email || "?").trim()[0].toUpperCase();
  if (!store.get("quien")) $("f-quien").value = /hotmail/i.test(user.email) ? "Sebastián" : "Laura";
  $("status").textContent = "Conectando…";
  render();
  unsub = onSnapshot(col, { includeMetadataChanges: true }, snap => {
    loaded = true;
    rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    $("status").textContent = snap.metadata.fromCache ? "Sin conexión: mostrando lo último guardado" : "Todo guardado y al día";
    render();
  }, err => {
    if (err.code === "permission-denied") {
      loginMsg(`La cuenta ${user.email} no tiene acceso. Entra con la cuenta de Laura o de Sebastián.`, true);
      signOut(auth);
    } else {
      $("status").textContent = "Se perdió la conexión. Recarga la página.";
    }
  });
});

/* ================= Filtros ================= */
document.querySelectorAll(".tab").forEach(b => b.onclick = () => {
  tab = b.dataset.tab; store.set("tab", tab);
  if (tab === "ingreso") catFiltro = null;
  render();
});
let qTimer;
$("q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { busqueda = sinTildes(e.target.value.trim()); render(); }, 150); });

const enMes = r => mes === "todos" ? true : mes === "sin" ? !r.fecha : (r.fecha || "").startsWith(mes);
const coincide = r => !busqueda || sinTildes(`${r.descripcion} ${r.quien} ${CAT[catOf(r)].name}`).includes(busqueda);

/* ================= Hoja de agregar / editar ================= */
$("f-cat").innerHTML = CATS.map(c => `<option value="${c.id}">${c.name}</option>`).join("");

function setTipo(t) {
  tipo = t;
  $("k-gasto").setAttribute("aria-pressed", t === "gasto");
  $("k-ingreso").setAttribute("aria-pressed", t === "ingreso");
  $("form").classList.toggle("is-gasto", t === "gasto");
  $("form").classList.toggle("is-ingreso", t === "ingreso");
  $("cat-field").hidden = t !== "gasto";
  $("submit").textContent = editId ? "Guardar cambios" : (t === "gasto" ? "Agregar gasto" : "Agregar ingreso");
}
$("k-gasto").onclick = () => setTipo("gasto");
$("k-ingreso").onclick = () => setTipo("ingreso");

$("f-monto").addEventListener("input", e => {
  const n = parseMonto(e.target.value);
  e.target.value = n ? fmt(n) : "";
});
$("f-desc").addEventListener("input", () => {
  if (catTocada) return;
  const s = sugerir($("f-desc").value);
  $("f-cat").value = s || "otros";
  $("cat-auto").textContent = s ? "· sugerida" : "";
});
$("f-cat").addEventListener("change", () => { catTocada = true; $("cat-auto").textContent = ""; });

const q = store.get("quien"); if (q) $("f-quien").value = q;
$("f-quien").onchange = e => store.set("quien", e.target.value);

function openSheet(r) {
  editId = r ? r.id : null;
  $("msg").textContent = ""; $("msg").className = "msg";
  $("confirm").hidden = true; $("del").hidden = false;
  $("danger").hidden = !r;
  $("form-title").textContent = r ? "Editar movimiento" : "Nuevo movimiento";
  $("f-monto").value = r ? fmt(r.monto) : "";
  $("f-desc").value = r ? (r.descripcion || "") : "";
  $("f-fecha").value = r ? (r.fecha || "") : new Date().toLocaleDateString("en-CA");
  $("f-efectivo").checked = r ? !!r.efectivo : false;
  if (r && r.quien) $("f-quien").value = r.quien;
  catTocada = !!(r && r.categoria);
  $("f-cat").value = r ? catOf(r) : (catFiltro || "otros");
  if (!r && catFiltro) catTocada = true;
  $("cat-auto").textContent = r && !r.categoria && r.tipo === "gasto" ? "· sugerida" : "";
  setTipo(r ? r.tipo : (tab === "ingreso" ? "ingreso" : "gasto"));
  $("sheet").hidden = false;
  document.body.style.overflow = "hidden";
  if (!r) setTimeout(() => $("f-monto").focus(), 60);
}
function closeSheet() {
  $("sheet").hidden = true; editId = null;
  document.body.style.overflow = "";
}
$("fab").onclick = () => openSheet(null);
$("close").onclick = closeSheet;
$("backdrop").onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

function msg(t) { $("msg").textContent = t; $("msg").className = "msg err"; }

let toastTimer;
function toast(t) {
  const el = $("toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const monto = parseMonto($("f-monto").value);
  if (!monto) { msg("Escribe el valor."); $("f-monto").focus(); return; }
  const data = {
    tipo, monto, fecha: $("f-fecha").value || "", descripcion: $("f-desc").value.trim(),
    efectivo: $("f-efectivo").checked, quien: $("f-quien").value,
  };
  if (tipo === "gasto") data.categoria = $("f-cat").value;
  $("submit").disabled = true;
  try {
    if (editId) {
      const old = rows.find(r => r.id === editId);
      await setDoc(doc(col, editId), { ...data, creado: old?.creado || Date.now() });
      toast("Cambios guardados");
    } else {
      await addDoc(col, { ...data, creado: Date.now() });
      toast((tipo === "gasto" ? "Gasto de " : "Ingreso de ") + fmt(monto) + " agregado");
      if (tab !== "todo" && tab !== tipo) { tab = tipo; store.set("tab", tab); render(); }
    }
    closeSheet();
  } catch (err) {
    msg(err.code === "permission-denied" ? "Tu cuenta no tiene permiso para guardar." : "No se pudo guardar. Revisa la conexión e intenta de nuevo.");
  } finally { $("submit").disabled = false; }
});

$("del").onclick = () => { $("del").hidden = true; $("confirm").hidden = false; };
$("del-no").onclick = () => { $("del").hidden = false; $("confirm").hidden = true; };
$("del-yes").onclick = async () => {
  if (!editId) return;
  try { await deleteDoc(doc(col, editId)); toast("Movimiento borrado"); closeSheet(); }
  catch (_) { msg("No se pudo borrar. Intenta de nuevo."); }
};

/* ================= Importar (sin duplicar) ================= */
// Si un movimiento del archivo ya existe (mismo tipo, valor, fecha y descripción) no se repite;
// solo se le completa la categoría si no la tenía.
const clave = r => [r.tipo, parseMonto(r.monto), r.fecha || "", sinTildes(r.descripcion).trim()].join("|");
$("import-file").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = "";
  $("menu").hidden = true;
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    if (!Array.isArray(list) || !list.length) throw new Error("vacío");
    const existentes = new Map(rows.map(r => [clave(r), r]));
    const batch = writeBatch(db);
    let nuevos = 0, actualizados = 0;
    for (const r of list) {
      const monto = parseMonto(r.monto);
      if (!monto || !["gasto", "ingreso"].includes(r.tipo)) continue;
      const ya = existentes.get(clave(r));
      if (ya) {
        if (r.tipo === "gasto" && r.categoria && CAT[r.categoria] && !ya.categoria) {
          batch.update(doc(col, ya.id), { categoria: r.categoria }); actualizados++;
        }
        continue;
      }
      const d = {
        tipo: r.tipo, monto, fecha: r.fecha || "", descripcion: String(r.descripcion || ""),
        efectivo: !!r.efectivo, quien: r.quien || "Laura", creado: +r.creado || Date.now(),
      };
      if (r.tipo === "gasto") d.categoria = CAT[r.categoria] ? r.categoria : (sugerir(d.descripcion) || "otros");
      batch.set(doc(col), d); nuevos++;
    }
    if (!nuevos && !actualizados) { toast("Todo lo del archivo ya estaba cargado"); return; }
    await batch.commit();
    toast(`Listo: ${nuevos} nuevos, ${actualizados} con categoría actualizada`);
  } catch (_) {
    toast("No se pudo leer el archivo. Usa datos-iniciales.json");
  }
});

/* ================= Pintar ================= */
function render() {
  const sum = (a, t, ef) => a.filter(r => r.tipo === t && !!r.efectivo === ef).reduce((s, r) => s + (+r.monto || 0), 0);

  // Encabezado: siempre el saldo total real, sin filtros
  const inB = sum(rows, "ingreso", false), outB = sum(rows, "gasto", false);
  const inC = sum(rows, "ingreso", true), outC = sum(rows, "gasto", true);
  $("t-total").textContent = fmt(inB - outB);
  $("t-in").textContent = fmt(inB);
  $("t-out").textContent = fmt(outB);
  const pct = inB ? Math.min(100, Math.round(outB / inB * 100)) : 0;
  $("meter-fill").style.width = pct + "%";
  $("meter-label").textContent = inB ? `Se ha gastado el ${pct}% de lo que entró` : "Aún no ha entrado plata al banco";
  $("c-total").textContent = fmt(inC - outC);
  $("c-in").textContent = fmt(inC);
  $("c-out").textContent = fmt(outC);
  $("import-box").hidden = !(loaded && rows.length === 0);

  renderMeses();

  // Periodo elegido
  const enPeriodo = rows.filter(enMes);
  const pIn = sum(enPeriodo, "ingreso", false), pOut = sum(enPeriodo, "gasto", false);
  $("p-title").textContent = mes === "todos" ? "Todos los meses" : mes === "sin" ? "Movimientos sin fecha" : nombreMes(mes);
  $("p-in").textContent = fmt(pIn);
  $("p-out").textContent = fmt(pOut);
  $("p-net").textContent = (pIn - pOut < 0 ? "− " : "") + fmt(Math.abs(pIn - pOut));
  $("p-net").className = "num " + (pIn - pOut < 0 ? "neg" : "pos");
  renderCats(enPeriodo.filter(r => r.tipo === "gasto"));

  // Lista
  let list = enPeriodo.filter(coincide);
  if (catFiltro) list = list.filter(r => r.tipo === "gasto" && catOf(r) === catFiltro);
  const g = list.filter(r => r.tipo === "gasto"), i = list.filter(r => r.tipo === "ingreso");
  $("n-gasto").textContent = g.length;
  $("n-ingreso").textContent = i.length;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  renderActivos();
  renderList(tab === "gasto" ? g : tab === "ingreso" ? i : list);
}

const mayus = s => s.charAt(0).toUpperCase() + s.slice(1);
const nombreMes = k => mayus(`${MESES[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`);

function renderMeses() {
  const keys = [...new Set(rows.filter(r => r.fecha).map(r => r.fecha.slice(0, 7)))].sort().reverse();
  const opts = [["todos", "Todos"], ...keys.map(k => [k, mayus(`${MES_CORTO[+k.slice(5) - 1]} ${k.slice(2, 4)}`)])];
  if (rows.some(r => !r.fecha)) opts.push(["sin", "Sin fecha"]);
  if (!opts.some(o => o[0] === mes)) mes = "todos";
  const box = $("months");
  const firma = opts.map(o => o[0]).join(",") + "|" + mes;
  if (box.dataset.firma === firma) return;
  box.dataset.firma = firma;
  box.textContent = "";
  for (const [k, label] of opts) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = label;
    b.setAttribute("aria-pressed", k === mes);
    b.onclick = () => { mes = k; render(); };
    box.append(b);
  }
}

function renderCats(gastos) {
  const tot = {};
  for (const r of gastos) { const c = catOf(r); tot[c] = (tot[c] || 0) + (+r.monto || 0); }
  const total = Object.values(tot).reduce((a, b) => a + b, 0);
  $("cats-total").textContent = total ? fmt(total) : "";
  const ul = $("cats"); ul.textContent = "";
  if (!total) { const li = document.createElement("li"); li.className = "none"; li.textContent = "No hay gastos en este periodo."; ul.append(li); return; }
  const max = Math.max(...Object.values(tot));
  const orden = CATS.filter(c => tot[c.id]).sort((a, b) => tot[b.id] - tot[a.id]);
  for (const c of orden) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "cat"; b.style.setProperty("--c", catColor(c.id));
    b.setAttribute("aria-pressed", catFiltro === c.id);
    const p = Math.round(tot[c.id] / total * 100);
    b.title = `${c.name}: ${fmt(tot[c.id])} (${p}% de los gastos)`;
    b.innerHTML = `<span class="cat-name"><i></i><span></span></span><span class="cat-val num"></span><span class="cat-bar"><span></span></span>`;
    b.querySelector(".cat-name span").textContent = c.name;
    b.querySelector(".cat-val").innerHTML = `${fmt(tot[c.id])}<small>${p}%</small>`;
    b.querySelector(".cat-bar span").style.width = Math.max(2, tot[c.id] / max * 100) + "%";
    b.onclick = () => {
      catFiltro = catFiltro === c.id ? null : c.id;
      if (catFiltro && tab === "ingreso") { tab = "gasto"; store.set("tab", tab); }
      render();
      if (catFiltro) document.querySelector(".tabs").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    li.append(b); ul.append(li);
  }
}

function renderActivos() {
  const box = $("active"); box.textContent = "";
  if (catFiltro) {
    const b = document.createElement("button"); b.type = "button";
    b.style.setProperty("--c", catColor(catFiltro));
    b.innerHTML = `<i></i><span></span><svg><use href="#i-close"/></svg>`;
    b.querySelector("span").textContent = CAT[catFiltro].name;
    b.setAttribute("aria-label", `Quitar filtro ${CAT[catFiltro].name}`);
    b.onclick = () => { catFiltro = null; render(); };
    box.append(b);
  }
  if (busqueda) {
    const b = document.createElement("button"); b.type = "button";
    b.innerHTML = `<span></span><svg><use href="#i-close"/></svg>`;
    b.querySelector("span").textContent = `“${$("q").value.trim()}”`;
    b.setAttribute("aria-label", "Quitar búsqueda");
    b.onclick = () => { $("q").value = ""; busqueda = ""; render(); };
    box.append(b);
  }
  box.hidden = !box.children.length;
}

function renderList(list) {
  const box = $("list"); box.textContent = "";
  if (!list.length) {
    const p = document.createElement("p"); p.className = "empty";
    p.textContent = !loaded ? "Cargando movimientos…" :
      (catFiltro || busqueda || mes !== "todos") ? "No hay movimientos con estos filtros." :
      tab === "gasto" ? "Todavía no hay gastos. Toca Agregar para registrar uno." :
      tab === "ingreso" ? "Todavía no hay ingresos. Toca Agregar para registrar uno." :
      "Todavía no hay movimientos.";
    box.append(p); return;
  }
  list.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.creado || 0) - (a.creado || 0));

  const groups = new Map();
  for (const r of list) {
    const k = r.fecha ? r.fecha.slice(0, 7) : "sin";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => a === "sin" ? 1 : b === "sin" ? -1 : b.localeCompare(a));

  for (const k of keys) {
    const items = groups.get(k);
    const sec = document.createElement("section"); sec.className = "month";
    const h = document.createElement("h3");
    const name = document.createElement("span");
    name.textContent = k === "sin" ? "Sin fecha" : nombreMes(k);
    const tot = document.createElement("span"); tot.className = "num";
    const total = items.reduce((s, r) => s + (r.tipo === "gasto" ? -r.monto : r.monto), 0);
    tot.textContent = tab === "todo" ? (total < 0 ? "− " : "+ ") + fmt(Math.abs(total)) : fmt(Math.abs(total));
    h.append(name, tot);
    const ul = document.createElement("ul");
    for (const r of items) ul.append(row(r));
    sec.append(h, ul); box.append(sec);
  }
}

function row(r) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = `item ${r.tipo}${r.efectivo ? " cash" : ""}`;
  b.setAttribute("aria-label", `Editar ${r.descripcion || "movimiento"}`);

  const ico = document.createElement("span"); ico.className = "ico";
  ico.innerHTML = `<svg><use href="#${r.efectivo ? "i-cash" : r.tipo === "gasto" ? "i-out" : "i-in"}"/></svg>`;

  const txt = document.createElement("span"); txt.className = "txt";
  const t = document.createElement("b"); t.textContent = r.descripcion || "Sin descripción";
  const s = document.createElement("small");
  const fecha = r.fecha ? `${+r.fecha.slice(8)} ${MES_CORTO[+r.fecha.slice(5, 7) - 1]}` : "Sin fecha";
  if (r.tipo === "gasto") {
    const c = catOf(r);
    const dot = document.createElement("span"); dot.className = "cat-dot"; dot.style.setProperty("--c", catColor(c));
    s.append(fecha + " · ", dot, CAT[c].name);
  } else {
    s.append(fecha + (r.quien ? ` · ${r.quien}` : ""));
  }
  if (r.efectivo) { const p = document.createElement("span"); p.className = "pill"; p.textContent = "Efectivo"; s.append(p); }
  txt.append(t, s);

  const a = document.createElement("span"); a.className = "amt num";
  a.textContent = (r.tipo === "gasto" ? "− " : "+ ") + fmt(r.monto);

  b.append(ico, txt, a);
  b.onclick = () => openSheet(r);
  li.append(b);
  return li;
}

render();
