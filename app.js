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
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const fmtFecha = f => { if (!f) return "Sin fecha"; const [, m, d] = f.split("-"); return `${+d} ${MESES[+m - 1]}`; };
const parseMonto = s => +String(s).replace(/\D/g, "") || 0;

let tipo = "gasto", editId = null, rows = [], confirmId = null, unsub = null, loaded = false;

/* ---------- Sesión ---------- */
$("login").onclick = async () => {
  $("login-msg").textContent = ""; $("login-msg").className = "msg";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (e.code === "auth/popup-closed-by-user") return;
    $("login-msg").className = "msg err";
    $("login-msg").textContent = e.code === "auth/unauthorized-domain"
      ? "Esta dirección web no está autorizada en Firebase. Agrégala en Authentication > Configuración > Dominios autorizados."
      : "No se pudo entrar. Intenta de nuevo.";
  }
};
$("logout").onclick = () => signOut(auth);

function loginMsg(t, err) { $("login-msg").textContent = t; $("login-msg").className = "msg" + (err ? " err" : ""); }

$("pw-form").addEventListener("submit", async e => {
  e.preventDefault();
  loginMsg("");
  $("pw-submit").disabled = true;
  try { await signInWithEmailAndPassword(auth, $("pw-email").value.trim(), $("pw-pass").value); }
  catch (err) {
    loginMsg(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err.code)
      ? "El correo o la contraseña no coinciden. Si no recuerdas la contraseña, usa “Olvidé mi contraseña”."
      : err.code === "auth/too-many-requests"
        ? "Demasiados intentos. Espera unos minutos y vuelve a intentar."
        : "No se pudo entrar. Intenta de nuevo.", true);
  } finally { $("pw-submit").disabled = false; }
});

$("pw-reset").onclick = async () => {
  const email = $("pw-email").value.trim();
  if (!email) { loginMsg("Escribe tu correo arriba y vuelve a pulsar “Olvidé mi contraseña”.", true); $("pw-email").focus(); return; }
  try { await sendPasswordResetEmail(auth, email); } catch (_) {}
  loginMsg(`Si ${email} tiene acceso, le llegará un correo para crear una contraseña nueva. Revisa también la carpeta de correo no deseado.`);
};

onAuthStateChanged(auth, user => {
  if (unsub) { unsub(); unsub = null; }
  rows = []; loaded = false;
  $("login-view").hidden = !!user;
  $("app-view").hidden = !user;
  $("me").hidden = !user;
  if (!user) return;
  $("me-email").textContent = user.email;
  $("status").textContent = "Conectando…";
  render();
  unsub = onSnapshot(col, snap => {
    loaded = true;
    rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    $("status").textContent = snap.metadata.fromCache ? "Sin conexión: mostrando lo último guardado" : "Guardado y sincronizado";
    render();
  }, err => {
    if (err.code === "permission-denied") {
      $("app-view").hidden = true; $("login-view").hidden = false;
      $("login-msg").className = "msg err";
      $("login-msg").textContent = `La cuenta ${user.email} no tiene acceso. Entra con la cuenta de Laura o de Sebastián.`;
      signOut(auth);
    } else {
      $("status").textContent = "Se perdió la conexión. Recarga la página.";
    }
  });
});

/* ---------- Formulario ---------- */
function setTipo(t) {
  tipo = t;
  $("k-gasto").setAttribute("aria-pressed", t === "gasto");
  $("k-ingreso").setAttribute("aria-pressed", t === "ingreso");
  $("submit").textContent = editId ? "Guardar cambios" : (t === "gasto" ? "Agregar gasto" : "Agregar ingreso");
}
$("k-gasto").onclick = () => setTipo("gasto");
$("k-ingreso").onclick = () => setTipo("ingreso");

$("f-monto").addEventListener("input", e => {
  const n = parseMonto(e.target.value);
  e.target.value = n ? fmt(n) : "";
});
try { const q = localStorage.getItem("quien"); if (q) $("f-quien").value = q; } catch (_) {}
$("f-quien").onchange = e => { try { localStorage.setItem("quien", e.target.value); } catch (_) {} };

function resetForm() {
  editId = null;
  $("f-monto").value = ""; $("f-desc").value = ""; $("f-efectivo").checked = false;
  $("f-fecha").value = new Date().toLocaleDateString("en-CA");
  $("form-title").textContent = "Agregar movimiento";
  $("cancel").hidden = true;
  setTipo(tipo);
}
$("cancel").onclick = resetForm;

