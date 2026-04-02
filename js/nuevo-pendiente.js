import { db } from "./firebase.js";
import {
  initSession,
  currentRole,
  currentUserProfile,
  formatIdentity,
  getUsersDirectory
} from "./session.js";
import {
  addDoc,
  collection,
  doc as fsDoc,
  getDoc,
  getDocs,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const form = document.getElementById("form-pendiente");
const msg = document.getElementById("msg-pendiente");
const formTitle = document.getElementById("pendiente-form-title");
const btnGuardar = document.getElementById("btn-guardar-pendiente");
const responsablesSelect = document.getElementById("responsables_uids");
const responsablesCount = document.getElementById("responsables-count");
const btnSeleccionarme = document.getElementById("btn-seleccionarme");

const pendienteIdEdicion = new URLSearchParams(window.location.search).get("edit")?.trim() || "";
const isEditMode = Boolean(pendienteIdEdicion);

let usersByUid = new Map();
let userOptions = [];
let puedeEditarActual = !isEditMode;
let isAdminActual = false;
let usersRawProfiles = [];
let pendienteEnEdicion = null;

function isAdminRole(role) {
  const safe = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return safe === "admin" || safe === "admin_principal" || safe === "adminprincipal";
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getIsoFromInputDate(value, optional = false) {
  if (!value) return optional ? null : new Date().toISOString();
  return new Date(value + "T00:00:00").toISOString();
}

function inputDateFromAny(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildUsersListFromDirectory(directory) {
  const seen = new Set();
  const users = [];

  directory.byUid.forEach((profile, uid) => {
    const userUid = String(uid || profile?.uid || "").trim();
    if (!userUid || seen.has(userUid)) return;
    seen.add(userUid);

    const name = String(profile?.name ?? "").trim() || "Usuario";
    const email = normalizeEmail(profile?.email);
    users.push({ uid: userUid, uidAliases: [userUid], name, email });
  });

  return users.sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", "es", { sensitivity: "base" })
  );
}

function buildUsersListFromRawUsers(snap) {
  const users = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data() ?? {};
    const docUid = String(docSnap.id ?? "").trim();
    const uidAliases = docUid ? [docUid] : [];
    if (!uidAliases.length) return;
    const currentUid = String(currentUserProfile?.uid ?? "").trim();
    const uid = uidAliases.includes(currentUid) ? currentUid : docUid;
    const name = String(data?.nombre ?? data?.name ?? data?.displayName ?? "").trim() || "Usuario";
    const email = normalizeEmail(data?.email ?? data?.correo);
    users.push({ uid, uidAliases, name, email });
  });
  return users;
}

function renderResponsablesSelect(selectedUids = []) {
  if (!responsablesSelect) return;

  const selected = new Set(selectedUids.map((v) => String(v || "").trim()).filter(Boolean));
  responsablesSelect.innerHTML = "";

  userOptions.forEach((user) => {
    const option = document.createElement("option");
    option.value = user.uid;
    option.textContent = user.email ? `${user.name} (${user.email})` : user.name;
    const aliases = Array.isArray(user.uidAliases) ? user.uidAliases : [user.uid];
    option.selected = aliases.some((alias) => selected.has(alias));
    responsablesSelect.appendChild(option);
  });

  actualizarConteoResponsables();
}

function actualizarConteoResponsables() {
  if (!responsablesSelect || !responsablesCount) return;
  const count = [...responsablesSelect.selectedOptions].length;
  responsablesCount.textContent = `${count} seleccionados`;
}

function getResponsablesSeleccionados() {
  if (!responsablesSelect) return [];

  return [...responsablesSelect.selectedOptions]
    .map((opt) => String(opt.value || "").trim())
    .filter(Boolean)
    .map((uid) => usersByUid.get(uid))
    .filter(Boolean)
    .map((u) => ({
      uid: u.uid,
      uidAliases: [...new Set([u.uid, ...(Array.isArray(u.uidAliases) ? u.uidAliases : [])].filter(Boolean))],
      name: u.name || "Usuario",
      email: normalizeEmail(u.email)
    }));
}

