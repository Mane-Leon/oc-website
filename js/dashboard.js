import { auth, db } from "./firebase.js";
import { initSession, currentRole, currentUserProfile } from "./session.js";
import { RUTAS, esEstadoFinal, getEstadoIndex } from "./rutas.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const msgEl = document.getElementById("mis-ocs-msg");
const totalEl = document.getElementById("kpi-total");
const enCursoEl = document.getElementById("kpi-en-curso");
const cerradasEl = document.getElementById("kpi-cerradas");
const estadosEl = document.getElementById("mis-ocs-estados");
const tbody = document.getElementById("mis-ocs-body");
const pendientesMsgEl = document.getElementById("mis-pendientes-msg");
const kpiPendientesMiEl = document.getElementById("kpi-pendientes-mi");
const kpiPendientesPorMiEl = document.getElementById("kpi-pendientes-por-mi");
const kpiPendientesCierreEl = document.getElementById("kpi-pendientes-cierre");
const pendientesAMiBody = document.getElementById("mis-pendientes-a-mi-body");
const pendientesPorMiBody = document.getElementById("mis-pendientes-por-mi-body");
let activePendientesUidAliases = new Set();
let activePendientesEmailAliases = new Set();
let pendientesQueryFailures = 0;

function navegarDesdeMiniMenu(href) {
  const target = String(href ?? "").trim();
  if (!target) return;
  if (typeof window.navigateWithSession === "function") {
    window.navigateWithSession(target);
    return;
  }
  window.location.href = target;
}

function configurarMiniMenusDashboard() {
  document.querySelectorAll("[data-nav-href]").forEach((el) => {
    const href = String(el.dataset.navHref ?? "").trim();
    if (!href) return;

    el.addEventListener("click", () => {
      navegarDesdeMiniMenu(href);
    });

    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        navegarDesdeMiniMenu(href);
      }
    });
  });
}

function navegarADetalleOcDesdeDashboard(ocId) {
  const id = String(ocId ?? "").trim();
  if (!id) return;
  const params = new URLSearchParams({
    scope: "mine",
    open_oc: id
  });
  navegarDesdeMiniMenu(`ocs.html?${params.toString()}`);
}

function navegarADetallePendienteDesdeDashboard(pendienteId, mode = "a-mi") {
  const id = String(pendienteId ?? "").trim();
  if (!id) return;
  const bandeja = mode === "por-mi" ? "por-mi" : "a-mi";
  const params = new URLSearchParams({
    bandeja,
    open_pendiente: id
  });
  navegarDesdeMiniMenu(`pendientes.html?${params.toString()}`);
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

function extraerCorreo(texto) {
  const match = String(texto ?? "")
    .trim()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? normalizeEmail(match[0]) : "";
}

function limpiarNombreVendedor(value) {
  return String(value ?? "")
    .replace(/\s*\([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\)\s*$/i, "")
    .trim();
}

function formatFecha(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("es-MX");
}

function isAdminRole(role) {
  const safe = String(role ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return safe === "admin" || safe === "admin_principal" || safe === "adminprincipal";
}

function resolveEstadoLabel(oc) {
  const ruta = oc?.ruta ?? null;
  const estado = String(oc?.estado ?? "por_surtir");

  if (!ruta || !RUTAS[ruta]) {
    return estado.replaceAll("_", " ");
  }

  let index = Number.isInteger(oc?.estado_index)
    ? oc.estado_index
    : getEstadoIndex(ruta, estado);

  if (index < 0 || index >= RUTAS[ruta].length) {
    index = getEstadoIndex(ruta, estado);
  }

  if (index < 0 || index >= RUTAS[ruta].length) {
    return estado.replaceAll("_", " ");
  }

  return RUTAS[ruta][index].label;
}

function estaCerrada(oc) {
  const ruta = oc?.ruta ?? null;
  const estado = String(oc?.estado ?? "por_surtir");

  if (!ruta || !RUTAS[ruta]) {
    return estado === "entregado";
  }

  let index = Number.isInteger(oc?.estado_index)
    ? oc.estado_index
    : getEstadoIndex(ruta, estado);

  if (index < 0 || index >= RUTAS[ruta].length) {
    index = getEstadoIndex(ruta, estado);
  }

  if (index < 0 || index >= RUTAS[ruta].length) {
    return estado === "entregado";
  }

  return esEstadoFinal(ruta, index);
}

function esOcDelPerfil(oc, profile) {
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

function renderEstados(ocs) {
  if (!estadosEl) return;
  estadosEl.innerHTML = "";

  if (!ocs.length) {
    estadosEl.textContent = "Sin datos.";
    return;
  }

  const byEstado = new Map();
  ocs.forEach((oc) => {
    const key = resolveEstadoLabel(oc);
    byEstado.set(key, (byEstado.get(key) || 0) + 1);
  });

  const ordenado = [...byEstado.entries()].sort((a, b) => b[1] - a[1]);
  ordenado.forEach(([estado, count]) => {
    const chip = document.createElement("span");
    chip.className = "estado-chip";
    chip.textContent = `${estado}: ${count}`;
    estadosEl.appendChild(chip);
  });
}

function renderTabla(ocs) {
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!ocs.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "No tienes OCs asignadas.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const createTd = (value) => {
    const td = document.createElement("td");
    td.textContent = String(value ?? "-");
    return td;
  };

  ocs.forEach((oc) => {
    const tr = document.createElement("tr");
    tr.appendChild(createTd(oc.id));
    tr.appendChild(createTd(oc.cliente ?? "-"));
    tr.appendChild(createTd(resolveEstadoLabel(oc)));
    tr.appendChild(createTd(oc.prioridad ?? "-"));
    tr.appendChild(createTd(formatFecha(oc.fecha_oc)));
    tr.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) return;
      navegarADetalleOcDesdeDashboard(oc.id);
    });
    tbody.appendChild(tr);
  });
}

