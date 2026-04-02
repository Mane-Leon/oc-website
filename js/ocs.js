import { auth, db } from "./firebase.js";
import { getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  initSession,
  currentRole,
  currentUserProfile,
  formatIdentity,
  getUsersDirectory
} from "./session.js";
import { RUTAS, getEstadoIndex, getSiguientePaso, esEstadoFinal } from "./rutas.js";
import {
  collection,
  getDocs,
  doc as fsDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let USER_ROLE = null;
let roleActivoGlobal = "ventas";
let detalleOcId = null;
let ocsCache = [];
let usersDirectory = { byUid: new Map(), byEmail: new Map() };
const deepLinkParams = new URLSearchParams(window.location.search);
const ocVistaContexto = {
  onlyMine: false,
  estadoScope: ""
};
let deepLinkOpenOcId = String(
  deepLinkParams.get("open_oc") ?? deepLinkParams.get("oc") ?? deepLinkParams.get("open") ?? ""
).trim();

const ROLES_CREAR_OC = new Set(["ventas", "admin", "operativo", "operaciones"]);
const hiddenColumns = new Set();
const hiddenRowIds = new Set();
const filtros = {
  texto: "",
  estado: "",
  prioridad: "",
  notas: ""
};
let sortState = { key: "fecha", dir: "desc" };

const COLUMNS = [
  { key: "oc", label: "OC" },
  { key: "cliente", label: "Cliente" },
  { key: "estado", label: "Estado" },
  { key: "accion", label: "Accion" },
  { key: "prioridad", label: "Prioridad" },
  { key: "fecha", label: "Fecha" },
  { key: "vendedor", label: "Vendedor" },
  { key: "notas", label: "Notas" }
];

const OPCIONES_RUTA = [
  { value: "almacen", label: "Surte almacen local" },
  { value: "sucursal", label: "Pedido a otra sucursal" },
  { value: "alemania", label: "Pedido a Alemania" }
];

const btnCrear = document.getElementById("btn-crear");
const tbody = document.getElementById("tabla-ocs");
const thead = document.getElementById("tabla-ocs-head");
const detalleModal = document.getElementById("detalle-oc-modal");
const detalleBody = document.getElementById("detalle-oc-body");
const detalleCerrarBtn = document.getElementById("detalle-oc-cerrar-2");
const detalleEditarBtn = document.getElementById("detalle-oc-editar");
const detalleBorrarBtn = document.getElementById("detalle-oc-borrar");
const detalleOcultarBtn = document.getElementById("detalle-oc-ocultar");
const filtroTextoEl = document.getElementById("filtro-texto");
const filtroEstadoEl = document.getElementById("filtro-estado");
const filtroPrioridadEl = document.getElementById("filtro-prioridad");
const filtroNotasEl = document.getElementById("filtro-notas");
const btnLimpiarFiltros = document.getElementById("btn-limpiar-filtros");
const columnasToggleEl = document.getElementById("columnas-toggle");
const btnRestaurarFilas = document.getElementById("btn-restaurar-filas");
const filasOcultasCountEl = document.getElementById("filas-ocultas-count");
const contextoOcsMsgEl = document.getElementById("ocs-contexto-msg");

function esRoleOperativo(role) {
  return role === "operativo" || role === "operaciones";
}

function puedeCrearOC(role) {
  return ROLES_CREAR_OC.has(role);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function limpiarNombreVendedor(value) {
  return String(value ?? "")
    .replace(/\s*\([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\)\s*$/i, "")
    .trim();
}

function leerContextoDeepLink() {
  const scope = String(deepLinkParams.get("scope") ?? deepLinkParams.get("view") ?? "")
    .trim()
    .toLowerCase();
  const estadoScope = String(deepLinkParams.get("estado_scope") ?? "")
    .trim()
    .toLowerCase();

  ocVistaContexto.onlyMine = scope === "mine" || scope === "mis" || scope === "mias";
  ocVistaContexto.estadoScope = estadoScope === "open" || estadoScope === "closed" ? estadoScope : "";
}

function renderContextoDeepLink() {
  if (!contextoOcsMsgEl) return;

  const partes = [];
  if (ocVistaContexto.onlyMine) partes.push("mis OCs");
  if (ocVistaContexto.estadoScope === "open") partes.push("en curso");
  if (ocVistaContexto.estadoScope === "closed") partes.push("cerradas");

  if (!partes.length) {
    contextoOcsMsgEl.textContent = "";
    return;
  }

  contextoOcsMsgEl.textContent = `Vista desde dashboard: ${partes.join(" ")}.`;
}

function abrirDeepLinkOcSiExiste() {
  if (!deepLinkOpenOcId) return;
  const oc = ocsCache.find((item) => item.id === deepLinkOpenOcId);
  if (!oc) return;

  const vista = construirVistaOC(oc);
  abrirDetalleOC(vista.id, vista.oc, vista.estadoLabel);
  deepLinkOpenOcId = "";
}

function nombreDesdeEmail(email) {
  const safe = normalizeEmail(email);
  return safe ? safe.split("@")[0] : "";
}

function extraerCorreo(texto) {
  const match = String(texto ?? "")
    .trim()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  return match ? normalizeEmail(match[0]) : "";
}

function tieneNotas(data) {
  const notas = data?.notas;
  if (typeof notas === "string") return notas.trim().length > 0;
  if (Array.isArray(notas)) return notas.length > 0;
  return Boolean(notas);
}

function notasTexto(data) {
  const notas = data?.notas;
  if (typeof notas === "string") return notas.trim();
  if (Array.isArray(notas)) return notas.join("\n");
  if (notas === null || notas === undefined) return "";
  if (typeof notas === "object") return JSON.stringify(notas, null, 2);
  return String(notas);
}

function indicadorNotasHtml(data) {
  if (tieneNotas(data)) {
    return "<span class=\"nota-indicador nota-si\">SI</span>";
  }
  return "<span class=\"nota-indicador nota-no\">NO</span>";
}

function formatFecha(valor) {
  if (!valor) return "";
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return String(valor);
  return fecha.toLocaleString("es-MX");
}

function esOcDelPerfil(oc, profile) {
  if (!profile) return false;

  const uidPerfil = String(profile?.uid ?? "").trim();
  const emailPerfil = normalizeEmail(profile?.email);
  const nombrePerfil = normalizeText(profile?.name);

  const uidOc = String(oc?.vendedor_uid ?? "").trim();
  if (uidPerfil && uidOc && uidPerfil === uidOc) return true;

  const emailOc = normalizeEmail(
    oc?.vendedor_correo || oc?.vendedor_email || extraerCorreo(oc?.vendedor_nombre)
  );
  if (emailPerfil && emailOc && emailPerfil === emailOc) return true;

  const nombreOc = normalizeText(limpiarNombreVendedor(oc?.vendedor_nombre));
  if (nombrePerfil && nombreOc && nombrePerfil === nombreOc) return true;

  return false;
}

function vendorProfileFromOC(oc) {
  const uid = String(oc?.vendedor_uid ?? "").trim();
  if (uid && usersDirectory.byUid.has(uid)) {
    return usersDirectory.byUid.get(uid);
  }

  const correoDirecto = normalizeEmail(
    oc?.vendedor_correo || oc?.vendedor_email || extraerCorreo(oc?.vendedor_nombre)
  );

  if (correoDirecto && usersDirectory.byEmail.has(correoDirecto)) {
    return usersDirectory.byEmail.get(correoDirecto);
  }

  return null;
}

function resolveVendedorDisplay(oc) {
  const profile = vendorProfileFromOC(oc);
  if (profile) {
    return formatIdentity(profile);
  }

  const nombreRaw = String(oc?.vendedor_nombre ?? "").trim();
  const nombreSinCorreo = nombreRaw
    .replace(/\s*\([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\)\s*$/i, "")
    .trim();

  if (nombreSinCorreo && !nombreSinCorreo.includes("@")) {
    return nombreSinCorreo;
  }

  const correo = normalizeEmail(
    oc?.vendedor_correo || oc?.vendedor_email || extraerCorreo(nombreRaw)
  );
  const nombreCorreo = nombreDesdeEmail(correo);
  if (nombreCorreo) return nombreCorreo;

  if (nombreSinCorreo) return nombreSinCorreo;
  return "-";
}

function cerrarDetalleOC() {
  if (!detalleModal) return;
  detalleOcId = null;
  detalleModal.style.display = "none";
}

function abrirDetalleOC(ocId, data, estadoLabel) {
  if (!detalleModal || !detalleBody) return;
  detalleOcId = ocId;

  const notas = notasTexto(data);
  const contenidoNotas = notas ? escapeHtml(notas) : "Sin notas.";

  detalleBody.innerHTML = `
    <div class="detalle-grid">
      <p><strong>OC</strong></p><p>${escapeHtml(ocId)}</p>
      <p><strong>Cliente</strong></p><p>${escapeHtml(data.cliente || "-")}</p>
      <p><strong>Estado</strong></p><p>${escapeHtml(estadoLabel || "-")}</p>
      <p><strong>Ruta</strong></p><p>${escapeHtml(data.ruta || "Sin asignar")}</p>
      <p><strong>Prioridad</strong></p><p>${escapeHtml(data.prioridad || "-")}</p>
      <p><strong>Fecha</strong></p><p>${escapeHtml(formatFecha(data.fecha_oc) || "-")}</p>
      <p><strong>Vendedor</strong></p><p>${escapeHtml(resolveVendedorDisplay(data))}</p>
      <p><strong>Tiene notas</strong></p><p>${tieneNotas(data) ? "SI" : "NO"}</p>
      <p><strong>Notas</strong></p><div class="detalle-notas">${contenidoNotas}</div>
    </div>
  `;

  if (detalleBorrarBtn) {
    detalleBorrarBtn.style.display = roleActivoGlobal === "admin" ? "inline-block" : "none";
  }
  if (detalleEditarBtn) {
    detalleEditarBtn.style.display = roleActivoGlobal === "admin" ? "inline-block" : "none";
  }

  if (detalleOcultarBtn) {
    const yaOculta = hiddenRowIds.has(ocId);
    detalleOcultarBtn.disabled = yaOculta;
    detalleOcultarBtn.textContent = yaOculta ? "Fila oculta" : "Ocultar fila";
  }

  detalleModal.style.display = "flex";
}

function estadoContexto(oc) {
  const ruta = oc.ruta ?? null;
  const estado = oc.estado ?? "por_surtir";

  if (!ruta) {
    return {
      ruta,
      rutaValida: false,
      tieneRuta: false,
      estadoLabel: "Pendiente de asignar ruta",
      estadoIndex: 0,
      siguientePaso: null,
      rutaConfig: null
    };
  }

  const rutaConfig = RUTAS[ruta];
  if (!rutaConfig) {
    return {
      ruta,
      rutaValida: false,
      tieneRuta: true,
      estadoLabel: "Ruta invalida",
      estadoIndex: 0,
      siguientePaso: null,
      rutaConfig: null
    };
  }

  let estadoIndex = Number.isInteger(oc.estado_index)
    ? oc.estado_index
    : getEstadoIndex(ruta, estado);

  if (estadoIndex < 0 || estadoIndex >= rutaConfig.length) {
    estadoIndex = 0;
  }

  const estadoActual = rutaConfig[estadoIndex];
  const siguientePaso = getSiguientePaso(ruta, estadoIndex);

  return {
    ruta,
    rutaValida: true,
    tieneRuta: true,
    estadoLabel: estadoActual.label,
    estadoIndex,
    estadoActual,
    siguientePaso,
    rutaConfig
  };
}

function construirVistaOC(oc) {
  const estadoInfo = estadoContexto(oc);
  const vendedorDisplay = resolveVendedorDisplay(oc);
  return {
    id: oc.id,
    oc,
    estadoInfo,
    estadoLabel: estadoInfo.estadoLabel,
    hasNotes: tieneNotas(oc),
    vendedorDisplay
  };
}

function estaOcCerrada(vista) {
  const info = vista?.estadoInfo;
  if (info?.rutaValida && info?.ruta) {
    return esEstadoFinal(info.ruta, info.estadoIndex);
  }
  return String(vista?.oc?.estado ?? "").trim().toLowerCase() === "entregado";
}

function cumpleContextoDashboard(vista) {
  if (ocVistaContexto.onlyMine && !esOcDelPerfil(vista.oc, currentUserProfile)) {
    return false;
  }

  if (ocVistaContexto.estadoScope === "open" && estaOcCerrada(vista)) {
    return false;
  }

  if (ocVistaContexto.estadoScope === "closed" && !estaOcCerrada(vista)) {
    return false;
  }

  return true;
}

function poblarSelect(selectEl, options, placeholder) {
  if (!selectEl) return;
  const valorActual = selectEl.value;
  selectEl.innerHTML = "";

  const optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = placeholder;
  selectEl.appendChild(optDefault);

  options.forEach((value) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    selectEl.appendChild(opt);
  });

  if (options.includes(valorActual)) {
    selectEl.value = valorActual;
  }
}

function actualizarOpcionesFiltros() {
  const vistas = ocsCache
    .map(construirVistaOC)
    .filter(cumpleContextoDashboard);
  const estados = [...new Set(vistas.map((v) => v.estadoLabel).filter(Boolean))].sort();
  const prioridades = [...new Set(vistas.map((v) => v.oc.prioridad).filter(Boolean))].sort();

  poblarSelect(filtroEstadoEl, estados, "Todos");
  poblarSelect(filtroPrioridadEl, prioridades, "Todas");
}

function valorOrden(vista, key) {
  switch (key) {
    case "oc":
      return vista.id;
    case "cliente":
      return vista.oc.cliente ?? "";
    case "estado":
      return vista.estadoLabel;
    case "prioridad":
      return vista.oc.prioridad ?? "";
    case "fecha":
      return vista.oc.fecha_oc ? new Date(vista.oc.fecha_oc).getTime() : 0;
    case "vendedor":
      return vista.vendedorDisplay;
    case "notas":
      return vista.hasNotes ? 1 : 0;
    default:
      return "";
  }
}

function comparar(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

function cumpleFiltros(vista) {
  if (hiddenRowIds.has(vista.id)) return false;
  if (!cumpleContextoDashboard(vista)) return false;

  if (filtros.texto) {
    const texto = filtros.texto.toLowerCase();
    const bucket = [
      vista.id,
      vista.oc.cliente,
      vista.estadoLabel,
      vista.oc.prioridad,
      vista.vendedorDisplay,
      notasTexto(vista.oc)
    ].join(" ").toLowerCase();

    if (!bucket.includes(texto)) return false;
  }

  if (filtros.estado && vista.estadoLabel !== filtros.estado) return false;
  if (filtros.prioridad && (vista.oc.prioridad ?? "") !== filtros.prioridad) return false;
  if (filtros.notas === "si" && !vista.hasNotes) return false;
  if (filtros.notas === "no" && vista.hasNotes) return false;

  return true;
}

function vistasFiltradasYOrdenadas() {
  const filas = ocsCache
    .map(construirVistaOC)
    .filter(cumpleFiltros)
    .sort((a, b) => {
      const va = valorOrden(a, sortState.key);
      const vb = valorOrden(b, sortState.key);
      const base = comparar(va, vb);
      return sortState.dir === "asc" ? base : -base;
    });

  return filas;
}

function crearCelda(colKey, text = "") {
  const td = document.createElement("td");
  td.dataset.col = colKey;
  td.textContent = text;
  return td;
}

function configurarDrilldown(tr, vista) {
  tr.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, select, input, textarea, a, label")) return;
    abrirDetalleOC(vista.id, vista.oc, vista.estadoLabel);
  });
}

async function asignarRuta(ocId, rutaElegida) {
  await updateDoc(fsDoc(db, "ordenes_compra", ocId), {
    ruta: rutaElegida,
    estado: "por_surtir",
    estado_index: 0
  });
  await cargarOCs();
}

async function actualizarEstado(ocId, rutaConfig, nuevoIndex) {
  const nuevoPaso = rutaConfig[nuevoIndex];
  if (!nuevoPaso) return;

  await updateDoc(fsDoc(db, "ordenes_compra", ocId), {
    estado: nuevoPaso.key,
    estado_index: nuevoIndex
  });
  await cargarOCs();
}

async function avanzarEstado(vista) {
  const { estadoInfo } = vista;
  const { ruta, estadoIndex, siguientePaso } = estadoInfo;
  if (!siguientePaso) return;

  if (esEstadoFinal(ruta, estadoIndex + 1)) {
    const ok = confirm("Confirmas que la OC fue entregada y se cerrara?");
    if (!ok) return;
  }

  await updateDoc(fsDoc(db, "ordenes_compra", vista.id), {
    estado: siguientePaso.key,
    estado_index: estadoIndex + 1
  });
  await cargarOCs();
}

function crearCeldaAccion(vista) {
  const td = crearCelda("accion", "");
  const { estadoInfo } = vista;

  if (!estadoInfo.tieneRuta) {
    if (roleActivoGlobal === "admin" || esRoleOperativo(roleActivoGlobal)) {
      const selectRuta = document.createElement("select");
      OPCIONES_RUTA.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r.value;
        opt.textContent = r.label;
        selectRuta.appendChild(opt);
      });

      const btnAsignar = document.createElement("button");
      btnAsignar.textContent = "Asignar ruta";
      btnAsignar.addEventListener("click", async () => {
        await asignarRuta(vista.id, selectRuta.value);
      });

      td.appendChild(selectRuta);
      td.appendChild(btnAsignar);
    }

    return td;
  }

  if (!estadoInfo.rutaValida) return td;

  if (USER_ROLE === "admin_principal") {
    const select = document.createElement("select");
    estadoInfo.rutaConfig.forEach((paso, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      opt.textContent = paso.label;
      if (idx === estadoInfo.estadoIndex) opt.selected = true;
      select.appendChild(opt);
    });

    select.addEventListener("change", async () => {
      await actualizarEstado(vista.id, estadoInfo.rutaConfig, Number(select.value));
    });
    td.appendChild(select);
  }

  if (estadoInfo.siguientePaso && (roleActivoGlobal === "admin" || esRoleOperativo(roleActivoGlobal))) {
    const btnSiguiente = document.createElement("button");
    btnSiguiente.textContent = `SIGUIENTE: ${estadoInfo.siguientePaso.label}`;
    btnSiguiente.addEventListener("click", async () => {
      await avanzarEstado(vista);
    });
    td.appendChild(btnSiguiente);
  }

  return td;
}