async function cargarUsuarios() {
  userOptions = [];
  usersRawProfiles = [];

  try {
    const snap = await getDocs(collection(db, "users"));
    usersRawProfiles = buildUsersListFromRawUsers(snap);
    userOptions = [...usersRawProfiles];
  } catch (e) {
    console.warn("Lectura completa de users fallida para pendientes, usando directorio:", e);
  }

  if (!userOptions.length) {
    try {
      const directory = await getUsersDirectory();
      userOptions = buildUsersListFromDirectory(directory);
      usersRawProfiles = [...userOptions];
    } catch (e) {
      console.error("No se pudo cargar users para pendientes:", e);
      userOptions = [];
      usersRawProfiles = [];
    }
  }

  // dedupe por persona (email preferente; fallback por uid)
  const dedupe = new Map();
  userOptions.forEach((u) => {
    if (!u?.uid) return;
    const emailKey = normalizeEmail(u.email);
    const key = emailKey ? `email:${emailKey}` : `uid:${u.uid}`;
    const existing = dedupe.get(key);
    if (!existing) {
      dedupe.set(key, {
        ...u,
        uidAliases: [...new Set([u.uid, ...(Array.isArray(u.uidAliases) ? u.uidAliases : [])].filter(Boolean))]
      });
      return;
    }

    const mergedAliases = [...new Set([
      existing.uid,
      ...(existing.uidAliases || []),
      u.uid,
      ...(u.uidAliases || [])
    ].filter(Boolean))];
    const currentUid = String(currentUserProfile?.uid ?? "").trim();
    const preferredUid = mergedAliases.includes(currentUid)
      ? currentUid
      : (existing.uid || u.uid);

    dedupe.set(key, {
      uid: preferredUid,
      uidAliases: mergedAliases,
      name: existing.name || u.name || "Usuario",
      email: existing.email || u.email || ""
    });
  });
  userOptions = [...dedupe.values()].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", "es", { sensitivity: "base" })
  );

  if (currentUserProfile?.uid && !userOptions.some((u) => (u.uidAliases || []).includes(currentUserProfile.uid))) {
    userOptions.unshift({
      uid: currentUserProfile.uid,
      uidAliases: [currentUserProfile.uid],
      name: currentUserProfile.name || "Usuario",
      email: normalizeEmail(currentUserProfile.email)
    });
  }

  usersByUid = new Map();
  userOptions.forEach((u) => {
    usersByUid.set(u.uid, u);
    (u.uidAliases || []).forEach((alias) => usersByUid.set(alias, u));
  });
  renderResponsablesSelect([]);
}

function setFormDisabled(disabled) {
  if (!form) return;
  form.querySelectorAll("input, textarea, select, button").forEach((el) => {
    if (el.id === "btn-guardar-pendiente" || el.id === "btn-seleccionarme") {
      el.disabled = disabled;
      return;
    }
    el.disabled = disabled;
  });
  if (btnGuardar) btnGuardar.disabled = disabled;
  if (btnSeleccionarme) btnSeleccionarme.disabled = disabled;
}