function renderKpis(ocs) {
  const total = ocs.length;
  const cerradas = ocs.filter(estaCerrada).length;
  const enCurso = total - cerradas;

  if (totalEl) totalEl.textContent = String(total);
  if (cerradasEl) cerradasEl.textContent = String(cerradas);
  if (enCursoEl) enCursoEl.textContent = String(enCurso);
}

function pendienteEstadoLabel(estado) {
  switch (String(estado ?? "activo")) {
    case "cierre_solicitado":
      return "Cierre solicitado";
    case "cerrado":
      return "Cerrado";
    default:
      return "Activo";
  }
}

function pendienteEstadoClass(estado) {
  switch (String(estado ?? "activo")) {
    case "cierre_solicitado":
      return "estado-cierre";
    case "cerrado":
      return "estado-cerrado";
    default:
      return "estado-activo";
  }
}

function urgenciaClass(urgencia) {
  switch (String(urgencia ?? "media")) {
    case "alta":
      return "urgencia-alta";
    case "baja":
      return "urgencia-baja";
    default:
      return "urgencia-media";
  }
}

function getPendientesUidCandidates(profile) {
  const set = new Set(activePendientesUidAliases);
  const uidPerfil = String(profile?.uid ?? "").trim();
  if (uidPerfil) set.add(uidPerfil);
  return set;
}

function getPendientesEmailCandidates(profile) {
  const set = new Set(activePendientesEmailAliases);
  const profileEmail = normalizeEmail(profile?.email);
  const authEmail = normalizeEmail(auth.currentUser?.email);
  if (profileEmail) set.add(profileEmail);
  if (authEmail) set.add(authEmail);
  return set;
}

function isPendienteAssigner(p, profile) {
  const uidCandidates = getPendientesUidCandidates(profile);
  const byUid = uidCandidates.has(String(p?.asignado_por_uid ?? "").trim());
  const emailCandidates = getPendientesEmailCandidates(profile);
  const byEmail = emailCandidates.has(normalizeEmail(p?.asignado_por_correo));
  return Boolean(byUid || byEmail);
}