function ocultasActivas() {
  const set = new Set(hiddenColumns);
  if (roleActivoGlobal === "ventas") {
    set.add("accion");
  }
  return set;
}

function aplicarVisibilidadColumnas() {
  const ocultas = ocultasActivas();
  document.querySelectorAll("[data-col]").forEach((cell) => {
    const key = cell.dataset.col;
    cell.style.display = ocultas.has(key) ? "none" : "";
  });
}

function renderColumnToggles() {
  if (!columnasToggleEl) return;
  columnasToggleEl.innerHTML = "";

  COLUMNS.forEach((col) => {
    const forcedHidden = roleActivoGlobal === "ventas" && col.key === "accion";
    const label = document.createElement("label");
    label.className = "toggle-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !hiddenColumns.has(col.key) && !forcedHidden;
    input.disabled = forcedHidden;
    input.addEventListener("change", () => {
      if (input.checked) {
        hiddenColumns.delete(col.key);
      } else {
        hiddenColumns.add(col.key);
      }
      aplicarVisibilidadColumnas();
    });

    const txt = document.createElement("span");
    txt.textContent = col.label;

    label.appendChild(input);
    label.appendChild(txt);
    columnasToggleEl.appendChild(label);
  });
}

function actualizarContadorFilasOcultas() {
  if (filasOcultasCountEl) {
    filasOcultasCountEl.textContent = `${hiddenRowIds.size} ocultas`;
  }

  if (btnRestaurarFilas) {
    btnRestaurarFilas.disabled = hiddenRowIds.size === 0;
  }
}