async function cargarPendienteParaEditar() {
  if (!isEditMode) return;

  try {
    const snap = await getDoc(fsDoc(db, "pendientes", pendienteIdEdicion));
    if (!snap.exists()) {
      msg.textContent = "El pendiente a editar no existe.";
      puedeEditarActual = false;
      setFormDisabled(true);
      return;
    }

    const pendiente = snap.data();
    pendienteEnEdicion = pendiente;
    const currentUid = String(currentUserProfile?.uid ?? "").trim();
    const currentEmail = normalizeEmail(currentUserProfile?.email);
    const asignadoPorUid = String(pendiente?.asignado_por_uid ?? "").trim();
    const asignadoPorCorreo = normalizeEmail(pendiente?.asignado_por_correo);
    const selfAliases = new Set([currentUid].filter(Boolean));
    const selfProfile = usersByUid.get(currentUid);
    (selfProfile?.uidAliases || []).forEach((alias) => selfAliases.add(String(alias || "").trim()));
    const canEditByIdentity = selfAliases.has(asignadoPorUid)
      || (Boolean(currentEmail) && currentEmail === asignadoPorCorreo);

    if (!isAdminActual && !canEditByIdentity) {
      msg.textContent = "Solo admin o quien asigno el pendiente puede editarlo.";
      puedeEditarActual = false;
      setFormDisabled(true);
      return;
    }

    puedeEditarActual = true;
    setFormDisabled(false);

    const asuntoEl = document.getElementById("asunto");
    const urgenciaEl = document.getElementById("urgencia");
    const fechaEntradaEl = document.getElementById("fecha_entrada");
    const fechaPropuestaEl = document.getElementById("fecha_resolucion_propuesta");
    const notasEl = document.getElementById("notas");

    if (asuntoEl) asuntoEl.value = pendiente.asunto ?? "";
    if (urgenciaEl) urgenciaEl.value = pendiente.urgencia ?? "media";
    if (fechaEntradaEl) fechaEntradaEl.value = inputDateFromAny(pendiente.fecha_entrada);
    if (fechaPropuestaEl) {
      fechaPropuestaEl.value = inputDateFromAny(pendiente.fecha_resolucion_propuesta);
    }
    if (notasEl) notasEl.value = pendiente.notas ?? "";

    const selectedUids = Array.isArray(pendiente.responsable_uids)
      ? pendiente.responsable_uids
      : [];
    renderResponsablesSelect(selectedUids);
  } catch (e) {
    console.error("No se pudo cargar pendiente para edicion:", e);
    msg.textContent = "No se pudo cargar el pendiente.";
  }
}

function configurarEventos() {
  responsablesSelect?.addEventListener("change", actualizarConteoResponsables);

  btnSeleccionarme?.addEventListener("click", () => {
    const myUid = String(currentUserProfile?.uid ?? "").trim();
    if (!myUid || !responsablesSelect) return;
    const option = [...responsablesSelect.options].find((opt) => {
      const user = usersByUid.get(String(opt.value || "").trim());
      const aliases = [...new Set([user?.uid, ...(user?.uidAliases || [])]
        .map((v) => String(v ?? "").trim())
        .filter(Boolean))];
      return aliases.includes(myUid);
    });
    if (!option) return;
    option.selected = true;
    actualizarConteoResponsables();
  });
}