function isPendienteResponsible(p, profile) {
  const uidCandidates = getPendientesUidCandidates(profile);
  const emailCandidates = getPendientesEmailCandidates(profile);

  const uids = Array.isArray(p?.responsable_uids)
    ? p.responsable_uids.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const participantesUids = Array.isArray(p?.participantes_uids)
    ? p.participantes_uids.map((v) => String(v ?? "").trim()).filter(Boolean)
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

function responsablesTexto(p) {
  if (Array.isArray(p?.responsables) && p.responsables.length) {
    const names = p.responsables
      .map((r) => String(r?.name ?? "").trim())
      .filter(Boolean);
    return names.length ? names.join(", ") : "-";
  }

  if (Array.isArray(p?.responsable_nombres) && p.responsable_nombres.length) {
    const names = p.responsable_nombres
      .map((r) => String(r ?? "").trim())
      .filter(Boolean);
    return names.length ? names.join(", ") : "-";
  }

  return "-";
}

function createTd(value) {
  const td = document.createElement("td");
  td.textContent = String(value ?? "-");
  return td;
}

function createBadgeTd(value, className) {
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${className}`;
  badge.textContent = String(value ?? "-");
  td.appendChild(badge);
  return td;
}

function sortPendientes(rows) {
  return [...rows].sort((a, b) => {
    const ta = new Date(a?.fecha_entrada || a?.updated_at || 0).getTime();
    const tb = new Date(b?.fecha_entrada || b?.updated_at || 0).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
}

function renderPendientesTable(tbodyEl, rows, mode) {
  if (!tbodyEl) return;
  tbodyEl.innerHTML = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = mode === "a-mi"
      ? "No tienes pendientes asignados."
      : "No has asignado pendientes.";
    tr.appendChild(td);
    tbodyEl.appendChild(tr);
    return;
  }

  rows.forEach((p) => {
    const tr = document.createElement("tr");
    tr.appendChild(createTd(p.id));
    tr.appendChild(createTd(p.asunto ?? "-"));
    tr.appendChild(createBadgeTd(
      pendienteEstadoLabel(p.estado),
      pendienteEstadoClass(p.estado)
    ));
    tr.appendChild(createBadgeTd(
      String(p.urgencia ?? "media"),
      urgenciaClass(p.urgencia)
    ));
    tr.appendChild(createTd(formatFecha(p.fecha_entrada)));
    tr.appendChild(createTd(formatFecha(p.fecha_resolucion_propuesta)));
    tr.appendChild(
      mode === "a-mi"
        ? createTd(p.asignado_por_nombre || "-")
        : createTd(responsablesTexto(p))
    );
    tr.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) return;
      navegarADetallePendienteDesdeDashboard(p.id, mode);
    });
    tbodyEl.appendChild(tr);
  });
}

function renderPendientesKpis(rowsMi, rowsPorMi, allRows) {
  if (kpiPendientesMiEl) kpiPendientesMiEl.textContent = String(rowsMi.length);
  if (kpiPendientesPorMiEl) kpiPendientesPorMiEl.textContent = String(rowsPorMi.length);
  const cierreSolicitado = allRows.filter((p) => String(p?.estado ?? "") === "cierre_solicitado").length;
  if (kpiPendientesCierreEl) kpiPendientesCierreEl.textContent = String(cierreSolicitado);
}

async function safeGetDocs(q, label = "") {
  try {
    return await getDocs(q);
  } catch (e) {
    pendientesQueryFailures += 1;
    console.warn(`Consulta de pendientes no disponible${label ? ` (${label})` : ""}:`, e);
    return null;
  }
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

async function cargarMisPendientes() {
  if (!currentUserProfile) return;
  if (pendientesMsgEl) pendientesMsgEl.textContent = "Cargando pendientes...";
  activePendientesUidAliases = new Set([String(currentUserProfile?.uid ?? "").trim()].filter(Boolean));
  activePendientesEmailAliases = new Set(
    [normalizeEmail(currentUserProfile?.email), normalizeEmail(auth.currentUser?.email)].filter(Boolean)
  );

  try {
    let allRows = [];
    const isAdmin = isAdminRole(currentRole);

    if (isAdmin) {
      const snap = await getDocs(collection(db, "pendientes"));
      allRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } else {
      pendientesQueryFailures = 0;
      const uidAliases = await getUidAliases(currentUserProfile);
      const emailAliases = getEmailAliases(currentUserProfile);
      uidAliases.forEach((uid) => activePendientesUidAliases.add(uid));
      emailAliases.forEach((email) => activePendientesEmailAliases.add(email));
      const map = new Map();
      const tasks = [];

      uidAliases.forEach((uid) => {
        tasks.push(
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
        tasks.push(
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

      const snaps = await Promise.all(tasks);
      snaps.filter(Boolean).forEach((snap) => {
        snap.forEach((docSnap) => {
          map.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        });
      });

      allRows = [...map.values()];
    }

    const rowsMi = sortPendientes(allRows.filter((p) => isPendienteResponsible(p, currentUserProfile)));
    const rowsPorMi = sortPendientes(allRows.filter((p) => isPendienteAssigner(p, currentUserProfile)));

    renderPendientesKpis(rowsMi, rowsPorMi, allRows);
    renderPendientesTable(pendientesAMiBody, rowsMi, "a-mi");
    renderPendientesTable(pendientesPorMiBody, rowsPorMi, "por-mi");

    if (pendientesMsgEl) {
      if (!allRows.length && pendientesQueryFailures > 0) {
        pendientesMsgEl.textContent = "No se pudieron leer algunos pendientes por permisos/reglas.";
      } else {
        pendientesMsgEl.textContent = `Asignados a mi: ${rowsMi.length}. Asignados por mi: ${rowsPorMi.length}.`;
      }
    }
  } catch (e) {
    console.error("No se pudo cargar el dashboard de pendientes:", e);
    if (pendientesMsgEl) pendientesMsgEl.textContent = "No se pudo cargar pendientes.";
    renderPendientesKpis([], [], []);
    renderPendientesTable(pendientesAMiBody, [], "a-mi");
    renderPendientesTable(pendientesPorMiBody, [], "por-mi");
  }
}

async function cargarMisOCs() {
  if (!currentUserProfile) return;
  if (msgEl) msgEl.textContent = "Cargando...";

  try {
    const snap = await getDocs(collection(db, "ordenes_compra"));
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const mias = all
      .filter((oc) => esOcDelPerfil(oc, currentUserProfile))
      .sort((a, b) => {
        const ta = new Date(a?.fecha_oc ?? 0).getTime();
        const tb = new Date(b?.fecha_oc ?? 0).getTime();
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      });

    renderKpis(mias);
    renderEstados(mias);
    renderTabla(mias);

    if (msgEl) {
      msgEl.textContent = mias.length
        ? `Mostrando ${mias.length} OCs de tu perfil.`
        : "No se encontraron OCs ligadas a tu perfil.";
    }
  } catch (e) {
    console.error("No se pudo cargar el dashboard de OCs:", e);
    if (msgEl) msgEl.textContent = "No se pudo cargar tus OCs.";
    renderKpis([]);
    renderEstados([]);
    renderTabla([]);
  }
}

initSession(async () => {
  await cargarMisOCs();
  await cargarMisPendientes();
});

configurarMiniMenusDashboard();
