import { auth, db } from "./firebase.js";
import {
  initSession,
  currentRole,
  currentUserProfile,
  formatIdentity,
  getUsersDirectory
} from "./session.js";
import {
  collection,
  deleteDoc,
  doc as fsDoc,
  getDocs,
  query,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let pendientesCache = [];
let sortState = { key: "fecha_entrada", dir: "desc" };
let detallePendienteId = null;
let activeUidAliases = new Set();
let activeEmailAliases = new Set();
let queryFailures = 0;
let adminPersonasByKey = new Map();
let ultimaCargaFallida = false;
let ultimoErrorCarga = "";
const deepLinkParams = new URLSearchParams(window.location.search);
let deepLinkAplicado = false;
let deepLinkAdminPersona = "";
let deepLinkOpenPendienteId = String(
  deepLinkParams.get("open_pendiente") ?? deepLinkParams.get("pendiente") ?? deepLinkParams.get("open") ?? ""
).trim();

const filtros = {
  texto: "",
  estado: "",
  urgencia: "",
  bandeja: "a-mi",
  adminPersona: ""
};

const urgenciaPeso = {
  alta: 3,
  media: 2,
  baja: 1
};

const msgEl = document.getElementById("pendientes-msg");
const btnCrear = document.getElementById("btn-crear-pendiente");
const tbody = document.getElementById("tabla-pendientes");
const thead = document.getElementById("tabla-pendientes-head");
const filtroTextoEl = document.getElementById("filtro-texto");
const filtroEstadoEl = document.getElementById("filtro-estado");
const filtroUrgenciaEl = document.getElementById("filtro-urgencia");
const bandejaEl = document.getElementById("gestion-bandeja");
const adminPersonaWrapEl = document.getElementById("gestion-admin-persona-wrap");
const adminPersonaEl = document.getElementById("gestion-admin-persona");
const gestionResumenEl = document.getElementById("gestion-resumen");
const btnLimpiarFiltros = document.getElementById("btn-limpiar-filtros");

const detalleModal = document.getElementById("detalle-pendiente-modal");
const detalleBody = document.getElementById("detalle-pendiente-body");
const detalleBtnCerrar = document.getElementById("detalle-pendiente-cerrar-modal");
const detalleBtnSolicitar = document.getElementById("detalle-pendiente-solicitar-cierre");
const detalleBtnAceptar = document.getElementById("detalle-pendiente-aceptar-cierre");
const detalleBtnRechazar = document.getElementById("detalle-pendiente-rechazar-cierre");
const detalleBtnEditar = document.getElementById("detalle-pendiente-editar");
const detalleBtnEliminar = document.getElementById("detalle-pendiente-eliminar");

function isAdminRole(role) {
  const safe = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return safe === "admin" || safe === "admin_principal" || safe === "adminprincipal";
}

function bandejaLabel(value) {
  switch (String(value || "a-mi")) {
    case "por-mi":
      return "Asignados por mi";
    case "todos":
      return "Todos";
    default:
      return "Asignados a mi";
  }
}

function bandejaActiva() {
  const selected = String(filtros.bandeja || "a-mi");
  if (!isAdminRole(currentRole) && selected === "todos") return "a-mi";
  if (selected !== "a-mi" && selected !== "por-mi" && selected !== "todos") return "a-mi";
  return selected;
}

function shouldShowAdminPersonaPicker() {
  return isAdminRole(currentRole) && bandejaActiva() === "todos";
}

function applyDeepLinkPendientesOnce() {
  if (deepLinkAplicado) return;
  deepLinkAplicado = true;

  const bandeja = String(deepLinkParams.get("bandeja") ?? "").trim();
  const estado = String(deepLinkParams.get("estado") ?? "").trim();
  const urgencia = String(deepLinkParams.get("urgencia") ?? "").trim();
  const texto = String(deepLinkParams.get("q") ?? "").trim();
  deepLinkAdminPersona = String(deepLinkParams.get("persona") ?? "").trim();

  if (bandejaEl && ["a-mi", "por-mi", "todos"].includes(bandeja)) {
    bandejaEl.value = bandeja;
  }

  if (filtroEstadoEl && ["activo", "cierre_solicitado", "cerrado"].includes(estado)) {
    filtroEstadoEl.value = estado;
  }

  if (filtroUrgenciaEl && ["alta", "media", "baja"].includes(urgencia)) {
    filtroUrgenciaEl.value = urgencia;
  }

  if (filtroTextoEl && texto) {
    filtroTextoEl.value = texto;
  }
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatFecha(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("es-MX");
}

function estadoLabel(estado) {
  switch (estado) {
    case "cierre_solicitado":
      return "Cierre solicitado";
    case "cerrado":
      return "Cerrado";
    default:
      return "Activo";
  }
}

function estadoClass(estado) {
  switch (estado) {
    case "cierre_solicitado":
      return "estado-cierre";
    case "cerrado":
      return "estado-cerrado";
    default:
      return "estado-activo";
  }
}

function urgenciaClass(urgencia) {
  switch (urgencia) {
    case "alta":
      return "urgencia-alta";
    case "baja":
      return "urgencia-baja";
    default:
      return "urgencia-media";
  }
}

function getResponsables(p) {
  if (Array.isArray(p?.responsables) && p.responsables.length) {
    return p.responsables
      .map((r) => String(r?.name || "").trim())
      .filter(Boolean);
  }

  if (Array.isArray(p?.responsable_nombres) && p.responsable_nombres.length) {
    return p.responsable_nombres
      .map((r) => String(r || "").trim())
      .filter(Boolean);
  }

  return [];
}

function buildPersonaLabel(names = [], emails = [], uids = []) {
  const name = names[0] || "";
  const email = emails[0] || "";
  const uid = uids[0] || "";

  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  if (uid) return `UID ${uid}`;
  return "Usuario";
}

function buildAdminPersonaCatalog(rows = [], usersDirectory = null) {
  const personas = [];
  const byUid = new Map();
  const byEmail = new Map();

  const upsertPersona = ({ uid = "", email = "", name = "" } = {}) => {
    const uidSafe = String(uid ?? "").trim();
    const emailSafe = normalizeEmail(email);
    const nameSafe = String(name ?? "").trim();
    if (!uidSafe && !emailSafe) return;

    let persona = null;
    if (uidSafe && byUid.has(uidSafe)) persona = byUid.get(uidSafe);
    if (!persona && emailSafe && byEmail.has(emailSafe)) persona = byEmail.get(emailSafe);

    if (!persona) {
      persona = {
        uids: new Set(),
        emails: new Set(),
        names: new Set()
      };
      personas.push(persona);
    }

    if (uidSafe) {
      persona.uids.add(uidSafe);
      byUid.set(uidSafe, persona);
    }
    if (emailSafe) {
      persona.emails.add(emailSafe);
      byEmail.set(emailSafe, persona);
    }
    if (nameSafe) persona.names.add(nameSafe);
  };

  if (usersDirectory?.byUid instanceof Map) {
    usersDirectory.byUid.forEach((profile) => {
      upsertPersona({
        uid: profile?.uid,
        email: profile?.email,
        name: profile?.name
      });
    });
  }

  rows.forEach((p) => {
    upsertPersona({
      uid: String(p?.asignado_por_uid ?? "").trim(),
      email: normalizeEmail(p?.asignado_por_correo),
      name: String(p?.asignado_por_nombre ?? "").trim()
    });

    const responsableUids = listNormalizedStrings(p?.responsable_uids, (v) => String(v ?? "").trim());
    const responsableCorreos = listNormalizedStrings(p?.responsable_correos, (v) => normalizeEmail(v));
    const responsableNombres = listNormalizedStrings(p?.responsable_nombres, (v) => String(v ?? "").trim());
    const participantesUids = listNormalizedStrings(p?.participantes_uids, (v) => String(v ?? "").trim());
    const participantesCorreos = listNormalizedStrings(p?.participantes_correos, (v) => normalizeEmail(v));

    const maxResponsables = Math.max(
      responsableUids.length,
      responsableCorreos.length,
      responsableNombres.length
    );
    for (let i = 0; i < maxResponsables; i += 1) {
      upsertPersona({
        uid: responsableUids[i],
        email: responsableCorreos[i],
        name: responsableNombres[i]
      });
    }

    participantesUids.forEach((uid) => upsertPersona({ uid }));
    participantesCorreos.forEach((email) => upsertPersona({ email }));

    if (Array.isArray(p?.responsables)) {
      p.responsables.forEach((r) => {
        upsertPersona({
          uid: String(r?.uid ?? "").trim(),
          email: normalizeEmail(r?.email),
          name: String(r?.name ?? "").trim()
        });
      });
    }
  });

  const items = personas
    .map((persona) => {
      const uids = [...persona.uids].filter(Boolean).sort();
      const emails = [...persona.emails].filter(Boolean).sort();
      const names = [...persona.names]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

      const key = uids.length ? `uid:${uids[0]}` : emails.length ? `email:${emails[0]}` : "";
      if (!key) return null;

      return {
        key,
        uids,
        emails,
        label: buildPersonaLabel(names, emails, uids)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, "es", { sensitivity: "base" }));

  return {
    items,
    byKey: new Map(items.map((item) => [item.key, item]))
  };
}

function renderAdminPersonaOptions(items = []) {
  if (!adminPersonaEl) return;

  const previousValue = filtros.adminPersona || adminPersonaEl.value || "";
  const requestedValue = deepLinkAdminPersona || previousValue;
  adminPersonaEl.innerHTML = "";

  const optionAll = document.createElement("option");
  optionAll.value = "";
  optionAll.textContent = "Todas las personas";
  adminPersonaEl.appendChild(optionAll);

  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = item.label;
    adminPersonaEl.appendChild(option);
  });

  adminPersonaEl.value = requestedValue && adminPersonasByKey.has(requestedValue) ? requestedValue : "";
  deepLinkAdminPersona = "";
}

function updateAdminPersonaVisibility() {
  const show = shouldShowAdminPersonaPicker();
  if (adminPersonaWrapEl) adminPersonaWrapEl.hidden = !show;
  if (adminPersonaEl) adminPersonaEl.disabled = !show;
}

async function refreshAdminPersonaCatalog() {
  adminPersonasByKey = new Map();

  if (!isAdminRole(currentRole)) {
    renderAdminPersonaOptions([]);
    filtros.adminPersona = "";
    updateAdminPersonaVisibility();
    return;
  }

  let usersDirectory = null;
  try {
    usersDirectory = await getUsersDirectory();
  } catch (e) {
    console.warn("No se pudo cargar directorio users para selector admin:", e);
  }

  const catalog = buildAdminPersonaCatalog(pendientesCache, usersDirectory);
  adminPersonasByKey = catalog.byKey;
  renderAdminPersonaOptions(catalog.items);
  updateAdminPersonaVisibility();
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getCurrentUidCandidates() {
  const set = new Set(activeUidAliases);
  const uid = String(currentUserProfile?.uid ?? "").trim();
  if (uid) set.add(uid);
  return set;
}

function getCurrentEmailCandidates() {
  const set = new Set(activeEmailAliases);
  const profileEmail = normalizeEmail(currentUserProfile?.email);
  const authEmail = normalizeEmail(auth.currentUser?.email);
  if (profileEmail) set.add(profileEmail);
  if (authEmail) set.add(authEmail);
  return set;
}

function buildParticipantesData(p, responsableUids = [], responsableCorreos = []) {
  const asignadoPorUid = String(p?.asignado_por_uid ?? "").trim();
  const asignadoPorCorreo = normalizeEmail(p?.asignado_por_correo);
  return {
    uids: [...new Set([asignadoPorUid, ...responsableUids].filter(Boolean))].sort(),
    correos: [...new Set([asignadoPorCorreo, ...responsableCorreos].filter(Boolean))].sort()
  };
}

function isAssigner(p) {
  const uidCandidates = getCurrentUidCandidates();
  const byUid = uidCandidates.has(String(p?.asignado_por_uid ?? "").trim());
  const emailCandidates = getCurrentEmailCandidates();
  const byEmail = emailCandidates.has(normalizeEmail(p?.asignado_por_correo));
  return Boolean(byUid || byEmail);
}

function isResponsible(p) {
  const uidCandidates = getCurrentUidCandidates();
  const emailCandidates = getCurrentEmailCandidates();

  const uids = Array.isArray(p?.responsable_uids)
    ? p.responsable_uids.map((v) => String(v || "").trim())
    : [];
  const participantesUids = Array.isArray(p?.participantes_uids)
    ? p.participantes_uids.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const correos = Array.isArray(p?.responsable_correos)
    ? p.responsable_correos.map((v) => normalizeEmail(v)).filter(Boolean)
    : [];
  const participantesCorreos = Array.isArray(p?.participantes_correos)
    ? p.participantes_correos.map((v) => normalizeEmail(v)).filter(Boolean)
    : [];
  const correosLegacy = Array.isArray(p?.responsables)
    ? p.responsables.map((r) => normalizeEmail(r?.email)).filter(Boolean)
    : [];

  const byUid =
    uids.some((uid) => uidCandidates.has(uid)) ||
    participantesUids.some((uid) => uidCandidates.has(uid));
  const byEmail =
    correos.some((correo) => emailCandidates.has(correo)) ||
    participantesCorreos.some((correo) => emailCandidates.has(correo)) ||
    correosLegacy.some((correo) => emailCandidates.has(correo));
  return Boolean(byUid || byEmail);
}

function buildVista(p) {
  const responsables = getResponsables(p);
  const estado = String(p?.estado ?? "activo");
  const urgencia = String(p?.urgencia ?? "media");
  const asignadoPor = String(p?.asignado_por_nombre || "Usuario").trim();
  const isAdmin = isAdminRole(currentRole);
  const asignadoPorUid = String(p?.asignado_por_uid ?? "").trim();
  const asignadoPorCorreo = normalizeEmail(p?.asignado_por_correo);
  const responsableUids = listNormalizedStrings(p?.responsable_uids, (v) => String(v ?? "").trim());
  const participantesUids = listNormalizedStrings(p?.participantes_uids, (v) => String(v ?? "").trim());
  const responsableCorreos = listNormalizedStrings(p?.responsable_correos, (v) => normalizeEmail(v));
  const participantesCorreos = listNormalizedStrings(p?.participantes_correos, (v) => normalizeEmail(v));
  const legacyCorreos = Array.isArray(p?.responsables)
    ? p.responsables.map((r) => normalizeEmail(r?.email)).filter(Boolean)
    : [];
  const relationUids = [...new Set([asignadoPorUid, ...responsableUids, ...participantesUids].filter(Boolean))];
  const relationCorreos = [
    ...new Set([asignadoPorCorreo, ...responsableCorreos, ...participantesCorreos, ...legacyCorreos].filter(Boolean))
  ];

  return {
    id: p.id,
    pendiente: p,
    estado,
    urgencia,
    asunto: String(p?.asunto ?? "").trim(),
    notas: String(p?.notas ?? "").trim(),
    fechaEntrada: p?.fecha_entrada || null,
    fechaPropuesta: p?.fecha_resolucion_propuesta || null,
    asignadoPor,
    asignadoPorUid,
    asignadoPorCorreo,
    responsables,
    responsablesText: responsables.length ? responsables.join(", ") : "-",
    relationUids,
    relationCorreos,
    isAdmin,
    isAssigner: isAssigner(p),
    isResponsible: isResponsible(p)
  };
}

function getSortValue(vista, key) {
  switch (key) {
    case "id":
      return vista.id;
    case "asunto":
      return vista.asunto;
    case "estado":
      return estadoLabel(vista.estado);
    case "urgencia":
      return urgenciaPeso[vista.urgencia] || 0;
    case "fecha_entrada":
      return vista.fechaEntrada ? new Date(vista.fechaEntrada).getTime() : 0;
    case "fecha_resolucion_propuesta":
      return vista.fechaPropuesta ? new Date(vista.fechaPropuesta).getTime() : 0;
    case "asignado_por":
      return vista.asignadoPor;
    case "responsables":
      return vista.responsablesText;
    default:
      return "";
  }
}

function comparar(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

function cumpleBandeja(vista) {
  const bandeja = bandejaActiva();
  if (bandeja === "por-mi") return vista.isAssigner;
  if (bandeja === "todos") return isAdminRole(currentRole);
  return vista.isResponsible;
}

function cumpleAdminPersona(vista) {
  if (!shouldShowAdminPersonaPicker()) return true;
  if (!filtros.adminPersona) return true;

  const persona = adminPersonasByKey.get(filtros.adminPersona);
  if (!persona) return true;

  const hitByUid = persona.uids.some((uid) => vista.relationUids.includes(uid));
  const hitByEmail = persona.emails.some((email) => vista.relationCorreos.includes(email));
  return hitByUid || hitByEmail;
}

function cumpleFiltros(vista) {
  if (!cumpleBandeja(vista)) return false;
  if (!cumpleAdminPersona(vista)) return false;
  if (filtros.estado && vista.estado !== filtros.estado) return false;
  if (filtros.urgencia && vista.urgencia !== filtros.urgencia) return false;

  if (filtros.texto) {
    const texto = filtros.texto.toLowerCase();
    const bucket = [
      vista.id,
      vista.asunto,
      vista.notas,
      vista.asignadoPor,
      vista.responsablesText,
      estadoLabel(vista.estado),
      vista.urgencia
    ].join(" ").toLowerCase();

    if (!bucket.includes(texto)) return false;
  }

  return true;
}

function vistasFiltradasYOrdenadas() {
  return pendientesCache
    .map(buildVista)
    .filter(cumpleFiltros)
    .sort((a, b) => {
      const va = getSortValue(a, sortState.key);
      const vb = getSortValue(b, sortState.key);
      const base = comparar(va, vb);
      return sortState.dir === "asc" ? base : -base;
    });
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

function renderGestionResumen(vistas) {
  if (!gestionResumenEl) return;
  gestionResumenEl.innerHTML = "";

  const bandeja = bandejaActiva();
  const estadoCounts = { activo: 0, cierre_solicitado: 0, cerrado: 0 };
  vistas.forEach((vista) => {
    if (estadoCounts[vista.estado] !== undefined) {
      estadoCounts[vista.estado] += 1;
    }
  });

  const chips = [
    `Bandeja: ${bandejaLabel(bandeja)}`,
    `Mostrando: ${vistas.length}`,
    `Activo: ${estadoCounts.activo}`,
    `Cierre solicitado: ${estadoCounts.cierre_solicitado}`,
    `Cerrado: ${estadoCounts.cerrado}`
  ];

  if (shouldShowAdminPersonaPicker() && filtros.adminPersona) {
    const persona = adminPersonasByKey.get(filtros.adminPersona);
    if (persona?.label) chips.push(`Persona: ${persona.label}`);
  }

  chips.forEach((text) => {
    const chip = document.createElement("span");
    chip.className = "estado-chip";
    chip.textContent = text;
    gestionResumenEl.appendChild(chip);
  });
}

function hayFiltrosDeBusquedaActivos() {
  return Boolean(filtros.texto || filtros.estado || filtros.urgencia);
}

function getNoRowsMessage() {
  if (hayFiltrosDeBusquedaActivos()) {
    return "No hay pendientes que coincidan con los filtros.";
  }

  const bandeja = bandejaActiva();
  if (bandeja === "por-mi") return "No has asignado pendientes.";
  if (bandeja === "a-mi") return "No tienes pendientes asignados.";

  if (shouldShowAdminPersonaPicker() && filtros.adminPersona) {
    return "No hay pendientes para la persona seleccionada.";
  }
  return "No hay pendientes para mostrar.";
}

function renderMensaje(vistas) {
  if (!msgEl) return;

  if (ultimaCargaFallida) {
    msgEl.textContent = ultimoErrorCarga || "No se pudo cargar pendientes.";
    return;
  }

  if (!pendientesCache.length) {
    if (!isAdminRole(currentRole) && queryFailures > 0) {
      msgEl.textContent = "No se pudieron leer algunos pendientes por permisos/reglas.";
      return;
    }
    msgEl.textContent = isAdminRole(currentRole)
      ? "No hay pendientes registrados."
      : "No tienes pendientes asignados ni creados.";
    return;
  }

  const bandeja = bandejaActiva();
  let text = `Mostrando ${vistas.length} pendientes en ${bandejaLabel(bandeja).toLowerCase()}.`;
  if (!isAdminRole(currentRole) && queryFailures > 0) {
    text += " Algunas consultas fueron bloqueadas por permisos/reglas.";
  }
  msgEl.textContent = text;
}

function openDetalle(vista) {
  if (!detalleModal || !detalleBody) return;
  detallePendienteId = vista.id;

  const p = vista.pendiente;
  const notas = vista.notas || "Sin notas.";
  const solicitaNombre = String(p?.cierre_solicitado_por_nombre || "").trim();

  detalleBody.innerHTML = `
    <div class="detalle-grid">
      <p><strong>ID</strong></p><p>${escapeHtml(vista.id)}</p>
      <p><strong>Asunto</strong></p><p>${escapeHtml(vista.asunto || "-")}</p>
      <p><strong>Estado</strong></p><p>${escapeHtml(estadoLabel(vista.estado))}</p>
      <p><strong>Urgencia</strong></p><p>${escapeHtml(vista.urgencia || "-")}</p>
      <p><strong>Entrada</strong></p><p>${escapeHtml(formatFecha(vista.fechaEntrada))}</p>
      <p><strong>Resolucion propuesta</strong></p><p>${escapeHtml(formatFecha(vista.fechaPropuesta))}</p>
      <p><strong>Asignado por</strong></p><p>${escapeHtml(vista.asignadoPor)}</p>
      <p><strong>Responsables</strong></p><p>${escapeHtml(vista.responsablesText)}</p>
      <p><strong>Solicitud de cierre</strong></p><p>${escapeHtml(solicitaNombre || "-")}</p>
      <p><strong>Notas</strong></p><div class="detalle-notas">${escapeHtml(notas)}</div>
    </div>
  `;

  const canEdit = vista.isAdmin || vista.isAssigner;
  const canDelete = vista.isAdmin || vista.isAssigner;
  const canSolicitar = vista.isResponsible && vista.estado === "activo";
  const canAceptarRechazar = vista.isAssigner && vista.estado === "cierre_solicitado";

  if (detalleBtnEditar) detalleBtnEditar.style.display = canEdit ? "inline-block" : "none";
  if (detalleBtnEliminar) detalleBtnEliminar.style.display = canDelete ? "inline-block" : "none";
  if (detalleBtnSolicitar) detalleBtnSolicitar.style.display = canSolicitar ? "inline-block" : "none";
  if (detalleBtnAceptar) detalleBtnAceptar.style.display = canAceptarRechazar ? "inline-block" : "none";
  if (detalleBtnRechazar) detalleBtnRechazar.style.display = canAceptarRechazar ? "inline-block" : "none";

  detalleModal.style.display = "flex";
}

function closeDetalle() {
  if (!detalleModal) return;
  detallePendienteId = null;
  detalleModal.style.display = "none";
}

async function solicitarCierre(vista) {
  if (!vista?.isResponsible || vista.estado !== "activo") return;
  const ok = confirm("Solicitar cierre de este pendiente?");
  if (!ok) return;

  const profile = currentUserProfile || {};
  await updateDoc(fsDoc(db, "pendientes", vista.id), {
    estado: "cierre_solicitado",
    cierre_solicitado_por_uid: String(profile.uid || "").trim(),
    cierre_solicitado_por_nombre: String(profile.name || "Usuario").trim(),
    cierre_solicitado_por_correo: normalizeEmail(profile.email),
    cierre_solicitado_en: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

async function aceptarCierre(vista) {
  if (!vista?.isAssigner || vista.estado !== "cierre_solicitado") return;
  const ok = confirm("Aceptar cierre de este pendiente?");
  if (!ok) return;

  const profile = currentUserProfile || {};
  await updateDoc(fsDoc(db, "pendientes", vista.id), {
    estado: "cerrado",
    cerrado_por_uid: String(profile.uid || "").trim(),
    cerrado_por_nombre: String(profile.name || "Usuario").trim(),
    cerrado_por_correo: normalizeEmail(profile.email),
    cerrado_en: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

async function rechazarCierre(vista) {
  if (!vista?.isAssigner || vista.estado !== "cierre_solicitado") return;
  const ok = confirm("Rechazar cierre y regresar a activo?");
  if (!ok) return;

  const profile = currentUserProfile || {};
  await updateDoc(fsDoc(db, "pendientes", vista.id), {
    estado: "activo",
    cierre_rechazado_por_uid: String(profile.uid || "").trim(),
    cierre_rechazado_por_nombre: String(profile.name || "Usuario").trim(),
    cierre_rechazado_en: new Date().toISOString(),
    cierre_solicitado_por_uid: "",
    cierre_solicitado_por_nombre: "",
    cierre_solicitado_por_correo: "",
    cierre_solicitado_en: null,
    updated_at: new Date().toISOString()
  });
}

async function eliminarPendiente(vista) {
  if (!(vista?.isAdmin || vista?.isAssigner)) return;
  const ok = confirm(`Eliminar pendiente ${vista.id}? Esta accion no se puede deshacer.`);
  if (!ok) return;
  await deleteDoc(fsDoc(db, "pendientes", vista.id));
}

function crearCeldaTexto(texto) {
  const td = document.createElement("td");
  td.textContent = texto;
  return td;
}

function crearCeldaBadge(texto, className) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = className;
  span.textContent = texto;
  td.appendChild(span);
  return td;
}

function renderTabla() {
  if (!tbody) return;
  tbody.innerHTML = "";

  const vistas = vistasFiltradasYOrdenadas();
  renderGestionResumen(vistas);
  renderMensaje(vistas);

  if (!vistas.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.textContent = getNoRowsMessage();
    tr.appendChild(td);
    tbody.appendChild(tr);
    renderIndicadoresOrden();
    return;
  }

  vistas.forEach((vista) => {
    const tr = document.createElement("tr");
    tr.dataset.pendienteId = vista.id;

    tr.appendChild(crearCeldaTexto(vista.id));
    tr.appendChild(crearCeldaTexto(vista.asunto || "-"));
    tr.appendChild(crearCeldaBadge(estadoLabel(vista.estado), `badge ${estadoClass(vista.estado)}`));
    tr.appendChild(crearCeldaBadge(vista.urgencia || "-", `badge ${urgenciaClass(vista.urgencia)}`));
    tr.appendChild(crearCeldaTexto(formatFecha(vista.fechaEntrada)));
    tr.appendChild(crearCeldaTexto(formatFecha(vista.fechaPropuesta)));
    tr.appendChild(crearCeldaTexto(vista.asignadoPor || "-"));
    tr.appendChild(crearCeldaTexto(vista.responsablesText));

    tr.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) return;
      openDetalle(vista);
    });

    tbody.appendChild(tr);
  });

  renderIndicadoresOrden();
}

function abrirDeepLinkPendienteSiExiste() {
  if (!deepLinkOpenPendienteId) return;
  const pendiente = pendientesCache.find((row) => row.id === deepLinkOpenPendienteId);
  if (!pendiente) return;

  const vista = buildVista(pendiente);
  openDetalle(vista);
  deepLinkOpenPendienteId = "";
}

async function safeGetDocs(q, label = "") {
  try {
    return await getDocs(q);
  } catch (e) {
    queryFailures += 1;
    console.warn(`Consulta de pendientes bloqueada o fallida${label ? ` (${label})` : ""}:`, e);
    return null;
  }
}

function listNormalizedStrings(value, normalizer = (v) => String(v ?? "").trim()) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => normalizer(v))
    .filter(Boolean);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== b.length) return false;
  for (const item of b) {
    if (!setA.has(item)) return false;
  }
  return true;
}

async function getUidAliases(profile) {
  const authUid = String(auth.currentUser?.uid ?? "").trim();
  const aliases = new Set();
  if (authUid) aliases.add(authUid);

  return [...aliases];
}

function getEmailAliases(profile) {
  const aliases = new Set();
  const authEmail = normalizeEmail(auth.currentUser?.email);
  const profileEmail = normalizeEmail(profile?.email);
  if (authEmail) aliases.add(authEmail);
  if (profileEmail) aliases.add(profileEmail);
  return [...aliases];
}

async function reconciliarPendientesLegacySiAdmin(rows) {
  if (!isAdminRole(currentRole) || !rows.length) return 0;

  let usersSnap;
  try {
    usersSnap = await getDocs(collection(db, "users"));
  } catch (e) {
    console.warn("No se pudo cargar directorio para reconciliar pendientes:", e);
    return 0;
  }

  const byUidAlias = new Map();
  const byEmail = new Map();
  const nameIndex = new Map();

  const ensureProfile = (docSnap) => {
    const data = docSnap.data() ?? {};
    const docId = String(docSnap.id ?? "").trim();
    const uidAliases = docId ? [docId] : [];
    const email = normalizeEmail(data?.email ?? data?.correo);
    const name = String(data?.nombre ?? data?.name ?? data?.displayName ?? "").trim() || "Usuario";
    return { uidAliases, email, name };
  };

  const addProfileIndexes = (profile) => {
    profile.uidAliases.forEach((alias) => byUidAlias.set(alias, profile));

    if (profile.email) {
      const bucketEmail = byEmail.get(profile.email) || [];
      bucketEmail.push(profile);
      byEmail.set(profile.email, bucketEmail);
    }

    const key = normalizeName(profile.name);
    if (!key) return;
    const bucketName = nameIndex.get(key) || [];
    bucketName.push(profile);
    nameIndex.set(key, bucketName);
  };

  usersSnap.forEach((docSnap) => {
    addProfileIndexes(ensureProfile(docSnap));
  });

  let updatedCount = 0;

  for (const p of rows) {
    const currentUids = listNormalizedStrings(p?.responsable_uids, (v) => String(v ?? "").trim());
    const currentCorreos = listNormalizedStrings(p?.responsable_correos, (v) => normalizeEmail(v));
    const currentNombres = listNormalizedStrings(p?.responsable_nombres, (v) => String(v ?? "").trim());
    const currentParticipantesUids = listNormalizedStrings(p?.participantes_uids, (v) => String(v ?? "").trim());
    const currentParticipantesCorreos = listNormalizedStrings(
      p?.participantes_correos,
      (v) => normalizeEmail(v)
    );

    const uidSet = new Set(currentUids);
    const correoSet = new Set(currentCorreos);
    const nombreSet = new Set(currentNombres);

    if (Array.isArray(p?.responsables)) {
      p.responsables.forEach((r) => {
        const uid = String(r?.uid ?? "").trim();
        const correo = normalizeEmail(r?.email);
        const nombre = String(r?.name ?? "").trim();
        if (uid) uidSet.add(uid);
        if (correo) correoSet.add(correo);
        if (nombre) nombreSet.add(nombre);
      });
    }

    [...correoSet].forEach((correo) => {
      const profiles = byEmail.get(correo) || [];
      profiles.forEach((profile) => {
        profile.uidAliases.forEach((alias) => uidSet.add(alias));
        if (profile.email) correoSet.add(profile.email);
        if (profile.name) nombreSet.add(profile.name);
      });
    });

    [...uidSet].forEach((uid) => {
      const profile = byUidAlias.get(uid);
      if (!profile) return;
      profile.uidAliases.forEach((alias) => uidSet.add(alias));
      if (profile.email) correoSet.add(profile.email);
      if (profile.name) nombreSet.add(profile.name);
    });

    [...nombreSet].forEach((name) => {
      const key = normalizeName(name);
      if (!key) return;
      const matches = nameIndex.get(key) || [];
      if (matches.length !== 1) return;
      const profile = matches[0];
      profile.uidAliases.forEach((alias) => uidSet.add(alias));
      if (profile.email) correoSet.add(profile.email);
    });

    const nextUids = [...uidSet].filter(Boolean).sort();
    const nextCorreos = [...correoSet].filter(Boolean).sort();
    const nextNombres = [...nombreSet].filter(Boolean).sort((a, b) =>
      a.localeCompare(b, "es", { sensitivity: "base" })
    );
    const nextParticipantes = buildParticipantesData(p, nextUids, nextCorreos);

    const changed =
      !sameSet(currentUids, nextUids) ||
      !sameSet(currentCorreos, nextCorreos) ||
      !sameSet(currentNombres, nextNombres) ||
      !sameSet(currentParticipantesUids, nextParticipantes.uids) ||
      !sameSet(currentParticipantesCorreos, nextParticipantes.correos);

    if (!changed) continue;

    try {
      await updateDoc(fsDoc(db, "pendientes", p.id), {
        responsable_uids: nextUids,
        responsable_correos: nextCorreos,
        responsable_nombres: nextNombres,
        participantes_uids: nextParticipantes.uids,
        participantes_correos: nextParticipantes.correos,
        updated_at: new Date().toISOString()
      });
      updatedCount += 1;
    } catch (e) {
      console.warn("No se pudo reconciliar pendiente", p.id, e);
    }
  }

  return updatedCount;
}

async function cargarPendientes() {
  if (!currentUserProfile) return;
  if (msgEl) msgEl.textContent = "Cargando pendientes...";
  ultimaCargaFallida = false;
  ultimoErrorCarga = "";
  queryFailures = 0;

  activeUidAliases = new Set([String(currentUserProfile?.uid ?? "").trim()].filter(Boolean));
  activeEmailAliases = new Set(
    [normalizeEmail(currentUserProfile?.email), normalizeEmail(auth.currentUser?.email)].filter(Boolean)
  );

  if (isAdminRole(currentRole)) {
    try {
      const snap = await getDocs(collection(db, "pendientes"));
      pendientesCache = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

      const reparados = await reconciliarPendientesLegacySiAdmin(pendientesCache);
      if (reparados > 0) {
        const snapRefrescado = await getDocs(collection(db, "pendientes"));
        pendientesCache = snapRefrescado.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      }

      await refreshAdminPersonaCatalog();
      syncFiltros();
      renderTabla();
      abrirDeepLinkPendienteSiExiste();
      if (msgEl && reparados > 0 && pendientesCache.length) {
        msgEl.textContent += ` Se reconciliaron ${reparados} pendientes legacy.`;
      }
      return;
    } catch (e) {
      console.error("No se pudo cargar pendientes para admin:", e);
      ultimaCargaFallida = true;
      ultimoErrorCarga = "No se pudo cargar pendientes.";
      pendientesCache = [];
      await refreshAdminPersonaCatalog();
      syncFiltros();
      renderTabla();
      abrirDeepLinkPendienteSiExiste();
      return;
    }
  }

  try {
    const uidAliases = await getUidAliases(currentUserProfile);
    const emailAliases = getEmailAliases(currentUserProfile);
    uidAliases.forEach((uid) => activeUidAliases.add(uid));
    emailAliases.forEach((email) => activeEmailAliases.add(email));
    const pendientesMap = new Map();

    const consultas = [];
    uidAliases.forEach((uid) => {
      consultas.push(
        safeGetDocs(
          query(collection(db, "pendientes"), where("responsable_uids", "array-contains", uid)),
          `responsable_uids array-contains ${uid}`
        ),
        safeGetDocs(
          query(collection(db, "pendientes"), where("participantes_uids", "array-contains", uid)),
          `participantes_uids array-contains ${uid}`
        ),
        safeGetDocs(
          query(collection(db, "pendientes"), where("asignado_por_uid", "==", uid)),
          `asignado_por_uid == ${uid}`
        )
      );
    });
    emailAliases.forEach((email) => {
      consultas.push(
        safeGetDocs(
          query(collection(db, "pendientes"), where("responsable_correos", "array-contains", email)),
          `responsable_correos array-contains ${email}`
        ),
        safeGetDocs(
          query(collection(db, "pendientes"), where("participantes_correos", "array-contains", email)),
          `participantes_correos array-contains ${email}`
        ),
        safeGetDocs(
          query(collection(db, "pendientes"), where("asignado_por_correo", "==", email)),
          `asignado_por_correo == ${email}`
        )
      );
    });

    const snaps = await Promise.all(consultas);
    snaps.filter(Boolean).forEach((snap) => {
      snap.forEach((docSnap) => {
        pendientesMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
      });
    });

    pendientesCache = [...pendientesMap.values()];
  } catch (e) {
    console.error("No se pudo cargar pendientes relacionados al usuario:", e);
    ultimaCargaFallida = true;
    ultimoErrorCarga = "No se pudo cargar pendientes.";
    pendientesCache = [];
  }

  await refreshAdminPersonaCatalog();
  syncFiltros();
  renderTabla();
  abrirDeepLinkPendienteSiExiste();
}

function syncFiltros() {
  filtros.texto = (filtroTextoEl?.value ?? "").trim();
  filtros.estado = filtroEstadoEl?.value ?? "";
  filtros.urgencia = filtroUrgenciaEl?.value ?? "";

  const bandejaRaw = String(bandejaEl?.value ?? "a-mi");
  const isAdmin = isAdminRole(currentRole);
  const nextBandeja = isAdmin
    ? (bandejaRaw || "a-mi")
    : bandejaRaw === "por-mi"
      ? "por-mi"
      : "a-mi";

  filtros.bandeja = nextBandeja;
  if (bandejaEl && bandejaEl.value !== nextBandeja) {
    bandejaEl.value = nextBandeja;
  }

  filtros.adminPersona = shouldShowAdminPersonaPicker() ? (adminPersonaEl?.value ?? "") : "";
  updateAdminPersonaVisibility();
}

function configurarEventosTabla() {
  if (filtroTextoEl) {
    filtroTextoEl.addEventListener("input", () => {
      syncFiltros();
      renderTabla();
    });
  }

  [filtroEstadoEl, filtroUrgenciaEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      syncFiltros();
      renderTabla();
    });
  });

  if (bandejaEl) {
    bandejaEl.addEventListener("change", () => {
      syncFiltros();
      renderTabla();
    });
  }

  if (adminPersonaEl) {
    adminPersonaEl.addEventListener("change", () => {
      syncFiltros();
      renderTabla();
    });
  }

  if (btnLimpiarFiltros) {
    btnLimpiarFiltros.addEventListener("click", () => {
      if (filtroTextoEl) filtroTextoEl.value = "";
      if (filtroEstadoEl) filtroEstadoEl.value = "";
      if (filtroUrgenciaEl) filtroUrgenciaEl.value = "";
      syncFiltros();
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
          sortState = { key, dir: key.includes("fecha") ? "desc" : "asc" };
        }

        renderTabla();
      });
    });
  }
}

