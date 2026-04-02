// js/rutas.js

export const RUTAS = {
  almacen: [
    { key: "por_surtir", label: "Por surtir" },
    { key: "surtido", label: "Surtido" },
    { key: "facturado", label: "Facturado" },
    { key: "listo_entrega", label: "Listo para entrega o recoleccion" },
    { key: "entregado", label: "Entregado" }
  ],

  sucursal: [
    { key: "por_surtir", label: "Por surtir" },
    { key: "pedido_sucursal", label: "Pedido a sucursal" },
    { key: "autorizado", label: "Autorizado" },
    { key: "oc_intercompany", label: "OC intercompany" },
    { key: "recoleccion", label: "Recoleccion" },
    { key: "factura_intercompany", label: "Factura intercompany" },
    { key: "recepcion", label: "Recepcion" },
    { key: "facturado_cliente", label: "Facturado al cliente" },
    { key: "listo_entrega", label: "Listo para entrega o recoleccion" },
    { key: "entregado", label: "Entregado" }
  ],

  alemania: [
    { key: "por_surtir", label: "Por surtir" },
    { key: "revision_costos", label: "Revision de costos" },
    { key: "ok_costos", label: "Costos OK" },
    { key: "carga_oc_o_mit", label: "Carga de OC o MIT" },
    { key: "backorder", label: "Backorder sucursal" },
    { key: "llegada_qro", label: "Material llega a QRO" },
    { key: "oc_intercompany", label: "OC intercompany" },
    { key: "factura_intercompany", label: "Factura intercompany" },
    { key: "recoleccion", label: "Recoleccion" },
    { key: "recepcion", label: "Recepcion" },
    { key: "facturado_cliente", label: "Facturado al cliente" },
    { key: "listo_entrega", label: "Listo para entrega o recoleccion" },
    { key: "entregado", label: "Entregado" }
  ]
};

export function getEstadoIndex(ruta, estadoKey) {
  return RUTAS[ruta].findIndex(e => e.key === estadoKey);
}

export function getSiguientePaso(ruta, estadoIndex) {
  return RUTAS[ruta][estadoIndex + 1] || null;
}

export function esEstadoFinal(ruta, estadoIndex) {
  return estadoIndex === RUTAS[ruta].length - 1;
}