function renderIndicadoresOrden() {
  if (!thead) return;

  thead.querySelectorAll("th[data-sort]").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortState.key) {
      th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function renderTabla() {
  if (!tbody) return;
  tbody.innerHTML = "";

  const filas = vistasFiltradasYOrdenadas();

  filas.forEach((vista) => {
    const tr = document.createElement("tr");
    tr.dataset.ocId = vista.id;

    const tdOc = crearCelda("oc", vista.id);
    const tdCliente = crearCelda("cliente", vista.oc.cliente ?? "");
    const tdEstado = crearCelda("estado", vista.estadoLabel);
    const tdAccion = crearCeldaAccion(vista);
    const tdPrioridad = crearCelda("prioridad", vista.oc.prioridad ?? "");
    const tdFecha = crearCelda("fecha", formatFecha(vista.oc.fecha_oc));
    const tdVendedor = crearCelda("vendedor", vista.vendedorDisplay);
    const tdNotas = crearCelda("notas", "");
    tdNotas.innerHTML = indicadorNotasHtml(vista.oc);

    tr.appendChild(tdOc);
    tr.appendChild(tdCliente);
    tr.appendChild(tdEstado);
    tr.appendChild(tdAccion);
    tr.appendChild(tdPrioridad);
    tr.appendChild(tdFecha);
    tr.appendChild(tdVendedor);
    tr.appendChild(tdNotas);

    configurarDrilldown(tr, vista);
    tbody.appendChild(tr);
  });

  actualizarContadorFilasOcultas();
  renderIndicadoresOrden();
  aplicarVisibilidadColumnas();
}

async function cargarOCs() {
  const snapshot = await getDocs(collection(db, "ordenes_compra"));
  ocsCache = snapshot.docs.map((snap) => ({ id: snap.id, ...snap.data() }));
  const idsVigentes = new Set(ocsCache.map((oc) => oc.id));
  hiddenRowIds.forEach((id) => {
    if (!idsVigentes.has(id)) hiddenRowIds.delete(id);
  });
  actualizarOpcionesFiltros();
  renderTabla();
  abrirDeepLinkOcSiExiste();
}

async function cargarRoleUsuario() {
  const user = auth.currentUser;
  if (!user) return;

  const ref = fsDoc(db, "users", user.uid);
  const snap = await getDoc(ref);
  USER_ROLE = snap.exists() ? snap.data().role : "ventas";
}

function sincronizarFiltrosDesdeUI() {
  filtros.texto = (filtroTextoEl?.value ?? "").trim();
  filtros.estado = filtroEstadoEl?.value ?? "";
  filtros.prioridad = filtroPrioridadEl?.value ?? "";
  filtros.notas = filtroNotasEl?.value ?? "";
}

function configurarEventosTabla() {
  if (filtroTextoEl) {
    filtroTextoEl.addEventListener("input", () => {
      sincronizarFiltrosDesdeUI();
      renderTabla();
    });
  }

  [filtroEstadoEl, filtroPrioridadEl, filtroNotasEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      sincronizarFiltrosDesdeUI();
      renderTabla();
    });
  });

  if (btnLimpiarFiltros) {
    btnLimpiarFiltros.addEventListener("click", () => {
      if (filtroTextoEl) filtroTextoEl.value = "";
      if (filtroEstadoEl) filtroEstadoEl.value = "";
      if (filtroPrioridadEl) filtroPrioridadEl.value = "";
      if (filtroNotasEl) filtroNotasEl.value = "";
      sincronizarFiltrosDesdeUI();
      renderTabla();
    });
  }

  if (btnRestaurarFilas) {
    btnRestaurarFilas.addEventListener("click", () => {
      hiddenRowIds.clear();
      actualizarContadorFilasOcultas();
      renderTabla();
    });
  }

  if (thead) {
    thead.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (!key) return;

        if (sortState.key === key) {
          sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        } else {
          sortState = { key, dir: key === "fecha" ? "desc" : "asc" };
        }

        renderTabla();
      });
    });
  }
}