function configurarEventosModal() {
  detalleBtnCerrar?.addEventListener("click", closeDetalle);

  detalleModal?.addEventListener("click", (event) => {
    if (event.target === detalleModal) closeDetalle();
  });

  detalleBtnEditar?.addEventListener("click", () => {
    if (!detallePendienteId) return;
    window.navigateWithSession(`nuevo-pendiente.html?edit=${encodeURIComponent(detallePendienteId)}`);
  });

  detalleBtnEliminar?.addEventListener("click", async () => {
    if (!detallePendienteId) return;
    const vista = buildVista(
      pendientesCache.find((p) => p.id === detallePendienteId) || {}
    );
    try {
      await eliminarPendiente(vista);
      closeDetalle();
      await cargarPendientes();
    } catch (e) {
      console.error("No se pudo eliminar pendiente:", e);
      alert("No se pudo eliminar el pendiente.");
    }
  });

  detalleBtnSolicitar?.addEventListener("click", async () => {
    if (!detallePendienteId) return;
    const vista = buildVista(
      pendientesCache.find((p) => p.id === detallePendienteId) || {}
    );
    try {
      await solicitarCierre(vista);
      closeDetalle();
      await cargarPendientes();
    } catch (e) {
      console.error("No se pudo solicitar cierre:", e);
      alert("No se pudo solicitar cierre.");
    }
  });

  detalleBtnAceptar?.addEventListener("click", async () => {
    if (!detallePendienteId) return;
    const vista = buildVista(
      pendientesCache.find((p) => p.id === detallePendienteId) || {}
    );
    try {
      await aceptarCierre(vista);
      closeDetalle();
      await cargarPendientes();
    } catch (e) {
      console.error("No se pudo aceptar cierre:", e);
      alert("No se pudo aceptar cierre.");
    }
  });

  detalleBtnRechazar?.addEventListener("click", async () => {
    if (!detallePendienteId) return;
    const vista = buildVista(
      pendientesCache.find((p) => p.id === detallePendienteId) || {}
    );
    try {
      await rechazarCierre(vista);
      closeDetalle();
      await cargarPendientes();
    } catch (e) {
      console.error("No se pudo rechazar cierre:", e);
      alert("No se pudo rechazar cierre.");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetalle();
  });
}

function configurarTopbar() {
  const roleActivo = currentRole || "ventas";

  const estadoEl = document.getElementById("estado");
  if (estadoEl) {
    estadoEl.textContent = "Sesion: " + formatIdentity(currentUserProfile);
  }

  const roleEl = document.getElementById("role");
  if (roleEl) {
    roleEl.textContent = "Role: " + roleActivo;
  }

  if (btnCrear) {
    btnCrear.addEventListener("click", () => {
      window.navigateWithSession("nuevo-pendiente.html");
    });
  }
}

function configurarGestionSegunRol() {
  const isAdmin = isAdminRole(currentRole);

  if (bandejaEl) {
    const optionTodos = bandejaEl.querySelector('option[value="todos"]');
    if (optionTodos) optionTodos.hidden = !isAdmin;
    if (!isAdmin && bandejaEl.value === "todos") {
      bandejaEl.value = "a-mi";
    }
  }

  if (!isAdmin && adminPersonaEl) {
    adminPersonaEl.value = "";
  }

  syncFiltros();
  updateAdminPersonaVisibility();
}

configurarEventosTabla();
configurarEventosModal();

initSession(async () => {
  configurarTopbar();
  applyDeepLinkPendientesOnce();
  configurarGestionSegunRol();
  await cargarPendientes();
});