initSession(async () => {
  const roleActivo = currentRole || "ventas";
  isAdminActual = isAdminRole(roleActivo);

  if (formTitle && btnGuardar) {
    formTitle.textContent = isEditMode ? "Editar pendiente" : "Nuevo pendiente";
    btnGuardar.textContent = isEditMode ? "Actualizar pendiente" : "Guardar pendiente";
  }

  const estadoEl = document.getElementById("estado");
  if (estadoEl && currentUserProfile) {
    estadoEl.textContent = "Sesion: " + formatIdentity(currentUserProfile);
  }

  const roleEl = document.getElementById("role");
  if (roleEl) {
    roleEl.textContent = "Role: " + roleActivo;
  }

  const fechaEntradaEl = document.getElementById("fecha_entrada");
  if (fechaEntradaEl && !isEditMode && !fechaEntradaEl.value) {
    fechaEntradaEl.value = new Date().toISOString().slice(0, 10);
  }

  await cargarUsuarios();
  await cargarPendienteParaEditar();
  configurarEventos();
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  msg.textContent = "";

  if (isEditMode && !puedeEditarActual) {
    msg.textContent = "No tienes permisos para editar este pendiente.";
    return;
  }

  const asunto = document.getElementById("asunto")?.value.trim();
  const urgencia = document.getElementById("urgencia")?.value || "media";
  const fechaEntradaInput = document.getElementById("fecha_entrada")?.value;
  const fechaPropuestaInput = document.getElementById("fecha_resolucion_propuesta")?.value;
  const notas = document.getElementById("notas")?.value.trim() || "";
  const responsables = getResponsablesSeleccionados();

  if (!asunto) {
    msg.textContent = "El asunto es obligatorio.";
    return;
  }

  if (!fechaEntradaInput) {
    msg.textContent = "La fecha de entrada es obligatoria.";
    return;
  }

  if (!responsables.length) {
    msg.textContent = "Selecciona al menos un responsable.";
    return;
  }

  const responsablesPayload = responsables.map((r) => ({
    uid: String(r.uid || "").trim(),
    name: String(r.name || "Usuario").trim(),
    email: normalizeEmail(r.email)
  }));
  const responsableUids = [...new Set(
    responsables
      .flatMap((r) => r.uidAliases || [r.uid])
      .map((v) => String(v || "").trim())
      .filter(Boolean)
  )];
  const responsableCorreos = [...new Set(
    responsablesPayload.map((r) => normalizeEmail(r.email)).filter(Boolean)
  )];
  const responsableNombres = [...new Set(
    responsablesPayload.map((r) => String(r.name || "").trim()).filter(Boolean)
  )];

  // Reconciliacion preventiva: agrega aliases por email/nombre para evitar perdidas por datos inconsistentes.
  const emailSet = new Set(responsableCorreos);
  const nameSet = new Set(responsableNombres.map(normalizeName));

  usersRawProfiles.forEach((u) => {
    const aliases = [...new Set([u?.uid, ...(Array.isArray(u?.uidAliases) ? u.uidAliases : [])]
      .map((v) => String(v ?? "").trim())
      .filter(Boolean))];
    const email = normalizeEmail(u?.email);
    const name = String(u?.name ?? "").trim();
    const nameKey = normalizeName(name);

    const sameEmail = email && emailSet.has(email);
    const sameName = nameKey && nameSet.has(nameKey);
    if (!sameEmail && !sameName) return;

    aliases.forEach((uid) => {
      if (uid && !responsableUids.includes(uid)) responsableUids.push(uid);
    });
    if (email && !responsableCorreos.includes(email)) responsableCorreos.push(email);
    if (name && !responsableNombres.includes(name)) responsableNombres.push(name);
  });

  const profile = currentUserProfile || {};
  const asignadoPorUid = isEditMode
    ? String(pendienteEnEdicion?.asignado_por_uid || "").trim() || String(profile.uid || "").trim()
    : String(profile.uid || "").trim();
  const asignadoPorCorreo = normalizeEmail(
    isEditMode ? (pendienteEnEdicion?.asignado_por_correo || profile.email) : profile.email
  );
  const participantesUids = [...new Set([asignadoPorUid, ...responsableUids].filter(Boolean))];
  const participantesCorreos = [...new Set([asignadoPorCorreo, ...responsableCorreos].filter(Boolean))];

  const payload = {
    asunto,
    notas,
    urgencia,
    fecha_entrada: getIsoFromInputDate(fechaEntradaInput),
    fecha_resolucion_propuesta: getIsoFromInputDate(fechaPropuestaInput, true),
    responsables: responsablesPayload,
    responsable_uids: responsableUids,
    responsable_correos: responsableCorreos,
    responsable_nombres: responsableNombres,
    participantes_uids: participantesUids,
    participantes_correos: participantesCorreos,
    updated_at: new Date().toISOString()
  };

  try {
    if (isEditMode) {
      await updateDoc(fsDoc(db, "pendientes", pendienteIdEdicion), payload);
    } else {
      await addDoc(collection(db, "pendientes"), {
        ...payload,
        created_at: new Date().toISOString(),
        estado: "activo",
        asignado_por_uid: asignadoPorUid,
        asignado_por_nombre: String(profile.name || "Usuario").trim(),
        asignado_por_correo: asignadoPorCorreo,
        cierre_solicitado_por_uid: "",
        cierre_solicitado_por_nombre: "",
        cierre_solicitado_por_correo: "",
        cierre_solicitado_en: null,
        cierre_rechazado_por_uid: "",
        cierre_rechazado_por_nombre: "",
        cierre_rechazado_en: null,
        cerrado_por_uid: "",
        cerrado_por_nombre: "",
        cerrado_por_correo: "",
        cerrado_en: null
      });
    }

    window.navigateWithSession("pendientes.html");
  } catch (e) {
    console.error("No se pudo guardar pendiente:", e);
    msg.textContent = "No se pudo guardar el pendiente.";
  }
});