function configurarEventosModal() {
  if (detalleCerrarBtn) {
    detalleCerrarBtn.addEventListener("click", cerrarDetalleOC);
  }

  if (detalleModal) {
    detalleModal.addEventListener("click", (event) => {
      if (event.target === detalleModal) {
        cerrarDetalleOC();
      }
    });
  }

  if (detalleOcultarBtn) {
    detalleOcultarBtn.addEventListener("click", () => {
      if (!detalleOcId) return;
      hiddenRowIds.add(detalleOcId);
      cerrarDetalleOC();
      renderTabla();
    });
  }

  if (detalleEditarBtn) {
    detalleEditarBtn.addEventListener("click", () => {
      if (roleActivoGlobal !== "admin") return;
      if (!detalleOcId) return;
      window.navigateWithSession(`nueva-oc.html?edit=${encodeURIComponent(detalleOcId)}`);
    });
  }

  if (detalleBorrarBtn) {
    detalleBorrarBtn.addEventListener("click", async () => {
      if (roleActivoGlobal !== "admin") return;
      if (!detalleOcId) return;

      const ok = confirm("Seguro que deseas borrar esta OC?");
      if (!ok) return;

      try {
        await deleteDoc(fsDoc(db, "ordenes_compra", detalleOcId));
        cerrarDetalleOC();
        await cargarOCs();
      } catch (e) {
        console.error("Error al borrar OC:", e);
        alert("No se pudo borrar la OC.");
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cerrarDetalleOC();
    }
  });
}

function configurarAccionesTopbar() {
  const roleActivo = roleActivoGlobal;

  document.body.classList.toggle("role-ventas", roleActivo === "ventas");

  const estadoEl = document.getElementById("estado");
  if (estadoEl) {
    const identidad = currentUserProfile
      ? formatIdentity(currentUserProfile)
      : (nombreDesdeEmail(auth.currentUser?.email) || "Usuario");
    estadoEl.textContent = "Sesion: " + identidad;
  }

  const roleEl = document.getElementById("role");
  if (roleEl && roleActivo) {
    roleEl.textContent = "Role: " + roleActivo;
  }

  if (btnCrear) {
    btnCrear.style.display = puedeCrearOC(roleActivo) ? "inline-block" : "none";
    btnCrear.onclick = () => {
      if (!puedeCrearOC(roleActivo)) {
        alert("No tienes permisos para crear OCs.");
        return;
      }
      window.navigateWithSession("nueva-oc.html");
    };
  }
}

configurarEventosTabla();
configurarEventosModal();
leerContextoDeepLink();
renderContextoDeepLink();

initSession(async () => {
  await cargarRoleUsuario();
  USER_ROLE = currentRole || USER_ROLE || "ventas";
  roleActivoGlobal = USER_ROLE;

  try {
    usersDirectory = await getUsersDirectory();
  } catch (e) {
    console.error("No se pudo cargar directorio de usuarios:", e);
    usersDirectory = { byUid: new Map(), byEmail: new Map() };
  }

  configurarAccionesTopbar();
  renderColumnToggles();
  actualizarContadorFilasOcultas();
  await cargarOCs();
});