function msg(t, err) { const m = $("msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const monto = parseMonto($("f-monto").value);
  if (!monto) { msg("Escribe el valor del movimiento.", true); $("f-monto").focus(); return; }
  const data = {
    tipo, monto, fecha: $("f-fecha").value || "", descripcion: $("f-desc").value.trim(),
    efectivo: $("f-efectivo").checked, quien: $("f-quien").value,
  };
  $("submit").disabled = true;
  try {
    if (editId) {
      const old = rows.find(r => r.id === editId);
      await setDoc(doc(col, editId), { ...data, creado: old?.creado || Date.now() });
      msg("Cambios guardados.");
    } else {
      await addDoc(col, { ...data, creado: Date.now() });
      msg((tipo === "gasto" ? "Gasto de " : "Ingreso de ") + fmt(monto) + " agregado.");
    }
    resetForm();
  } catch (err) {
    msg(err.code === "permission-denied" ? "Tu cuenta no tiene permiso para guardar." : "No se pudo guardar. Revisa la conexión e intenta de nuevo.", true);
  } finally { $("submit").disabled = false; }
});

/* ---------- Importar datos iniciales ---------- */
$("import-file").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    if (!Array.isArray(list) || !list.length) throw new Error("vacío");
    const batch = writeBatch(db);
    for (const r of list) {
      const monto = parseMonto(r.monto);
      if (!monto || !["gasto", "ingreso"].includes(r.tipo)) continue;
      batch.set(doc(col), {
        tipo: r.tipo, monto, fecha: r.fecha || "", descripcion: String(r.descripcion || ""),
        efectivo: !!r.efectivo, quien: r.quien || "Laura", creado: +r.creado || Date.now(),
      });
    }
    await batch.commit();
    msg(`Se cargaron ${list.length} movimientos.`);
  } catch (_) {
    msg("No se pudo leer el archivo. Usa el archivo datos-iniciales.json del proyecto.", true);
  }
});

/* ---------- Pintar ---------- */
function render() {
  const g = rows.filter(r => r.tipo === "gasto"), i = rows.filter(r => r.tipo === "ingreso");
  const sum = (a, ef) => a.filter(r => !!r.efectivo === ef).reduce((s, r) => s + (+r.monto || 0), 0);
  const inB = sum(i, false), outB = sum(g, false), inC = sum(i, true), outC = sum(g, true);
  $("t-in").textContent = fmt(inB);
  $("t-out").textContent = fmt(outB);
  $("t-total").textContent = fmt(inB - outB);
  $("c-in").textContent = fmt(inC);
  $("c-out").textContent = fmt(outC);
  $("c-total").textContent = fmt(inC - outC);
  $("l-out").textContent = fmt(outB + outC);
  $("l-in").textContent = fmt(inB + inC);
  $("import-box").hidden = !(loaded && rows.length === 0);
  fill("list-out", g, loaded ? "Todavía no hay gastos." : "Cargando…");
  fill("list-in", i, loaded ? "Todavía no hay ingresos." : "Cargando…");
}

function fill(id, list, emptyText) {
  const ul = $(id); ul.textContent = "";
  if (!list.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = emptyText; ul.append(li); return; }
  list.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.creado || 0) - (a.creado || 0));
  for (const r of list) {
    const li = document.createElement("li");
    const d = document.createElement("span"); d.className = "date"; d.textContent = fmtFecha(r.fecha);
    const desc = document.createElement("div"); desc.className = "desc";
    const t = document.createElement("span"); t.textContent = r.descripcion || "Sin descripción"; desc.append(t);
    if (r.efectivo) { const p = document.createElement("span"); p.className = "pill"; p.textContent = "Efectivo"; desc.append(p); }
    if (r.quien) { const w = document.createElement("div"); w.className = "who"; w.textContent = "Registró: " + r.quien; desc.append(w); }
    const right = document.createElement("div");
    const a = document.createElement("div"); a.className = "amt num";
    a.textContent = (r.tipo === "gasto" ? "− " : "+ ") + fmt(r.monto); right.append(a);
    const tools = document.createElement("div"); tools.className = "tools";
    if (confirmId === r.id) {
      const yes = document.createElement("button"); yes.className = "danger"; yes.textContent = "Sí, borrar"; yes.onclick = () => borrar(r.id);
      const no = document.createElement("button"); no.textContent = "No"; no.onclick = () => { confirmId = null; render(); };
      tools.append(yes, no);
    } else {
      const ed = document.createElement("button"); ed.textContent = "Editar"; ed.onclick = () => editar(r);
      const del = document.createElement("button"); del.textContent = "Borrar"; del.onclick = () => { confirmId = r.id; render(); };
      tools.append(ed, del);
    }
    right.append(tools);
    li.append(d, desc, right); ul.append(li);
  }
}

function editar(r) {
  editId = r.id; tipo = r.tipo;
  $("f-monto").value = fmt(r.monto); $("f-fecha").value = r.fecha || ""; $("f-desc").value = r.descripcion || "";
  $("f-efectivo").checked = !!r.efectivo; if (r.quien) $("f-quien").value = r.quien;
  $("form-title").textContent = "Editar movimiento"; $("cancel").hidden = false;
  setTipo(r.tipo); $("form").scrollIntoView({ behavior: "smooth", block: "start" }); $("f-monto").focus();
}

async function borrar(id) {
  confirmId = null;
  try { await deleteDoc(doc(col, id)); msg("Movimiento borrado."); }
  catch (_) { msg("No se pudo borrar. Intenta de nuevo.", true); }
}

resetForm();
