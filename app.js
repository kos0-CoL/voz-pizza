/* Pizzería La Esquina — Multi-Agent Orchestration System
   App estática: sin build, sin backend. API keys en localStorage.
   Arquitectura: Orquestador → Agentes especializados → Skills compartidas
*/

/* ============================================================
   1. CONFIGURACIÓN & ESTADO GLOBAL
   ============================================================ */

const LS = {
  // Proveedores LLM
  key_gemini: 'pizzeria_key_gemini_v1',
  modelo_gemini: 'pizzeria_modelo_gemini_v1',
  key_openrouter: 'pizzeria_key_openrouter_v1',
  modelo_openrouter: 'pizzeria_modelo_openrouter_v1',
  proveedor: 'pizzeria_proveedor_v1',
  openrouter_free_only: 'pizzeria_openrouter_free_only_v1',

  // TTS
  tts_engine: 'pizzeria_tts_engine_v1',
  tts_voice: 'pizzeria_tts_voice_v1',
  tts_rate: 'pizzeria_tts_rate_v1',
  tts_pitch: 'pizzeria_tts_pitch_v1',
  edge_voice: 'pizzeria_edge_voice_v1',
  piper_binary: 'pizzeria_piper_binary_v1',
  piper_model: 'pizzeria_piper_model_v1',
  piper_config: 'pizzeria_piper_config_v1',
  coqui_model: 'pizzeria_coqui_model_v1',
  coqui_speaker: 'pizzeria_coqui_speaker_v1',
  coqui_language: 'pizzeria_coqui_language_v1',

  // App
  hist: 'pizzeria_historial_v1',
};

const MAX_PASOS_ORQUESTADOR = 12;
const MAX_PASOS_AGENTE = 6;

const MODELOS_GEMINI = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (rápido, free tier)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (más razonamiento)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (respaldo)' },
];

const EDGE_VOICES_ES = [
  'es-AR-ElenaNeural', 'es-AR-TomasNeural',
  'es-ES-AlvaroNeural', 'es-ES-ElviraNeural', 'es-ES-NilsNeural',
  'es-MX-DaliaNeural', 'es-MX-JorgeNeural',
  'es-CL-CatalinaNeural', 'es-CO-GonzaloNeural', 'es-PE-AlexNeural',
  'es-VE-PaolaNeural', 'es-VE-SebastianNeural',
];

const COQUI_MODELS_ES = [
  'tts_models/es/css10/vits',
  'tts_models/es/mai/tacotron2-DDC',
  'tts_models/multilingual/multi-dataset/xtts_v2',
  'tts_models/multilingual/multi-dataset/your_tts',
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');

function esc(s) {
  return String(s ?? '').replace(/[&<>\"']/g, (c) => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": "'",
  }[c]));
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============================================================
   2. CATÁLOGO (Shared)
   ============================================================ */

let __cargandoMenu = null;
async function cargarMenu() {
  if (state.menu) return state.menu;
  if (__cargandoMenu) return __cargandoMenu;
  __cargandoMenu = (async () => {
    const res = await fetch('data/menu.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.menu = await res.json();
    return state.menu;
  })();
  try { return await __cargandoMenu; }
  finally { __cargandoMenu = null; }
}

function extraById(id) {
  if (!state.menu) return null;
  const key = norm(id);
  return state.menu.extras.find((e) => e.id === id || norm(e.id) === key || norm(e.nombre) === key) || null;
}

function itemById(id) {
  if (!state.menu) return null;
  return state.menu.items.find((i) => i.id === id) || null;
}

function itemResumen(it) {
  const out = { item_id: it.id, nombre: it.nombre, categoria: it.categoria, stock: it.stock };
  if (it.variantes) out.variantes = it.variantes.map((v) => ({ variante_id: v.id, nombre: v.nombre, precio: v.precio }));
  else { out.precio = it.precio; out.unidad = it.unidad || 'unidad'; }
  if (it.extrasPermitidos) out.extras_permitidos = it.extrasPermitidos.map((id) => extraById(id)).filter(Boolean).map((e) => ({ extra_id: e.id, nombre: e.nombre, precio: e.precio }));
  return out;
}

/* ============================================================
   3. SKILLS REGISTRY (Herramientas compartidas por todos los agentes)
   ============================================================ */

const SKILLS = {
  // --- Catálogo & Stock ---
  buscar_en_catalogo: {
    description: 'Busca platos/bebidas por nombre, alias o descripción. Devuelve ids, precios, variantes, extras permitidos y stock.',
    params: { type: 'OBJECT', properties: { consulta: { type: 'STRING', description: 'Ej: "muzza grande" o "cerveza"' } }, required: ['consulta'] },
    fn: async (args) => {
      const q = norm(args.consulta);
      if (!q) return { ok: false, error: 'Consulta vacía' };
      const scored = [];
      for (const it of state.menu.items) {
        const nombres = [it.nombre, ...(it.alias || [])].map(norm).filter(Boolean);
        let best = 0;
        for (const n of nombres) {
          if (q === n) best = Math.max(best, 100);
          else if (n.length >= 3 && q.includes(n)) best = Math.max(best, 60 + n.length);
          else if (q.length >= 4 && n.includes(q)) best = Math.max(best, 45 + q.length);
          else {
            const s = similitud(q, n);
            if (s > 0.7) best = Math.max(best, Math.round(30 * s));
          }
        }
        if (best > 0) scored.push({ item: it, best });
      }
      scored.sort((a, b) => b.best - a.best);
      const items = scored.slice(0, 4).map((s) => itemResumen(s.item));
      return { ok: true, encontrados: items.length, items };
    },
  },

  verificar_stock: {
    description: 'Verifica disponibilidad de un item para una cantidad.',
    params: { type: 'OBJECT', properties: { item_id: { type: 'STRING' }, cantidad: { type: 'INTEGER', minimum: 1 } }, required: ['item_id', 'cantidad'] },
    fn: async (args) => {
      const it = itemById(args.item_id);
      if (!it) return { ok: false, error: `Item "${args.item_id}" no existe` };
      const cantidad = Math.max(1, parseInt(args.cantidad, 10) || 1);
      return { ok: true, item_id: it.id, nombre: it.nombre, pedido: cantidad, stock: it.stock, disponible: cantidad <= it.stock };
    },
  },

  // --- Cálculo & Validación ---
  calcular_total: {
    description: 'Valida pedido completo (items, tamaños, extras, stock) y devuelve precios y total. OBLIGATORIO antes de confirmar.',
    params: {
      type: 'OBJECT',
      properties: {
        lineas: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              item_id: { type: 'STRING' },
              variante_id: { type: 'STRING', description: 'chica | mediana | grande (solo pizzas)' },
              cantidad: { type: 'INTEGER' },
              extras: { type: 'ARRAY', items: { type: 'STRING' }, description: 'IDs de extras permitidos' },
            },
            required: ['item_id', 'cantidad'],
          },
        },
      },
      required: ['lineas'],
    },
    fn: async (args, ctx) => {
      const lineas = Array.isArray(args.lineas) ? args.lineas : [];
      if (!lineas.length) return { ok: false, error: 'Sin líneas de pedido' };

      const salida = [];
      const problemas = [];
      let total = 0;

      for (const l of lineas) {
        const it = itemById(l.item_id);
        if (!it) { problemas.push(`Item "${l.item_id}" no existe`); continue; }

        const cantidad = Math.max(1, parseInt(l.cantidad, 10) || 1);
        let variante = null;
        if (it.variantes) {
          const vid = norm(l.variante_id);
          variante = it.variantes.find((v) => v.id === l.variante_id || norm(v.nombre).includes(vid)) || null;
          if (!variante) { problemas.push(`${it.nombre}: falta tamaño (chica/mediana/grande)`); continue; }
        }
        if (cantidad > it.stock) { problemas.push(`${it.nombre}: pediste ${cantidad}, stock ${it.stock}`); continue; }

        const extras = [];
        for (const raw of (l.extras || [])) {
          const ex = extraById(raw);
          if (!ex) { problemas.push(`Extra "${raw}" desconocido`); continue; }
          if (it.extrasPermitidos && !it.extrasPermitidos.includes(ex.id)) { problemas.push(`${it.nombre} no admite ${ex.nombre}`); continue; }
          extras.push(ex);
        }

        const base = variante ? variante.precio : it.precio;
        const extraUnit = extras.reduce((a, e) => a + e.precio, 0);
        const subtotal = (base + extraUnit) * cantidad;
        total += subtotal;

        salida.push({
          item_id: it.id, nombre: it.nombre,
          variante: variante ? variante.nombre : null, variante_id: variante ? variante.id : null,
          cantidad, extras: extras.map((e) => e.nombre),
          precio_unitario: base + extraUnit, subtotal,
        });
      }

      if (problemas.length) return { ok: false, problemas };

      const r = { ok: true, lineas: salida, total, moneda: state.menu.tienda.moneda, tiempo_estimado_min: state.menu.tienda.tiempoEstimadoMin };
      ctx.total = r;
      return r;
    },
  },

  // --- Interacción ---
  pedir_aclaracion: {
    description: 'Pregunta al cliente cuando falta un dato esencial. Termina la corrida actual.',
    params: { type: 'OBJECT', properties: { pregunta: { type: 'STRING', description: 'Pregunta corta en español rioplatense' } }, required: ['pregunta'] },
    fn: async (args, ctx) => {
      const pregunta = String(args.pregunta || '').trim();
      if (!pregunta) return { ok: false, error: 'Aclaración vacía' };
      ctx.aclaracion = pregunta;
      return { ok: true, aclaracion: pregunta };
    },
  },

  confirmar_pedido: {
    description: 'Confirma pedido ya calculado. Requiere calcular_total exitoso previo.',
    params: { type: 'OBJECT', properties: { nombre_cliente: { type: 'STRING' }, telefono: { type: 'STRING' }, direccion: { type: 'STRING' }, notas: { type: 'STRING' } } },
    fn: async (args, ctx) => {
      if (!ctx.total) return { ok: false, error: 'Antes debe ejecutar calcular_total' };
      const numero = '#' + String(1000 + Math.floor(Math.random() * 9000));
      const resultado = {
        tipo: 'confirmado', numero,
        lineas: ctx.total.lineas, total: ctx.total.total, moneda: ctx.total.moneda,
        tiempo_estimado_min: ctx.total.tiempo_estimado_min,
        cliente: { nombre: args.nombre_cliente || null, telefono: args.telefono || null, direccion: args.direccion || null, notas: args.notas || null },
        confirmado_en: new Date().toISOString(),
      };
      ctx.confirmado = resultado;
      return { ok: true, pedido: numero, total: resultado.total, moneda: resultado.moneda, tiempo_estimado_min: resultado.tiempo_estimado_min, mensaje: 'Pedido confirmado y enviado a cocina' };
    },
  },

  // --- Skills FUTURAS (pre-cableadas para post-MVP) ---
  whatsapp_enviar_mensaje: {
    description: '[FUTURO] Envía mensaje via WhatsApp API no oficial. Requiere configuración de sesión.',
    params: { type: 'OBJECT', properties: { telefono: { type: 'STRING' }, mensaje: { type: 'STRING' }, tipo: { type: 'STRING', enum: ['texto', 'imagen', 'documento', 'ubicacion'] }, media_url: { type: 'STRING' } }, required: ['telefono', 'mensaje'] },
    fn: async (args) => ({ ok: false, error: 'Agente WhatsApp no configurado. Requiere: 1) Sesión WhatsApp Web, 2) Puerto 3001 local, 3) QR escaneado. Ver docs/AGENTE_WHATSAPP.md' }),
  },

  whatsapp_recibir_mensaje: {
    description: '[FUTURO] Polling de mensajes entrantes. Para usar con webhook o polling local.',
    params: { type: 'OBJECT', properties: { since: { type: 'STRING', description: 'ISO timestamp' }, limit: { type: 'INTEGER' } } },
    fn: async () => ({ ok: false, error: 'Agente WhatsApp no configurado. Implementar: polling cada 5s o webhook en /api/whatsapp' }),
  },

  whatsapp_estado_conexion: {
    description: '[FUTURO] Verifica estado de conexión WhatsApp (conectado, QR pendiente, desconectado).',
    params: { type: 'OBJECT', properties: {} },
    fn: async () => ({ ok: false, error: 'Agente WhatsApp no configurado. Requiere servidor local con whatsapp-web.js' }),
  },

  notificar_push: {
    description: '[FUTURO] Envía push notification via Web Push / Firebase / OneSignal.',
    params: { type: 'OBJECT', properties: { suscripcion: { type: 'OBJECT' }, titulo: { type: 'STRING' }, cuerpo: { type: 'STRING' }, data: { type: 'OBJECT' } }, required: ['suscripcion', 'titulo', 'cuerpo'] },
    fn: async () => ({ ok: false, error: 'Push notifications no configurado. Requiere VAPID keys y service worker' }),
  },

  notificar_email: {
    description: '[FUTURO] Envía email via SendGrid / Resend / Nodemailer.',
    params: { type: 'OBJECT', properties: { to: { type: 'STRING' }, subject: { type: 'STRING' }, html: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['to', 'subject'] },
    fn: async () => ({ ok: false, error: 'Email no configurado. Requiere API key SendGrid/Resend en backend' }),
  },

  cocina_imprimir_ticket: {
    description: '[FUTURO] Imprime ticket en impresora térmica (ESC/POS) o envía a sistema de cocina.',
    params: { type: 'OBJECT', properties: { pedido: { type: 'OBJECT' }, impresora: { type: 'STRING' } }, required: ['pedido'] },
    fn: async () => ({ ok: false, error: 'Impresora cocina no configurada. Requiere: 1) Impresora ESC/POS USB/Red, 2) Driver local, 3) Formato ticket 80mm' }),
  },

  cocina_estado_pedido: {
    description: '[FUTURO] Consulta estado de pedido en cocina (pendiente, preparando, listo, entregado).',
    params: { type: 'OBJECT', properties: { numero_pedido: { type: 'STRING' } }, required: ['numero_pedido'] },
    fn: async () => ({ ok: false, error: 'Sistema de cocina no integrado. Requiere API cocina o base compartida' }),
  },

  analytics_registrar_evento: {
    description: '[FUTURO] Registra evento en analytics (Mixpanel, Amplitude, GA4, PostHog).',
    params: { type: 'OBJECT', properties: { evento: { type: 'STRING' }, propiedades: { type: 'OBJECT' }, user_id: { type: 'STRING' } }, required: ['evento'] },
    fn: async () => ({ ok: false, error: 'Analytics no configurado. Requiere API key y configuración de eventos' }),
  },

  analytics_obtener_metricas: {
    description: '[FUTURO] Consulta métricas agregadas (pedidos/día, ticket promedio, items top).',
    params: { type: 'OBJECT', properties: { desde: { type: 'STRING' }, hasta: { type: 'STRING' }, metrica: { type: 'STRING' } } },
    fn: async () => ({ ok: false, error: 'Analytics no configurado. Requiere backend con base de datos de pedidos' }),
  },

  cliente_buscar_o_crear: {
    description: '[FUTURO] Busca cliente por teléfono/email o crea nuevo. Historial de pedidos, preferencias.',
    params: { type: 'OBJECT', properties: { telefono: { type: 'STRING' }, email: { type: 'STRING' }, nombre: { type: 'STRING' } } },
    fn: async () => ({ ok: false, error: 'CRM clientes no configurado. Requiere base de datos (Supabase/Firebase/SQLite)' }),
  },

  cliente_historial: {
    description: '[FUTURO] Obtiene historial de pedidos de un cliente.',
    params: { type: 'OBJECT', properties: { cliente_id: { type: 'STRING' }, limite: { type: 'INTEGER' } }, required: ['cliente_id'] },
    fn: async () => ({ ok: false, error: 'Historial clientes no configurado. Requiere base de datos' }),
  },

  config_obtener: {
    description: '[FUTURO] Obtiene configuración remota (feature flags, precios dinámicos, horarios).',
    params: { type: 'OBJECT', properties: { clave: { type: 'STRING' } } },
    fn: async () => ({ ok: false, error: 'Config remota no configurada. Requiere: Firebase Remote Config / LaunchDarkly / Supabase' }),
  },
};

// Tool declarations for LLM (solo skills MVP habilitadas por defecto)
const TOOLS_MVP = [
  { functionDeclarations: [
    { name: 'buscar_en_catalogo', description: SKILLS.buscar_en_catalogo.description, parameters: SKILLS.buscar_en_catalogo.params },
    { name: 'verificar_stock', description: SKILLS.verificar_stock.description, parameters: SKILLS.verificar_stock.params },
    { name: 'calcular_total', description: SKILLS.calcular_total.description, parameters: SKILLS.calcular_total.params },
    { name: 'pedir_aclaracion', description: SKILLS.pedir_aclaracion.description, parameters: SKILLS.pedir_aclaracion.params },
    { name: 'confirmar_pedido', description: SKILLS.confirmar_pedido.description, parameters: SKILLS.confirmar_pedido.params },
  ]},
];

// Todas las tools (incluye futuras para agentes especializados)
const TOOLS_ALL = [
  { functionDeclarations: Object.entries(SKILLS).map(([name, s]) => ({ name, description: s.description, parameters: s.params })) },
];

/* ============================================================
   4. AGENT BASE CLASS
   ============================================================ */

class Agent {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.systemPrompt = config.systemPrompt;
    this.skills = config.skills || [];
    this.tools = config.tools || TOOLS_MVP;
    this.maxSteps = config.maxSteps || MAX_PASOS_AGENTE;
    this.enabled = config.enabled !== false;
    this.metadata = config.metadata || {};
  }

  getToolDeclarations() {
    const allowedSkills = new Set(this.skills);
    return this.tools.map(t => ({
      functionDeclarations: t.functionDeclarations.filter(fd => allowedSkills.has(fd.name))
    }));
  }

  async executeSkill(skillName, args, ctx, corrida) {
    const skill = SKILLS[skillName];
    if (!skill) throw new Error(`Skill desconocida: ${skillName}`);
    if (!this.skills.includes(skillName)) throw new Error(`Agente ${this.id} no tiene skill ${skillName}`);

    const t0 = performance.now();
    let response, ok = true;
    try {
      response = await skill.fn(args, ctx) || {};
      if (response.error || response.ok === false) ok = false;
    } catch (e) {
      response = { error: String(e?.message || e) };
      ok = false;
    }

    const ms = Math.round(performance.now() - t0);
    if (corrida && !corrida.silencioso) {
      addPaso(corrida, {
        tipo: 'tool', skill: skillName, titulo: `Skill: ${skillName}`, ok,
        io: { args, resultado: response }, meta: `${ms} ms · ${this.name}`,
      });
    }
    return response;
  }

  async run(corrida, ctx, input, tracePrefix = '') {
    if (!this.enabled) return { ok: false, error: `Agente ${this.id} deshabilitado` };

    const contents = [{ role: 'user', parts: [{ text: input }] }];

    for (let n = 1; n <= this.maxSteps; n++) {
      const t0 = performance.now();
      const data = await this.callLLM(contents);
      const ms = Math.round(performance.now() - t0);
      acumularTokens(corrida, data.usageMetadata);

      const parts = data.candidates[0]?.content?.parts || [];
      const pensamiento = parts.filter(p => p.thought && p.text).map(p => p.text).join('\n').trim();
      const libre = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n').trim();
      const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);

      if (!corrida.silencioso) {
        addPaso(corrida, {
          tipo: 'llm', titulo: `${tracePrefix}${this.name} · Razonamiento${calls.length ? ` · ${calls.length} tool call${calls.length > 1 ? 's' : ''}` : ''}`,
          texto: libre || null, pensamiento: pensamiento || null, meta: `${ms} ms · paso ${n}`,
        });
      }

      if (!calls.length) {
        ctx.textoFinal = libre || ctx.textoFinal;
        return { ok: true, output: libre };
      }

      contents.push({ role: 'model', parts });

      const respuestas = [];
      for (const call of calls) {
        const response = await this.executeSkill(call.name, call.args || {}, ctx, corrida);
        const part = { functionResponse: { name: call.name, response } };
        if (call.id) part.functionResponse.id = call.id;
        respuestas.push(part);
        if (ctx.confirmado || ctx.aclaracion) break;
      }
      contents.push({ role: 'user', parts: respuestas });

      if (ctx.confirmado || ctx.aclaracion) return { ok: true, output: ctx.confirmado ? 'confirmado' : 'aclaracion' };
    }

    return { ok: false, error: `Límite de ${this.maxSteps} pasos alcanzado en ${this.name}` };
  }

  async callLLM(contents) {
    return await llamarModelo(contents, this.getToolDeclarations(), this.systemPrompt());
  }
}

/* ============================================================
   5. AGENTES ESPECIALIZADOS (MVP)
   ============================================================ */

const agenteIntake = new Agent({
  id: 'intake',
  name: '🎙️ Receptor',
  description: 'Entiende el pedido crudo, extrae items, normaliza lenguaje, detecta intención',
  skills: ['buscar_en_catalogo', 'pedir_aclaracion'],
  systemPrompt: () => `Sos el RECEPTOR de pedidos de "${state.menu?.tienda?.nombre || 'Pizzería La Esquina'}".
Tu trabajo: convertir el texto libre del cliente en items estructurados del catálogo.

REGLAS:
1. Usá buscar_en_catalogo para cada item que detectés (tolerá alias: "muzza", "napo", "birra", "fugazzeta").
2. Si el cliente pide pizza SIN tamaño → pedí aclaración con pedir_aclaracion ("¿Chica, mediana o grande?").
3. Si no entendés un item o es ambiguo → pedí aclaración.
4. NO verifiques stock, NO calculés totales, NO confirmés. Eso lo hacen otros agentes.
5. Salida: lista de items detectados con {item_id, cantidad, variante_id?, extras[]} lista para el Validador.

EJEMPLOS:
- "dos muzza medianas y una coca" → 2x muzza (mediana), 1x coca
- "una fugazzeta grande con extra queso" → 1x fugazzeta (grande), extra: queso
- "quiero algo rico" → pedir_aclaracion("¿Qué te gustaría? Tenemos pizzas, empanadas, bebidas...")`,
  maxSteps: 4,
});

const agenteValidador = new Agent({
  id: 'validador',
  name: '✅ Validador',
  description: 'Verifica stock, valida reglas de negocio, calcula totales',
  skills: ['buscar_en_catalogo', 'verificar_stock', 'calcular_total', 'pedir_aclaracion'],
  systemPrompt: () => `Sos el VALIDADOR de pedidos de "${state.menu?.tienda?.nombre || 'Pizzería La Esquina'}".
Tu trabajo: recibir items estructurados, verificar stock y calcular total exacto.

REGLAS:
1. Para cada item: verificá stock con verificar_stock(cantidad).
2. Si no hay stock → pedir_aclaracion("De X quedan Y, ¿ajustamos?").
3. Calculá total con calcular_total (OBLIGATORIO). Valida tamaños, extras permitidos, stock.
4. Si calcular_total da problemas → pedir_aclaracion con el detalle.
5. NO confirmés el pedido. Solo validá y calculá.
6. Salida: {total: {...}, lineasValidadas: [...]} listo para Confirmador.

CATÁLOGO VIGENTE:
${state.menu?.items?.map(it => {
  const precios = it.variantes
    ? it.variantes.map(v => `${v.id} ${fmt(v.precio)}`).join(' / ')
    : `${fmt(it.precio)} por ${it.unidad || 'unidad'}`;
  return `- ${it.id}: ${it.nombre} (${precios}) stock ${it.stock}`;
}).join('\n') || 'Cargando...'}

EXTRAS: ${state.menu?.extras?.map(e => `${e.id}=${e.nombre} ${fmt(e.precio)}`).join('; ') || '...'}`,
  maxSteps: 6,
});

const agenteConfirmador = new Agent({
  id: 'confirmador',
  name: '🎫 Confirmador',
  description: 'Ejecuta confirmación final, genera número de pedido, notifica a cocina',
  skills: ['confirmar_pedido'],
  systemPrompt: () => `Sos el CONFIRMADOR de "${state.menu?.tienda?.nombre || 'Pizzería La Esquina'}".
Tu trabajo: confirmar pedidos YA VALIDADOS (requiere calcular_total previo exitoso).

REGLAS:
1. Solo ejecutá confirmar_pedido si el contexto tiene ctx.total válido.
2. Extraé datos del cliente del texto original (nombre, teléfono, dirección, notas).
3. Generá número de pedido y demora estimada.
4. Salida: confirmación completa para el cliente.`,
  maxSteps: 2,
});

const agenteAclarador = new Agent({
  id: 'aclarador',
  name: '❓ Aclarador',
  description: 'Maneja ambigüedades, preguntas al cliente, resolución de conflictos',
  skills: ['pedir_aclaracion', 'buscar_en_catalogo'],
  systemPrompt: () => `Sos el ACLARADOR de "${state.menu?.tienda?.nombre || 'Pizzería La Esquina'}".
Tu trabajo: cuando falta info crítica, preguntar al cliente de forma natural y resolver.

REGLAS:
1. Recibís el contexto del problema (qué falta, qué opciones hay).
2. Formulá pregunta clara, corta, en español rioplatense.
3. Ofrecé alternativas del catálogo si el item no existe.
4. Ejecutá pedir_aclaracion y TERMINÁ la corrida.
5. El orquestador re-ejecutará con la respuesta del cliente.`,
  maxSteps: 2,
});

/* ============================================================
   6. AGENTES FUTUROS (PRE-CABLEADOS - Deshabilitados por defecto)
   ============================================================ */

const agenteWhatsApp = new Agent({
  id: 'whatsapp',
  name: '💬 WhatsApp',
  description: 'Envía/recibe mensajes via WhatsApp Web API no oficial (whatsapp-web.js)',
  skills: ['whatsapp_enviar_mensaje', 'whatsapp_recibir_mensaje', 'whatsapp_estado_conexion', 'buscar_en_catalogo', 'pedir_aclaracion', 'confirmar_pedido'],
  systemPrompt: () => `Sos el AGENTE WHATSAPP de "${state.menu?.tienda?.nombre}".
Manejás la conversación completa por WhatsApp: recibís audio/texto, procesás pedido, respondés confirmación.

FLUJO:
1. whatsapp_recibir_mensaje → obtenés mensajes nuevos
2. Para cada mensaje: procesás como pedido (usás otros agentes internamente)
3. whatsapp_enviar_mensaje → respondés al cliente
4. Mantenés estado de sesión por número de teléfono

REQUIERE CONFIGURACIÓN EXTERNA:
- Servidor Node local puerto 3001 con whatsapp-web.js
- Sesión persistente (QR escaneado una vez)
- Webhook o polling cada 5s
Ver: docs/AGENTE_WHATSAPP.md`,
  maxSteps: 8,
  enabled: false,
  metadata: { requires: ['whatsapp-web.js server', 'persistent session', 'qr setup'], port: 3001 },
});

const agenteNotificaciones = new Agent({
  id: 'notificaciones',
  name: '🔔 Notificaciones',
  description: 'Push, Email, SMS, Webhooks para confirmaciones y alertas',
  skills: ['notificar_push', 'notificar_email', 'whatsapp_enviar_mensaje'],
  systemPrompt: () => `Sos el AGENTE NOTIFICACIONES. Enviás confirmaciones por múltiples canales.

CANALES DISPONIBLES (requieren config):
- Push: Web Push API (VAPID keys) / Firebase / OneSignal
- Email: SendGrid / Resend / Nodemailer (backend)
- WhatsApp: vía agente WhatsApp
- Webhook: POST a URL configurada

USO: El orquestador te invoca tras confirmar pedido con {pedido, cliente, canales[]}.`,
  maxSteps: 4,
  enabled: false,
  metadata: { requires: ['VAPID keys', 'SendGrid/Resend API', 'webhook URLs'] },
});

const agenteCocina = new Agent({
  id: 'cocina',
  name: '🍳 Cocina',
  description: 'Interfaz con impresora térmica / sistema de tickets de cocina',
  skills: ['cocina_imprimir_ticket', 'cocina_estado_pedido'],
  systemPrompt: () => `Sos el AGENTE COCINA. Gestionás tickets físicos y estado de preparación.

FUNCIONES:
- cocina_imprimir_ticket: imprime en impresora ESC/POS 80mm (USB/Red/Bluetooth)
- cocina_estado_pedido: consulta estado en sistema de cocina

REQUIERE:
- Impresora térmica compatible ESC/POS
- Driver local (Node: escpos, python: python-escpos)
- O API de sistema de cocina (KDS)
Ver: docs/AGENTE_COCINA.md`,
  maxSteps: 3,
  enabled: false,
  metadata: { requires: ['ESC/POS printer', 'local driver', 'or KDS API'] },
});

const agenteAnalytics = new Agent({
  id: 'analytics',
  name: '📊 Analytics',
  description: 'Métricas, eventos, dashboards, evaluación de performance',
  skills: ['analytics_registrar_evento', 'analytics_obtener_metricas'],
  systemPrompt: () => `Sos el AGENTE ANALYTICS. Registrás eventos y consultás métricas.

EVENTOS CLAVE:
- pedido_recibido, pedido_confirmado, pedido_cancelado
- aclaracion_requerida, stock_insuficiente
- latencia_orquestador, tokens_usados, costo_estimado

PROVEEDORES SOPORTADOS: Mixpanel, Amplitude, GA4, PostHog, custom (Supabase/ClickHouse).`,
  maxSteps: 3,
  enabled: false,
  metadata: { requires: ['Analytics API key', 'event schema defined'] },
});

const agenteClientes = new Agent({
  id: 'clientes',
  name: '👥 Clientes',
  description: 'CRM: búsqueda, historial, preferencias, fidelización',
  skills: ['cliente_buscar_o_crear', 'cliente_historial'],
  systemPrompt: () => `Sos el AGENTE CLIENTES. Gestionás identidad e historial.

FUNCIONES:
- cliente_buscar_o_crear: por teléfono/email → devuelve {cliente_id, nombre, preferencias, historial[]}
- cliente_historial: últimos N pedidos de un cliente

REQUIERE: Base de datos (Supabase, Firebase, SQLite, PostgreSQL) con tabla clientes y pedidos.`,
  maxSteps: 3,
  enabled: false,
  metadata: { requires: ['Database', 'clientes table', 'pedidos table with cliente_id FK'] },
});

const agenteConfig = new Agent({
  id: 'config',
  name: '⚙️ Config',
  description: 'Feature flags, precios dinámicos, horarios, promos remotas',
  skills: ['config_obtener'],
  systemPrompt: () => `Sos el AGENTE CONFIG. Obtenés configuración remota en runtime.

USOS:
- Precios dinámicos (happy hour, delivery fee)
- Feature flags (nuevo item habilitado, mantenimiento)
- Horarios especiales, feriados
- Promociones activas

PROVEEDORES: Firebase Remote Config, LaunchDarkly, Supabase Realtime, custom JSON endpoint.`,
  maxSteps: 2,
  enabled: false,
  metadata: { requires: ['Remote Config provider', 'feature flag schema'] },
});

/* ============================================================
   7. REGISTRO DE AGENTES
   ============================================================ */

const AGENTES_MVP = [agenteIntake, agenteValidador, agenteConfirmador, agenteAclarador];
const AGENTES_FUTUROS = [agenteWhatsApp, agenteNotificaciones, agenteCocina, agenteAnalytics, agenteClientes, agenteConfig];
const TODOS_AGENTES = [...AGENTES_MVP, ...AGENTES_FUTUROS];

const AGENTES_BY_ID = Object.fromEntries(TODOS_AGENTES.map(a => [a.id, a]));

/* ============================================================
   8. ORQUESTADOR REAL
   ============================================================ */

class Orquestador {
  constructor() {
    this.plan = null;
    this.contexto = null;
    this.corrida = null;
  }

  planificar(texto, contextoPrevio = {}) {
    const necesitaAclaracion = contextoPrevio.aclaracion || false;
    const tieneTotal = contextoPrevio.total !== undefined;

    let pasos = [];

    if (!contextoPrevio.itemsParseados) {
      pasos.push({ agente: 'intake', input: texto, descripcion: 'Parsear pedido crudo a items estructurados' });
    }

    pasos.push({ agente: 'validador', input: 'validar y calcular total', descripcion: 'Verificar stock y calcular total', requiere: ['intake'] });
    pasos.push({ agente: 'confirmador', input: 'confirmar pedido', descripcion: 'Generar número y confirmar', requiere: ['validador'] });

    const postAgentes = AGENTES_FUTUROS.filter(a => a.enabled);
    for (const ag of postAgentes) {
      pasos.push({ agente: ag.id, input: 'post-procesamiento', descripcion: `${ag.name}: ${ag.description}`, requiere: ['confirmador'], opcional: true });
    }

    this.plan = { pasos, textoOriginal: texto };
    return this.plan;
  }

  async ejecutar(texto, contextoPrevio = {}) {
    this.contexto = { ...contextoPrevio, textoOriginal: texto };
    this.planificar(texto, contextoPrevio);

    const resultados = {};

    for (const paso of this.plan.pasos) {
      const agente = AGENTES_BY_ID[paso.agente];
      if (!agente) { console.warn(`Agente ${paso.agente} no encontrado`); continue; }
      if (!agente.enabled && paso.opcional) {
        if (!this.corrida?.silencioso) addPaso(this.corrida, { tipo: 'info', titulo: `⏭️ Saltado: ${agente.name} (deshabilitado)`, meta: 'opcional', ok: true });
        continue;
      }

      const depsOk = (paso.requiere || []).every(dep => resultados[dep]?.ok);
      if (!depsOk) {
        if (!this.corrida?.silencioso) addPaso(this.corrida, { tipo: 'error', titulo: `❌ ${agente.name} saltado: dependencias no cumplidas`, meta: `requiere: ${paso.requiere?.join(', ')}`, ok: false });
        if (!paso.opcional) break;
        continue;
      }

      if (!this.corrida?.silencioso) addPaso(this.corrida, { tipo: 'agente', titulo: `🚀 Iniciando: ${agente.name}`, meta: paso.descripcion, ok: true });

      const input = typeof paso.input === 'function' ? paso.input(this.contexto) : paso.input;
      const resultado = await agente.run(this.corrida, this.contexto, input, `${agente.name} → `);

      resultados[paso.agente] = { ok: resultado.ok, output: resultado.output, error: resultado.error };

      if (!resultado.ok && !paso.opcional) {
        if (!this.corrida?.silencioso) addPaso(this.corrida, { tipo: 'error', titulo: `❌ ${agente.name} falló`, meta: resultado.error, ok: false });
        break;
      }

      if (this.contexto.aclaracion) break;
    }

    return { contexto: this.contexto, resultados, plan: this.plan };
  }
}

const orquestador = new Orquestador();

/* ============================================================
   9. SIMILITUD
   ============================================================ */

function similitud(a, b) {
  if (a === b) return 1;
  if (Math.abs(a.length - b.length) > 6) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[b.length] / Math.max(a.length, b.length);
}

/* ============================================================
   10. LLAMADA AL MODELO
   ============================================================ */

function promptSistemaBase() {
  const t = state.menu?.tienda || { nombre: 'Pizzería La Esquina', moneda: 'ARS', tiempoEstimadoMin: 30, horario: '19:00-23:00' };
  const catalogo = state.menu?.items?.map((it) => {
    const precios = it.variantes
      ? it.variantes.map((v) => `${v.id} ${fmt(v.precio)}`).join(' / ')
      : `${fmt(it.precio)} por ${it.unidad || 'unidad'}`;
    return `- ${it.id}: ${it.nombre} (${precios}) stock ${it.stock}`;
  }).join('\n') || 'Cargando...';

  return `Sos parte del sistema multi-agente de "${t.nombre}" (${t.moneda}, demora ${t.tiempoEstimadoMin} min, horario ${t.horario}).

CATÁLOGO VIGENTE:
${catalogo}

EXTRAS: ${state.menu?.extras?.map((e) => `${e.id} = ${e.nombre} ${fmt(e.precio)}`).join('; ') || '...'}

PRINCIPIOS:
- Usá SOLO las tools habilitadas para tu agente
- No inventés precios, items ni stock
- Sé breve, claro, español rioplatense
- Tu output es para el orquestador; el cliente recibe la confirmación final`;
}

async function extraerMensajeError(texto) {
  try { const j = JSON.parse(texto); return j.error?.message || texto.slice(0, 200); }
  catch { return texto.slice(0, 200); }
}

async function llamarModelo(contents, toolDeclarations, systemInstruction) {
  if (state.proveedor === 'gemini') {
    return await llamarGemini(contents, toolDeclarations, systemInstruction);
  } else {
    return await llamarOpenRouter(contents, toolDeclarations, systemInstruction);
  }
}

async function llamarGemini(contents, toolDeclarations, systemInstruction) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.modelo)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: toolDeclarations,
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${extraerMensajeError(t)}`); }
  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new Error('Bloqueado: ' + data.promptFeedback.blockReason);
  if (!data.candidates?.length) throw new Error('Sin candidatos');
  return data;
}

async function llamarOpenRouter(contents, toolDeclarations, systemInstruction) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const messages = contents.map(c => ({
    role: c.role === 'model' ? 'assistant' : c.role,
    content: c.parts.map(p => p.text || (p.functionCall ? JSON.stringify(p.functionCall) : '')).join('\n'),
    tool_calls: c.parts.filter(p => p.functionCall).map(p => ({
      id: p.functionCall.id || 'call_' + Date.now(),
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) },
    })),
  })).filter(m => m.content || m.tool_calls?.length);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.key_openrouter}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Pizzería La Esquina - Multi-Agent',
    },
    body: JSON.stringify({
      model: state.modelo_openrouter,
      messages,
      tools: toolDeclarations[0]?.functionDeclarations ? toolDeclarations : TOOLS_MVP,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 2048,
      system: systemInstruction,
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 200)}`); }
  const data = await res.json();
  if (!data.choices?.length) throw new Error('OpenRouter: respuesta vacía');
  const choice = data.choices[0];
  const parts = [];
  if (choice.message.content) parts.push({ text: choice.message.content });
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments), id: tc.id } });
    }
  }
  return {
    candidates: [{ content: { parts } }],
    usageMetadata: {
      promptTokenCount: data.usage?.prompt_tokens || 0,
      candidatesTokenCount: data.usage?.completion_tokens || 0,
      totalTokenCount: data.usage?.total_tokens || 0,
    },
  };
}

function acumularTokens(corrida, usage) {
  if (!usage) return;
  corrida.tokens.entrada += usage.promptTokenCount || 0;
  corrida.tokens.salida += (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  corrida.tokens.total += usage.totalTokenCount || 0;
}

/* ============================================================
   11. TRAZA & UI
   ============================================================ */

function nuevaCorrida(texto, modo) {
  return {
    id: 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fecha: new Date().toISOString(),
    texto, modo,
    modelo: modo === 'demo' ? 'simulado (reglas locales)' : `${state.proveedor}:${state.proveedor === 'gemini' ? state.modelo : state.modelo_openrouter}`,
    silencioso: false, estado: 'corriendo', duracion_ms: 0,
    pasos: [], tokens: { entrada: 0, salida: 0, total: 0 }, resultados: null,
  };
}

function ejecutarSkill(call, ctx, corrida) {
  const t0 = performance.now();
  let response;
  let ok = true;

  try {
    const fn = SKILLS[call.name];
    if (!fn) throw new Error(`Skill desconocida: ${call.name}`);
    response = fn.fn(call.args || {}, ctx) || {};
    if (response.error || response.ok === false) ok = false;
  } catch (e) {
    response = { error: String(e?.message || e) };
    ok = false;
  }

  const ms = Math.round(performance.now() - t0);
  if (corrida && !corrida.silencioso) {
    addPaso(corrida, {
      tipo: 'tool',
      skill: call.name,
      titulo: 'Skill',
      ok,
      io: { args: call.args || {}, resultado: response },
      meta: ms + ' ms',
    });
  }
  return response;
}

function addPaso(corrida, paso) {
  corrida.pasos.push(paso);
  if (corrida.silencioso) return;
  pintarPaso(paso, corrida.pasos.length);
  $('traza-vacia').classList.add('hidden');
  actualizarResumenTraza(corrida);
}

function pintarPaso(paso, n) {
  const li = document.createElement('li');
  li.className = 'paso';
  li.dataset.pasoNum = n;
  li.dataset.tipo = paso.tipo;
  li.dataset.agente = paso.agente || '';
  li.dataset.skill = paso.skill || '';

  const io = paso.io
    ? '<div class="io"><details><summary>argumentos</summary><pre>' + esc(JSON.stringify(paso.io.args, null, 2)) + '</pre></details><details><summary>resultado</summary><pre>' + esc(JSON.stringify(paso.io.resultado, null, 2)) + '</pre></details></div>'
    : '';

  const skillCode = paso.skill ? obtenerCodigoSkill(paso.skill) : '';

  li.innerHTML = `
    <div class="paso-head">
      <span class="paso-titulo"><span class="paso-n">${n}</span>${esc(paso.titulo)}</span>
      <span class="paso-meta">${esc(paso.meta || '')}${paso.ok === false ? ' · <span style="color:var(--err)">falló</span>' : ''}</span>
    </div>
    ${paso.pensamiento ? '<div class="paso-pensamiento">' + esc(paso.pensamiento) + '</div>' : ''}
    ${paso.texto ? '<div class="paso-texto">' + esc(paso.texto) + '</div>' : ''}
    ${io}
    ${skillCode ? '<details class="skill-code"><summary>📝 Código de ' + esc(paso.skill) + '</summary><pre>' + esc(skillCode) + '</pre></details>' : ''}
  `;

  if (paso.tipo === 'tool') {
    const tag = document.createElement('span');
    tag.className = 'tag-skill' + (paso.ok === false ? ' error' : ' ok');
    tag.textContent = paso.skill;
    const tituloSpan = li.querySelector('.paso-titulo');
    tituloSpan.appendChild(document.createTextNode(' '));
    tituloSpan.appendChild(tag);
  } else if (paso.tipo === 'agente') {
    const tag = document.createElement('span');
    tag.className = 'tag-agente';
    tag.textContent = paso.titulo.includes('Iniciando') ? '▶' : '✓';
    li.querySelector('.paso-titulo').prepend(tag);
  }

  $('timeline').appendChild(li);
  $('panel-traza').scrollTo?.(0, $('panel-traza').scrollHeight);
}

function obtenerCodigoSkill(nombre) {
  const skills = {
    'buscar_en_catalogo': 'async function buscar_en_catalogo(consulta) {\n  // Busca en catálogo por nombre, alias, descripción\n  // Tolerante a errores de transcripción (similitud > 0.7)\n  // Returns: {items: [{item_id, nombre, precio, stock, variantes[], extras_permitidos[]}]}',
    'verificar_stock': 'async function verificar_stock(item_id, cantidad) {\n  // Verifica disponibilidad para cantidad pedida\n  // Returns: {item_id, nombre, pedido, stock, disponible: boolean}',
    'calcular_total': 'async function calcular_total(lineas) {\n  // Valida pedido completo: items, tamaños, extras, stock\n  // Calcula precios, subtotales, total\n  // REQUERIDO antes de confirmar_pedido\n  // Returns: {lineas[], total, moneda, tiempo_estimado_min}',
    'pedir_aclaracion': 'async function pedir_aclaracion(pregunta) {\n  // Pregunta al cliente cuando falta dato esencial\n  // TERMINA la corrida actual\n  // Returns: {aclaracion: string}',
    'confirmar_pedido': 'async function confirmar_pedido(datos_cliente) {\n  // Confirma pedido YA VALIDADO (requiere calcular_total previo)\n  // Genera número pedido y demora\n  // Returns: {pedido, total, moneda, tiempo_estimado_min, mensaje}',
    'whatsapp_enviar_mensaje': '[FUTURO] Envía mensaje WhatsApp via whatsapp-web.js local server',
    'whatsapp_recibir_mensaje': '[FUTURO] Polling mensajes entrantes WhatsApp',
    'notificar_push': '[FUTURO] Push notification via Web Push / Firebase',
    'notificar_email': '[FUTURO] Email via SendGrid / Resend',
    'cocina_imprimir_ticket': '[FUTURO] Imprime ticket ESC/POS 80mm',
    'analytics_registrar_evento': '[FUTURO] Evento a Mixpanel/Amplitude/GA4',
    'cliente_buscar_o_crear': '[FUTURO] CRM: busca/crea cliente por teléfono',
  };
  return skills[nombre] || '';
}

function actualizarResumenTraza(corrida) {
  const tools = corrida.pasos.filter(p => p.tipo === 'tool');
  const llm = corrida.pasos.filter(p => p.tipo === 'llm');
  const agentes = corrida.pasos.filter(p => p.tipo === 'agente');
  const skillsUsadas = [...new Set(tools.map(p => p.skill).filter(Boolean))];
  const skillsOrden = tools.map(p => p.skill).filter(Boolean);
  const fallidas = tools.filter(p => p.ok === false).length;
  const tiempoTotal = corrida.duracion_ms || 0;

  const flujo = skillsOrden.length > 0
    ? skillsOrden.map((s, i) => '<span class="flujo-skill flujo-' + s.replace('_', '-') + '" title="' + s + '">' + (i + 1) + '. ' + s + '</span>').join('<span class="flecha">→</span>')
    : '<span class="muted">Sin skills ejecutadas</span>';

  const agentesEjecutados = [...new Set(agentes.map(p => {
    const m = p.titulo.match(/Iniciando: (.+?)(?: ·|$)/);
    return m ? m[1] : p.titulo.replace(/^[\s\S]*?Iniciando:\s*/, '').split(' ·')[0];
}).filter(Boolean))];

  const resumenHTML = `
    <div class="traza-resumen">
      <div class="resumen-grid">
        <div class="resumen-item"><span class="resumen-label">Duración total</span><span class="resumen-valor">${(tiempoTotal / 1000).toFixed(2)} s</span></div>
        <div class="resumen-item"><span class="resumen-label">Pasos totales</span><span class="resumen-valor">${corrida.pasos.length}</span></div>
        <div class="resumen-item"><span class="resumen-label">Llamadas LLM</span><span class="resumen-valor">${llm.length}</span></div>
        <div class="resumen-item"><span class="resumen-label">Agentes ejecutados</span><span class="resumen-valor">${agentesEjecutados.length}</span></div>
        <div class="resumen-item"><span class="resumen-label">Skills ejecutadas</span><span class="resumen-valor">${tools.length}${fallidas ? ' (' + fallidas + ' falló)' : ''}</span></div>
        <div class="resumen-item"><span class="resumen-label">Tokens</span><span class="resumen-valor">${corrida.tokens.total || '—'}</span></div>
        <div class="resumen-item"><span class="resumen-label">Entrada/Salida</span><span class="resumen-valor">${corrida.tokens.total ? corrida.tokens.entrada + '/' + corrida.tokens.salida : '—'}</span></div>
      </div>
      <div class="resumen-flujo"><span class="resumen-label">Flujo de skills:</span><div class="flujo-container">${flujo}</div></div>
      <div class="resumen-agentes"><span class="resumen-label">Agentes:</span>${agentesEjecutados.map(a => '<span class="agent-badge">' + esc(a) + '</span>').join(' ') || '<span class="muted">—</span>'}</div>
      <div class="resumen-skills"><span class="resumen-label">Skills únicas:</span>${skillsUsadas.map(s => '<span class="skill-badge skill-' + s.replace('_', '-') + '">' + s + '</span>').join(' ') || '<span class="muted">—</span>'}</div>
    </div>
  `;

  const existing = $('traza-resumen');
  if (existing) existing.remove();
  const container = document.createElement('div');
  container.id = 'traza-resumen';
  container.innerHTML = resumenHTML;
  $('panel-traza').insertBefore(container, $('timeline'));
}

function limpiarTraza() {
  $('timeline').innerHTML = '';
  $('metricas').classList.add('hidden');
  $('metricas').innerHTML = '';
  $('traza-vacia').classList.remove('hidden');
  const existing = $('traza-resumen');
  if (existing) existing.remove();
}

function pintarMetricas(corrida) {
  const tools = corrida.pasos.filter(p => p.tipo === 'tool');
  const llm = corrida.pasos.filter(p => p.tipo === 'llm');
  const fallidas = tools.filter(p => p.ok === false).length;
  const items = [
    ['duración', (corrida.duracion_ms / 1000).toFixed(2) + ' s'],
    ['pasos', String(corrida.pasos.length)],
    ['llamadas LLM', String(llm.length)],
    ['tool calls', tools.length + (fallidas ? ' (' + fallidas + ' falló)' : '')],
    ['tokens', corrida.tokens.total ? String(corrida.tokens.total) : '—'],
    ['entrada/salida', corrida.tokens.total ? corrida.tokens.entrada + '/' + corrida.tokens.salida : '—'],
  ];
  $('metricas').innerHTML = items.map(([k, v]) => '<div class="metrica"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>').join('');
  $('metricas').classList.remove('hidden');
}

/* ============================================================
   12. MODO DEMO (Simulador local sin API) - Multi-Agente
   ============================================================ */

const NUM = { un:1, una:1, uno:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9, diez:10, once:11, doce:12, quince:15, veinte:20, treinta:30, docena:12 };

function cantidadEn(fragmento) {
  const f = norm(fragmento);
  if (/\bmedia docena\b/.test(f)) return 6;
  if (/\bdocena\b/.test(f)) return 12;
  const digit = f.match(/(\d{1,3})\s*(?:x\b)?\s*$/);
  if (digit) return Math.min(99, parseInt(digit[1], 10));
  const words = f.split(' ').filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (/^\d{1,3}$/.test(words[i])) return Math.min(99, parseInt(words[i], 10));
    if (NUM[words[i]]) return NUM[words[i]];
  }
  return null;
}

function buscarTamanio(fragmento) {
  const f = norm(fragmento);
  if (/\bgrandes?\b|\bfamiliar\b|\b12 porciones\b/.test(f)) return 'grande';
  if (/\bmedianas?\b|\b8 porciones\b/.test(f)) return 'mediana';
  if (/\bchicas?\b|\bchiquitas?\b|\b6 porciones\b/.test(f)) return 'chica';
  return null;
}

function patronAlias(alias) {
  const cuerpo = alias.split(' ').filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?').join(' +');
  return new RegExp('(?:^|\\s)(' + cuerpo + ')(?=\\s|$)', 'g');
}

function mencionesDe(texto) {
  const out = [];
  for (const it of state.menu.items) {
    const alias = [...new Set([it.nombre, ...(it.alias || [])])].map(norm).filter(a => a.length >= 3);
    for (const a of alias) {
      const re = patronAlias(a);
      let m;
      while ((m = re.exec(texto))) {
        const frase = m[1];
        const start = m.index + (m[0].length - frase.length);
        out.push({ item: it, start, end: start + frase.length, len: frase.length, plural: /s$/.test(frase.split(' ')[0]) });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }
  return out;
}

function parsearPedido(texto) {
  const t = ' ' + norm(texto) + ' ';
  const crudos = mencionesDe(t);
  crudos.sort((x, y) => x.start - y.start || y.len - x.len);
  const elegidos = [];
  for (const m of crudos) {
    if (elegidos.some(p => m.start < p.end && m.end > p.start)) continue;
    if (elegidos.some(p => p.item.id === m.item.id)) continue;
    elegidos.push(m);
  }
  return elegidos.map((m, i) => {
    const prevEnd = i === 0 ? 0 : elegidos[i - 1].end;
    const nextStart = i + 1 < elegidos.length ? elegidos[i + 1].start : t.length;
    const antes = t.slice(prevEnd, m.start);
    const despues = t.slice(m.end, nextStart);
    let variante_id = null;
    if (m.item.variantes) {
      const v = buscarTamanio(despues) || buscarTamanio(antes.slice(-28));
      if (v) variante_id = v;
    }
    const extras = [];
    for (const ex of state.menu.extras) {
      if (!m.item.extrasPermitidos?.includes(ex.id)) continue;
      const alias = [...new Set([ex.nombre, ...(ex.alias || [])])].map(norm);
      if (alias.some(a => a.length >= 3 && despues.includes(a))) extras.push(ex.id);
    }
    const cantidadAntes = cantidadEn(antes);
    return {
      item: m.item, item_id: m.item.id, variante_id,
      cantidad: cantidadAntes ?? cantidadEn(despues.slice(0, 12)) ?? 1,
      cantidadExplicita: cantidadAntes != null, plural: m.plural, extras,
    };
  });
}

const CORTES_FRASE = new Set(['un','una','unos','unas','la','el','los','las','para','por','sin','con','favor']);
function esItemConocido(frase) {
  return state.menu.items.some(it => [it.nombre, ...(it.alias||[])].map(norm).some(n => n.length>=3 && (frase===n || frase.startsWith(n+' '))));
}
function detectarDesconocidos(texto) {
  const t = norm(texto); const out = []; const re = /(?:pizzas?|empanadas?)\s+de\s+([a-zñ0-9 ]{3,60})/g; let m;
  while ((m = re.exec(t))) {
    const palabras = m[1].split(' ').filter(Boolean).slice(0,5);
    let conocida = false, acumulado = '';
    for (const w of palabras) {
      acumulado = acumulado ? acumulado + ' ' + w : w;
      if (esItemConocido(acumulado)) { conocida = true; break; }
      if (CORTES_FRASE.has(w)) break;
    }
    if (!conocida) out.push(palabras[0]);
  }
  return [...new Set(out)];
}
function detectarCliente(texto) {
  const m = texto.match(/(?:a nombre de|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)/i);
  return m ? m[1].trim() : null;
}

async function correrDemo(corrida, ctx, texto) {
  const msBase = corrida.silencioso ? 0 : 80;
  const paso = async (p, ms = msBase) => { if (ms) await sleep(ms); addPaso(corrida, p); };

  await paso({ tipo: 'agente', titulo: '🚀 Iniciando: 🎙️ Receptor', meta: 'Parsear pedido crudo', ok: true });
  const lineas = parsearPedido(texto);

  await paso({ tipo: 'llm', titulo: '🎙️ Receptor · Interpretación', texto: lineas.length ? 'Detecté: ' + lineas.map(l => l.cantidad + '× ' + l.item.nombre + (l.variante_id ? ' (' + l.variante_id + ')' : '')).join(', ') + '.' : 'No reconocí items.', meta: 'reglas locales · sin API' });

  const desconocidos = detectarDesconocidos(texto);
  if (desconocidos.length) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Items desconocidos', ok: true });
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: 'No tenemos ' + desconocidos.join(', ') + ' en la carta. ¿Querés que te pase las opciones?' } }, ctx, corrida);
    return;
  }
  if (!lineas.length) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Pedido vacío', ok: true });
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: 'No pude identificar qué querés. ¿Me repetís los platos y cantidades?' } }, ctx, corrida);
    return;
  }

  ctx.itemsParseados = lineas;

  await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ✅ Validador', meta: 'Verificar stock y calcular total', ok: true });

  for (const l of lineas) {
    await ejecutarSkill({ name: 'buscar_en_catalogo', args: { consulta: l.item.nombre } }, ctx, corrida);
  }

  const sinTamanio = lineas.filter(l => l.item.variantes && !l.variante_id);
  if (sinTamanio.length) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Falta tamaño', ok: true });
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: sinTamanio.map(l => l.item.nombre).join(', ') + ': ¿la querés chica, mediana o grande?' } }, ctx, corrida);
    return;
  }

  const sinCantidad = lineas.filter(l => l.plural && !l.cantidadExplicita);
  if (sinCantidad.length) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Falta cantidad', ok: true });
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: '¿Cuántas ' + sinCantidad.map(l => l.item.nombre.replace(/^Empanada/, 'Empanadas').replace(/^Pizza/, 'Pizzas')).join(', ').toLowerCase() + ' querés?' } }, ctx, corrida);
    return;
  }

  for (const l of lineas) {
    const stock = await ejecutarSkill({ name: 'verificar_stock', args: { item_id: l.item_id, cantidad: l.cantidad } }, ctx, corrida);
    if (stock.disponible === false) {
      await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Stock insuficiente', ok: true });
      await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: 'De ' + l.item.nombre + ' quedan ' + stock.stock + ' y pediste ' + l.cantidad + '. ¿Ajustamos?' } }, ctx, corrida);
      return;
    }
  }

  const total = await ejecutarSkill({
    name: 'calcular_total',
    args: { lineas: lineas.map(l => ({ item_id: l.item_id, variante_id: l.variante_id || undefined, cantidad: l.cantidad, extras: l.extras })) },
  }, ctx, corrida);

  if (total.ok === false) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ❓ Aclarador', meta: 'Problemas en total', ok: true });
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta: (total.problemas || [total.error]).filter(Boolean).join(' ') + ' ¿Cómo lo resolvemos?' } }, ctx, corrida);
    return;
  }

  await paso({ tipo: 'agente', titulo: '🚀 Iniciando: 🎫 Confirmador', meta: 'Generar confirmación', ok: true });
  await ejecutarSkill({ name: 'confirmar_pedido', args: { nombre_cliente: detectarCliente(texto) || undefined } }, ctx, corrida);

  for (const ag of AGENTES_FUTUROS.filter(a => a.enabled)) {
    await paso({ tipo: 'agente', titulo: '🚀 Iniciando: ' + ag.name, meta: ag.description, ok: true });
    await sleep(50);
    addPaso(corrida, { tipo: 'info', titulo: '⏭️ ' + ag.name + ' simulado', meta: 'Habilitar en Configuración → Agentes Futuros', ok: true });
  }
}

/* ============================================================
   12.5. CONEXIÓN BACKEND (WebSocket)
   ============================================================ */

let ws = null;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT = 5;

function conectarBackend() {
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    try {
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('[WS] Conectado al backend');
        wsReconnectAttempts = 0;
        $('btn-enviar').disabled = false;
        resolve();
      };
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleBackendMessage(msg);
        } catch (e) {
          console.error('[WS] Error parseando mensaje:', e);
        }
      };
      
      ws.onclose = () => {
        console.log('[WS] Desconectado');
        if (wsReconnectAttempts < MAX_WS_RECONNECT) {
          wsReconnectAttempts++;
          setTimeout(conectarBackend, 1000 * wsReconnectAttempts);
        }
      };
      
      ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        reject(err);
      };
      
      // Timeout de conexión
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Timeout conectando al backend'));
        }
      }, 5000);
      
    } catch (e) {
      reject(e);
    }
  });
}

function enviarABackend(texto) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'text', text: texto }));
  } else {
    throw new Error('WebSocket no conectado');
  }
}

function responderAclaracionBackend(respuesta) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clarification_response', response: respuesta }));
  }
}

let backendCorrida = null;

function handleBackendMessage(msg) {
  const tipo = msg.type;
  
  if (tipo === 'trace') {
    const trace = msg.data;
    const eventType = trace.event_type;
    const agentId = trace.agent_id;
    const data = trace.data;
    
    // Update agencia tree if open
    if (typeof handleAgenciaTraceEvent === 'function') {
      handleAgenciaTraceEvent(trace);
    }
    
    // Update orchestrator trace tree
    if (typeof handleOrchestratorTraceEvent === 'function') {
      handleOrchestratorTraceEvent(trace);
    }
    
    let titulo = '';
    let meta = '';
    let pasoTipo = 'agente';
    
    switch (eventType) {
      case 'agent_activate':
        titulo = `▶ ${data.agent_name} iniciado`;
        meta = `args: ${JSON.stringify(data.args)}`;
        break;
      case 'agent_deactivate':
        titulo = `✓ ${data.agent_name} finalizado`;
        break;
      case 'handoff':
        titulo = `🔄 Handoff: ${data.from_agent} → ${data.to_agent}`;
        meta = `reason: ${data.reason} · type: ${data.type}`;
        pasoTipo = 'handoff';
        break;
      case 'skill_call':
        titulo = `🔧 Skill: ${data.skill_name}`;
        meta = `args: ${JSON.stringify(data.args)}`;
        pasoTipo = 'tool';
        break;
      case 'skill_result':
        titulo = `📋 Skill result: ${data.skill_name}`;
        let resultMeta = 'ok';
        if (data.success && data.data) {
          const dataStr = JSON.stringify(data.data);
          resultMeta = dataStr.length > 80 ? `ok: ${dataStr.substring(0, 80)}...` : `ok: ${dataStr}`;
        } else {
          resultMeta = `error: ${data.error}`;
        }
        meta = resultMeta;
        pasoTipo = 'tool';
        break;
      default:
        titulo = `📡 ${eventType}`;
        meta = JSON.stringify(data);
    }
    
    addPaso(backendCorrida, { 
      tipo: pasoTipo, 
      titulo: titulo, 
      meta: meta, 
      ok: eventType !== 'skill_result' || data.success,
      agente: agentId,
      skill: eventType === 'skill_call' || eventType === 'skill_result' ? data.skill_name : undefined
    });
  } else if (tipo === 'clarification') {
    // El backend pide aclaración
    if (backendCorrida) {
      addPaso(backendCorrida, { tipo: 'agente', titulo: '❓ Aclarador', meta: msg.question, ok: true });
      backendCorrida.resultado = { tipo: 'aclaracion', pregunta: msg.question };
      backendCorrida.estado = 'aclaracion';
      pintarResultado(backendCorrida.resultado);
      marcarEstado('aclaracion');
      state.ocupado = false;
      $('btn-enviar').disabled = false;
      $('hint-envio').textContent = '';
    }
  } else if (tipo === 'confirmation') {
    // Pedido confirmado
    if (backendCorrida) {
      const data = msg.data;
      addPaso(backendCorrida, { 
        tipo: 'agente', 
        titulo: '🎫 Confirmador', 
        meta: `Pedido ${data.pedido} confirmado · ${fmt(data.total)} · ${data.tiempo_estimado_min} min`,
        ok: true 
      });
      
      const res = {
        tipo: 'confirmado',
        numero: data.pedido,
        lineas: [], // El backend no envía líneas detalladas por ahora
        total: data.total,
        moneda: data.moneda,
        tiempo_estimado_min: data.tiempo_estimado_min,
        cliente: null,
        confirmado_en: new Date().toISOString()
      };
      
      backendCorrida.resultado = res;
      backendCorrida.estado = 'confirmado';
      pintarResultado(res);
      marcarEstado('confirmado');
      
      // TTS si viene del backend (mensaje separado tipo 'tts')
      state.ocupado = false;
      $('btn-enviar').disabled = false;
      $('hint-envio').textContent = '';
      $('btn-exportar').disabled = false; 
      $('btn-copiar').disabled = false;
      state.ultima = backendCorrida;
      guardarEnHistorial(backendCorrida);
    }
  } else if (tipo === 'tts') {
    // TTS del backend
    hablar(msg.text);
  } else if (tipo === 'error') {
    if (backendCorrida) {
      backendCorrida.estado = 'error';
      backendCorrida.resultado = { tipo: 'error', mensaje: msg.message };
      pintarResultado(backendCorrida.resultado);
      marcarEstado('error');
      state.ocupado = false;
      $('btn-enviar').disabled = false;
    }
  } else if (tipo === 'pong') {
    // Keepalive
  }
}

/* ============================================================
   13. EJECUCIÓN COMPLETA
   ============================================================ */

async function ejecutarPedido() {
  if (state.ocupado) return;
  const texto = $('transcripcion').value.trim();
  if (!texto) { $('hint-envio').textContent = 'Primero dictá o escribí el pedido.'; $('transcripcion').focus(); return; }

  const demo = $('chk-demo').checked;
  const useBackend = $('chk-backend').checked;
  
  if (!demo && !useBackend) {
    const tieneClave = state.proveedor === 'gemini' ? state.key : state.key_openrouter;
    if (!tieneClave) { mostrarAvisoClave(true); abrirConfig(); return; }
  }

  await cargarMenu().catch(() => null);
  if (!state.menu) { $('hint-envio').textContent = 'No se pudo cargar data/menu.json. Serví la carpeta por HTTP.'; return; }

  state.ocupado = true; state.pedidoTexto = texto;
  $('btn-enviar').disabled = true;
  $('hint-envio').textContent = useBackend 
    ? 'Conectando con backend…' 
    : (demo ? 'Corriendo orquestador multi-agente (simulado)…' : 'Consultando al modelo…');
  marcarEstado('corriendo');

  const corrida = nuevaCorrida(texto, useBackend ? 'backend' : (demo ? 'demo' : 'llm'));
  backendCorrida = corrida;
  const t0 = performance.now();

  limpiarTraza();
  $('resultado').className = 'resultado-vacio';
  $('resultado').innerHTML = '<p class="muted">El orquestador multi-agente está trabajando…</p>';

  try {
    if (useBackend) {
      // Conectar al backend y enviar
      await conectarBackend();
      addPaso(corrida, { tipo: 'agente', titulo: '🔗 Backend conectado', meta: 'WebSocket establecido', ok: true });
      enviarABackend(texto);
      // La respuesta se maneja via handleBackendMessage (async)
      return;
    }
    
    if (demo) {
      const ctx = { total: null, aclaracion: null, confirmado: null, textoFinal: null, itemsParseados: null };
      await correrDemo(corrida, ctx, texto);
      if (ctx.error) { corrida.estado = 'error'; corrida.resultado = { tipo: 'error', mensaje: ctx.error }; }
      else { corrida.resultado = ctx.confirmado || (ctx.aclaracion ? { tipo: 'aclaracion', pregunta: ctx.aclaracion } : { tipo: 'texto', texto: ctx.textoFinal }); corrida.estado = ctx.confirmado ? 'confirmado' : (ctx.aclaracion ? 'aclaracion' : 'sin_confirmar'); }
    } else {
      const resultado = await orquestador.ejecutar(texto, {});
      corrida.duracion_ms = Math.round(performance.now() - t0);
      if (resultado.contexto.error) { corrida.estado = 'error'; corrida.resultado = { tipo: 'error', mensaje: resultado.contexto.error }; }
      else { corrida.resultado = resultado.contexto.confirmado || (resultado.contexto.aclaracion ? { tipo: 'aclaracion', pregunta: resultado.contexto.aclaracion } : { tipo: 'texto', texto: resultado.contexto.textoFinal }); corrida.estado = resultado.contexto.confirmado ? 'confirmado' : (resultado.contexto.aclaracion ? 'aclaracion' : 'sin_confirmar'); }
    }
  } catch (e) {
    corrida.duracion_ms = Math.round(performance.now() - t0);
    corrida.estado = 'error';
    corrida.resultado = { tipo: 'error', mensaje: String(e?.message || e) };
    addPaso(corrida, { tipo: 'error', titulo: 'Error en orquestador', texto: String(e), ok: false, meta: 'abortado' });
  }

  if (!useBackend) {
    state.ocupado = false;
    $('btn-enviar').disabled = false;
    $('hint-envio').textContent = '';
    pintarMetricas(corrida);
    pintarResultado(corrida.resultado);
    marcarEstado(corrida.estado);
    $('btn-exportar').disabled = false; $('btn-copiar').disabled = false;
    state.ultima = corrida;
    guardarEnHistorial(corrida);
  }
}

/* ============================================================
   14. EVALUACIÓN
   ============================================================ */

async function cargarCasos() {
  if (state.casos) return state.casos;
  const res = await fetch('data/pedidos-prueba.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  state.casos = data.casos || [];
  return state.casos;
}

function firmaLineas(lineas) {
  return (lineas || []).map(l => {
    const extras = (l.extras || []).map(e => extraById(e)?.id || e).sort();
    return l.cantidad + 'x' + l.item_id + '/' + (l.variante_id || '-') + '/' + extras.join('+');
  }).sort().join(' | ');
}

function evaluarCaso(corrida, espera) {
  const r = corrida.resultado || {};
  if (corrida.estado !== espera.estado) return { ok: false, motivo: 'estado ' + corrida.estado + ', esperaba ' + espera.estado };
  if (espera.estado !== 'confirmado') return { ok: true, motivo: '' };
  if (r.total !== espera.total) return { ok: false, motivo: 'total ' + (r.total ?? '—') + ', esperaba ' + espera.total };
  if (firmaLineas(r.lineas) !== firmaLineas(espera.lineas)) return { ok: false, motivo: 'líneas no coinciden' };
  return { ok: true, motivo: '' };
}

function skillsDe(corrida) { return (corrida?.pasos || []).filter(p => p.tipo === 'tool').map(p => p.skill); }
function agentesDe(corrida) { return [...new Set((corrida?.pasos || []).filter(p => p.tipo === 'agente').map(p => p.titulo.match(/Iniciando: (.+?) ·/)?.[1]).filter(Boolean))]; }

function compararCorridas(a, b) {
  const sa = skillsDe(a), sb = skillsDe(b);
  const aa = agentesDe(a), ab = agentesDe(b);
  return { estado: a.estado === b.estado, total: (a.resultado?.total ?? null) === (b.resultado?.total ?? null), skills: sa.length === sb.length && sa.every((s, i) => s === sb[i]), agentes: aa.length === ab.length && aa.every((s, i) => s === ab[i]), skillsSim: sa, skillsModelo: sb, agentesSim: aa, agentesModelo: ab };
}

async function correrEvaluacion() {
  if (state.evaluando) { state.detenerEval = true; $('btn-eval').textContent = 'Deteniendo…'; return; }
  let casos;
  try { casos = await cargarCasos(); await cargarMenu(); }
  catch (e) { $('eval-progreso').textContent = 'Error: ' + e.message; return; }
  if (!casos.length) return;

  const conModelo = $('chk-eval-modelo').checked;
  const tieneClave = state.proveedor === 'gemini' ? state.key : state.key_openrouter;
  if (conModelo && !tieneClave) { $('eval-progreso').textContent = 'Falta clave de ' + state.proveedor + '. Solo simulador.'; $('chk-eval-modelo').checked = false; }

  state.evaluando = true; state.detenerEval = false;
  $('btn-eval').textContent = 'Detener';
  $('eval-resumen').classList.add('hidden'); $('eval-tabla-wrap').classList.add('hidden');

  const resultados = [];
  const usarModelo = $('chk-eval-modelo').checked;

  for (const [i, caso] of casos.entries()) {
    if (state.detenerEval) break;
    $('eval-progreso').textContent = 'Corriendo ' + (i + 1) + '/' + casos.length + ' · ' + caso.id + ' · simulador…';
    const sim = await correrCaso(caso.texto, 'demo');
    let modelo = null;
    if (usarModelo) {
      $('eval-progreso').textContent = 'Corriendo ' + (i + 1) + '/' + casos.length + ' · ' + caso.id + ' · modelo…';
      modelo = await correrCaso(caso.texto, 'llm');
    }
    resultados.push({ caso, sim, modelo });
    pintarEvaluacion(resultados, casos.length);
  }

  const cortado = state.detenerEval && resultados.length < casos.length;
  $('eval-progreso').textContent = cortado ? 'Detenido en ' + resultados.length + '/' + casos.length + ' casos.' : 'Listo: ' + resultados.length + ' casos ' + (usarModelo ? 'en dos modos' : '(solo simulador)') + '.';
  $('btn-eval').textContent = 'Correr de nuevo';
  $('btn-eval-exportar').disabled = false;
  state.eval = { fecha: new Date().toISOString(), proveedor: state.proveedor, modelo: usarModelo ? (state.proveedor === 'gemini' ? state.modelo : state.modelo_openrouter) : null, resultados };
  state.evaluando = false; state.detenerEval = false;
}

async function correrCaso(texto, modo) {
  const corrida = nuevaCorrida(texto, modo);
  corrida.silencioso = true;
  const ctx = { total: null, aclaracion: null, confirmado: null, textoFinal: null, error: null, itemsParseados: null };
  const t0 = performance.now();
  try {
    if (modo === 'demo') await correrDemo(corrida, ctx, texto);
    else {
      const resultado = await orquestador.ejecutar(texto, {});
      if (resultado.contexto.error) { ctx.error = resultado.contexto.error; }
      else { ctx.confirmado = resultado.contexto.confirmado; ctx.aclaracion = resultado.contexto.aclaracion; ctx.textoFinal = resultado.contexto.textoFinal; }
    }
  } catch (e) { ctx.error = String(e?.message || e); }
  return cerrarCorrida(corrida, ctx, t0);
}

function cerrarCorrida(corrida, ctx, t0) {
  corrida.duracion_ms = Math.round(performance.now() - t0);
  if (ctx.error) { corrida.estado = 'error'; corrida.resultado = { tipo: 'error', mensaje: ctx.error }; addPaso(corrida, { tipo: 'error', titulo: 'Error', texto: ctx.error, ok: false, meta: 'abortado' }); return corrida; }
  corrida.resultado = ctx.confirmado || (ctx.aclaracion ? { tipo: 'aclaracion', pregunta: ctx.aclaracion } : { tipo: 'texto', texto: ctx.textoFinal || 'Sin confirmar' });
  corrida.estado = ctx.confirmado ? 'confirmado' : (ctx.aclaracion ? 'aclaracion' : 'sin_confirmar');
  return corrida;
}

/* ============================================================
   15. RESULTADO & TTS
   ============================================================ */

function marcarEstado(estado) {
  const etiquetas = { corriendo: 'corriendo…', confirmado: 'confirmado', aclaracion: 'falta un dato', sin_confirmar: 'sin confirmar', error: 'error' };
  const badge = $('resultado-estado');
  badge.className = 'badge estado-' + estado;
  badge.textContent = etiquetas[estado] || estado;
}

function pintarResultado(res) {
  const box = $('resultado'); box.className = ''; box.innerHTML = '';
  if (!res) { box.className = 'resultado-vacio'; box.innerHTML = '<p class="muted">Sin resultado.</p>'; return; }

  if (res.tipo === 'confirmado') {
    const cliente = res.cliente || {};
    const datos = [cliente.nombre && 'Cliente: ' + cliente.nombre, cliente.direccion && 'Envío: ' + cliente.direccion, cliente.telefono && 'Tel: ' + cliente.telefono, cliente.notas && 'Nota: ' + cliente.notas].filter(Boolean).map(d => '<div class="small muted">' + esc(d) + '</div>').join('');
    const lineasTexto = res.lineas.map(l => l.cantidad + ' ' + l.nombre + (l.variante ? ' ' + l.variante : '') + (l.extras.length ? ' con ' + l.extras.join(', ') : '')).join(', ');
    const textoConfirmacion = 'Pedido ' + res.numero + ' confirmado. ' + lineasTexto + '. Total ' + fmt(res.total) + '. Demora estimada ' + res.tiempo_estimado_min + ' minutos.';

    box.innerHTML = '<div class="ticket"><div><div class="t-num">Pedido ' + esc(res.numero) + '</div><div class="t-meta">Confirmado · demora estimada ' + esc(res.tiempo_estimado_min) + ' min</div></div><span class="badge estado-confirmado">a cocina</span></div><ul class="lineas">' + res.lineas.map(l => '<li><span class="cant">' + esc(l.cantidad) + '×</span><span>' + esc(l.nombre) + (l.variante ? '<span class="detalle">' + esc(l.variante) + (l.extras.length ? ' · ' + esc(l.extras.join(', ')) : '') + '</span>' : (l.extras.length ? '<span class="detalle">' + esc(l.extras.join(', ')) + '</span>' : '')) + '</span><span class="precio">' + fmt(l.subtotal) + '</span></li>').join('') + '</ul><div class="total-row"><span>Total</span><strong>' + fmt(res.total) + '</strong></div>' + datos + '<div class="row" style="margin-top:8px"><button type="button" id="btn-hablar-confirmacion" class="ghost small">🔊 Hablar confirmación</button></div>';
    $('btn-hablar-confirmacion').addEventListener('click', () => hablar(textoConfirmacion));
    return;
  }

  if (res.tipo === 'aclaracion') {
    box.innerHTML = '<div class="aclaracion"><div class="pregunta">' + esc(res.pregunta) + '</div><div class="respuesta-row"><input type="text" id="input-respuesta" placeholder="Respondé acá…" autocomplete="off"><button type="button" id="btn-responder" class="primary">Responder</button></div><div class="row" style="margin-top:6px"><button type="button" id="btn-hablar-aclaracion" class="ghost small">🔊 Hablar pregunta</button></div><div class="small muted">La respuesta se agrega al pedido y el orquestador vuelve a correr.</div></div>';
    const input = $('input-respuesta');
    const useBackend = $('chk-backend').checked;
    const responder = () => { 
      const r = input.value.trim(); 
      if (!r) return; 
      if (useBackend && ws && ws.readyState === WebSocket.OPEN) {
        responderAclaracionBackend(r);
      } else {
        $('transcripcion').value = (state.pedidoTexto || $('transcripcion').value) + ' — ' + r; 
        ejecutarPedido(); 
      }
    };
    $('btn-responder').addEventListener('click', responder);
    $('btn-hablar-aclaracion').addEventListener('click', () => hablar(res.pregunta));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') responder(); });
    input.focus(); return;
  }

  if (res.tipo === 'error') { box.innerHTML = '<div class="error-box"><strong>No se pudo completar.</strong><br>' + esc(res.mensaje) + '</div>'; return; }
  box.innerHTML = '<div class="error-box">' + esc(res.texto || 'Sin confirmación') + '</div>';
}

/* ============================================================
   16. TTS
   ============================================================ */

async function hablar(texto) {
  if (!texto) return;
  switch (state.tts_engine) {
    case 'browser': return hablarNavegador(texto);
    case 'edge-tts': return hablarEdgeTTS(texto);
    case 'piper': return hablarPiper(texto);
    case 'coqui': return hablarCoqui(texto);
  }
}

function hablarNavegador(texto) {
  return new Promise((resolve, reject) => {
    const utter = new SpeechSynthesisUtterance(texto);
    utter.lang = 'es-AR'; utter.rate = state.tts_rate; utter.pitch = state.tts_pitch;
    if (state.tts_voice) { const voz = speechSynthesis.getVoices().find(v => v.name === state.tts_voice); if (voz) utter.voice = voz; }
    utter.onend = resolve; utter.onerror = reject; speechSynthesis.speak(utter);
  });
}

async function hablarEdgeTTS(texto) {
  try {
    const res = await fetch('https://api.edge-tts.com/v1/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texto, voice: state.edge_voice }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob(); const audio = new Audio(URL.createObjectURL(blob));
    return new Promise((resolve, reject) => { audio.onended = resolve; audio.onerror = reject; audio.play(); });
  } catch (e) { console.warn('Edge TTS falló:', e); return hablarNavegador(texto); }
}
async function hablarPiper(texto) { console.warn('Piper TTS requiere entorno local (Tauri/Electron/Node). Fallback.'); return hablarNavegador(texto); }
async function hablarCoqui(texto) { console.warn('Coqui TTS requiere Python local. Fallback.'); return hablarNavegador(texto); }

/* ============================================================
   17. CONFIGURACIÓN UI
   ============================================================ */

function abrirConfig() {
  $('select-proveedor').value = state.proveedor; toggleProveedorUI(state.proveedor);
  $('input-key-gemini').value = state.key;
  const selGemini = $('select-modelo-gemini'); selGemini.innerHTML = '';
  for (const m of MODELOS_GEMINI) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.label; selGemini.appendChild(opt); }
  selGemini.value = state.modelo;

  $('input-key-openrouter').value = state.key_openrouter; $('chk-openrouter-free-only').checked = state.openrouter_free_only; cargarModelosOpenRouter();

  $('select-tts-engine').value = state.tts_engine; toggleTtsUI(state.tts_engine); cargarVocesNavegador();
  $('input-tts-rate').value = state.tts_rate; $('tts-rate-value').textContent = state.tts_rate.toFixed(1);
  $('input-tts-pitch').value = state.tts_pitch; $('tts-pitch-value').textContent = state.tts_pitch.toFixed(1);
  $('input-edge-voice').value = state.edge_voice; cargarEdgeVoicesDatalist();
  $('input-piper-binary').value = state.piper_binary; $('input-piper-model').value = state.piper_model; $('input-piper-config').value = state.piper_config;
  $('input-coqui-model').value = state.coqui_model; $('input-coqui-speaker').value = state.coqui_speaker; $('input-coqui-language').value = state.coqui_language; cargarCoquiModelsDatalist();

  for (const ag of AGENTES_FUTUROS) { const chk = $('chk-agent-' + ag.id); if (chk) chk.checked = ag.enabled; }

  const dlg = $('dlg-config');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

function toggleProveedorUI(proveedor) {
  $('fieldset-gemini').classList.toggle('hidden', proveedor !== 'gemini');
  $('fieldset-openrouter').classList.toggle('hidden', proveedor !== 'openrouter');
  const key = proveedor === 'gemini' ? state.key : state.key_openrouter;
  mostrarAvisoClave(!key);
}

function toggleTtsUI(engine) {
  $('tts-browser').classList.toggle('hidden', engine !== 'browser');
  $('tts-edge').classList.toggle('hidden', engine !== 'edge-tts');
  $('tts-piper').classList.toggle('hidden', engine !== 'piper');
  $('tts-coqui').classList.toggle('hidden', engine !== 'coqui');
}

function mostrarAvisoClave(mostrar) {
  const b = $('aviso-clave');
  b.classList.toggle('hidden', !mostrar);
  if (mostrar) { const prov = state.proveedor === 'gemini' ? 'Gemini' : 'OpenRouter'; b.innerHTML = 'Falta la clave de ' + prov + '. Abrí <strong>Configurar</strong> y pegala, o activá <em>Simular modelo</em>.'; }
}

function actualizarBadge() {
  let label = 'sin clave · simulador';
  if (state.proveedor === 'gemini' && state.key) label = state.modelo.replace('gemini-', 'Gemini ');
  else if (state.proveedor === 'openrouter' && state.key_openrouter) label = state.modelo_openrouter || 'OpenRouter';
  $('modelo-badge').textContent = label;
}

async function cargarModelosOpenRouter() {
  const sel = $('select-modelo-openrouter'); const freeOnly = $('chk-openrouter-free-only').checked;
  sel.innerHTML = '<option value="">Cargando…</option>'; sel.disabled = true;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const modelos = (data.data || []).filter(m => freeOnly ? (m.pricing?.prompt === '0' && m.pricing?.completion === '0') : true).filter(m => m.id.includes('free') || m.pricing?.prompt === '0' || m.context_length >= 4096).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    sel.innerHTML = '';
    for (const m of modelos) { const opt = document.createElement('option'); opt.value = m.id; const precio = (m.pricing?.prompt === '0' && m.pricing?.completion === '0') ? ' (gratis)' : ''; opt.textContent = (m.name || m.id) + precio; sel.appendChild(opt); }
    if (state.modelo_openrouter) sel.value = state.modelo_openrouter;
  } catch (e) { sel.innerHTML = '<option value="">Error al cargar</option>'; console.warn('OpenRouter models:', e); }
  finally { sel.disabled = false; }
}

function cargarVocesNavegador() {
  const sel = $('select-tts-voice');
  const voces = speechSynthesis.getVoices().filter(v => v.lang.startsWith('es'));
  sel.innerHTML = '';
  if (voces.length === 0) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'Sin voces españolas (recargá la página o usá Chrome/Edge)'; opt.disabled = true; sel.appendChild(opt);
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = () => cargarVocesNavegador();
    return;
  }
  for (const v of voces) { const opt = document.createElement('option'); opt.value = v.name; opt.textContent = v.name + ' (' + v.lang + ')' + (v.default ? ' · default' : ''); sel.appendChild(opt); }
  if (state.tts_voice) sel.value = state.tts_voice; else if (voces.length) sel.value = voces[0].name;
}

function cargarEdgeVoicesDatalist() { const dl = $('edge-voices'); dl.innerHTML = ''; for (const v of EDGE_VOICES_ES) { const opt = document.createElement('option'); opt.value = v; dl.appendChild(opt); } }
function cargarCoquiModelsDatalist() { const dl = $('coqui-models'); dl.innerHTML = ''; for (const m of COQUI_MODELS_ES) { const opt = document.createElement('option'); opt.value = m; dl.appendChild(opt); } }

function initConfigHandlers() {
  $('select-proveedor').addEventListener('change', e => { state.proveedor = e.target.value; toggleProveedorUI(state.proveedor); if (state.proveedor === 'gemini') { const sel = $('select-modelo-gemini'); if (sel.options.length === 0) { for (const m of MODELOS_GEMINI) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.label; sel.appendChild(opt); } sel.value = state.modelo; } } else { cargarModelosOpenRouter(); } });

  $('chk-openrouter-free-only').addEventListener('change', () => { state.openrouter_free_only = $('chk-openrouter-free-only').checked; localStorage.setItem(LS.openrouter_free_only, state.openrouter_free_only); cargarModelosOpenRouter(); });

  $('select-tts-engine').addEventListener('change', e => { state.tts_engine = e.target.value; localStorage.setItem(LS.tts_engine, state.tts_engine); toggleTtsUI(state.tts_engine); });

  $('input-tts-rate').addEventListener('input', e => { state.tts_rate = parseFloat(e.target.value); $('tts-rate-value').textContent = state.tts_rate.toFixed(1); localStorage.setItem(LS.tts_rate, state.tts_rate); });
  $('input-tts-pitch').addEventListener('input', e => { state.tts_pitch = parseFloat(e.target.value); $('tts-pitch-value').textContent = state.tts_pitch.toFixed(1); localStorage.setItem(LS.tts_pitch, state.tts_pitch); });
  $('select-tts-voice').addEventListener('change', e => { state.tts_voice = e.target.value; localStorage.setItem(LS.tts_voice, state.tts_voice); });
  $('input-edge-voice').addEventListener('change', e => { state.edge_voice = e.target.value; localStorage.setItem(LS.edge_voice, state.edge_voice); });
  $('input-piper-binary').addEventListener('change', e => { state.piper_binary = e.target.value; localStorage.setItem(LS.piper_binary, state.piper_binary); });
  $('input-piper-model').addEventListener('change', e => { state.piper_model = e.target.value; localStorage.setItem(LS.piper_model, state.piper_model); });
  $('input-piper-config').addEventListener('change', e => { state.piper_config = e.target.value; localStorage.setItem(LS.piper_config, state.piper_config); });
  $('input-coqui-model').addEventListener('change', e => { state.coqui_model = e.target.value; localStorage.setItem(LS.coqui_model, state.coqui_model); });
  $('input-coqui-speaker').addEventListener('change', e => { state.coqui_speaker = e.target.value; localStorage.setItem(LS.coqui_speaker, state.coqui_speaker); });
  $('input-coqui-language').addEventListener('change', e => { state.coqui_language = e.target.value; localStorage.setItem(LS.coqui_language, state.coqui_language); });

  $('btn-tts-test').addEventListener('click', () => hablar('Hola, soy la voz del asistente.'));
  $('btn-edge-tts-test').addEventListener('click', () => hablarEdgeTTS('Hola, voz Edge TTS.'));
  $('btn-piper-test').addEventListener('click', () => hablarPiper('Hola, voz Piper.'));
  $('btn-coqui-test').addEventListener('click', () => hablarCoqui('Hola, voz Coqui.'));

  $('btn-piper-install').addEventListener('click', () => { $('piper-status').textContent = 'Piper: `cargo install piper-tts` o descargar binario de GitHub Releases.'; });
  $('btn-piper-download-model').addEventListener('click', async () => {
    $('piper-status').textContent = 'Descargando modelo español…';
    try { const url = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx'; const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status); const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'es_ES-carlfm-x_low.onnx'; a.click(); $('piper-status').textContent = 'Modelo descargado. Pon la ruta en "Modelo de voz .onnx".'; } catch (e) { $('piper-status').textContent = 'Error: ' + e.message; } });
  $('btn-coqui-install').addEventListener('click', () => { $('coqui-status').textContent = 'Coqui: `pip install coqui-tts` (Python 3.8+).'; });

  for (const ag of AGENTES_FUTUROS) {
    const chk = $('chk-agent-' + ag.id);
    if (chk) chk.addEventListener('change', e => { ag.enabled = e.target.checked; localStorage.setItem('pizzeria_agent_' + ag.id + '_enabled', ag.enabled); actualizarAgentesUI(); });
  }
}

function actualizarAgentesUI() {
  for (const ag of AGENTES_FUTUROS) { const chk = $('chk-agent-' + ag.id); if (chk) chk.checked = ag.enabled; }
}

function guardarConfig() {
  state.proveedor = $('select-proveedor').value; localStorage.setItem(LS.proveedor, state.proveedor);
  state.key = $('input-key-gemini').value.trim(); state.modelo = $('select-modelo-gemini').value;
  if (state.key) localStorage.setItem(LS.key_gemini, state.key); else localStorage.removeItem(LS.key_gemini);
  localStorage.setItem(LS.modelo_gemini, state.modelo);

  state.key_openrouter = $('input-key-openrouter').value.trim(); state.modelo_openrouter = $('select-modelo-openrouter').value; state.openrouter_free_only = $('chk-openrouter-free-only').checked;
  if (state.key_openrouter) localStorage.setItem(LS.key_openrouter, state.key_openrouter); else localStorage.removeItem(LS.key_openrouter);
  localStorage.setItem(LS.modelo_openrouter, state.modelo_openrouter); localStorage.setItem(LS.openrouter_free_only, state.openrouter_free_only);

  state.tts_engine = $('select-tts-engine').value; state.tts_voice = $('select-tts-voice').value; state.tts_rate = parseFloat($('input-tts-rate').value); state.tts_pitch = parseFloat($('input-tts-pitch').value);
  state.edge_voice = $('input-edge-voice').value; state.piper_binary = $('input-piper-binary').value; state.piper_model = $('input-piper-model').value; state.piper_config = $('input-piper-config').value;
  state.coqui_model = $('input-coqui-model').value; state.coqui_speaker = $('input-coqui-speaker').value; state.coqui_language = $('input-coqui-language').value;
  localStorage.setItem(LS.tts_engine, state.tts_engine); localStorage.setItem(LS.tts_voice, state.tts_voice); localStorage.setItem(LS.tts_rate, state.tts_rate); localStorage.setItem(LS.tts_pitch, state.tts_pitch);
  localStorage.setItem(LS.edge_voice, state.edge_voice); localStorage.setItem(LS.piper_binary, state.piper_binary); localStorage.setItem(LS.piper_model, state.piper_model); localStorage.setItem(LS.piper_config, state.piper_config);
  localStorage.setItem(LS.coqui_model, state.coqui_model); localStorage.setItem(LS.coqui_speaker, state.coqui_speaker); localStorage.setItem(LS.coqui_language, state.coqui_language);

  for (const ag of AGENTES_FUTUROS) { localStorage.setItem('pizzeria_agent_' + ag.id + '_enabled', ag.enabled); }

  actualizarBadge(); mostrarAvisoClave(state.proveedor === 'gemini' ? !state.key : !state.key_openrouter); $('dlg-config').close();
}

function cargarConfigGuardada() {
  state.key = localStorage.getItem(LS.key_gemini) || ''; state.modelo = localStorage.getItem(LS.modelo_gemini) || 'gemini-3.5-flash-lite';
  state.proveedor = localStorage.getItem(LS.proveedor) || 'gemini';
  state.key_openrouter = localStorage.getItem(LS.key_openrouter) || ''; state.modelo_openrouter = localStorage.getItem(LS.modelo_openrouter) || ''; state.openrouter_free_only = localStorage.getItem(LS.openrouter_free_only) !== 'false';
  state.tts_engine = localStorage.getItem(LS.tts_engine) || 'browser'; state.tts_voice = localStorage.getItem(LS.tts_voice) || ''; state.tts_rate = parseFloat(localStorage.getItem(LS.tts_rate) || '1'); state.tts_pitch = parseFloat(localStorage.getItem(LS.tts_pitch) || '1');
  state.edge_voice = localStorage.getItem(LS.edge_voice) || 'es-AR-ElenaNeural'; state.piper_binary = localStorage.getItem(LS.piper_binary) || 'piper'; state.piper_model = localStorage.getItem(LS.piper_model) || ''; state.piper_config = localStorage.getItem(LS.piper_config) || '';
  state.coqui_model = localStorage.getItem(LS.coqui_model) || 'tts_models/es/css10/vits'; state.coqui_speaker = localStorage.getItem(LS.coqui_speaker) || ''; state.coqui_language = localStorage.getItem(LS.coqui_language) || 'es';

  for (const ag of AGENTES_FUTUROS) { ag.enabled = localStorage.getItem('pizzeria_agent_' + ag.id + '_enabled') === 'true'; }
}

function initEjemplos() {
  const sel = $('select-ejemplo');
  for (const [i, ej] of EJEMPLOS.entries()) { const opt = document.createElement('option'); opt.value = String(i); opt.textContent = ej; sel.appendChild(opt); }
  sel.addEventListener('change', () => { const i = sel.value; if (i === '') return; $('transcripcion').value = EJEMPLOS[Number(i)]; $('hint-envio').textContent = ''; sel.value = ''; });
}

const EJEMPLOS = ['Hola, quiero dos pizzas de muzza medianas y una coca de litro y medio.', 'Una napolitana grande con extra queso y cuatro empanadas de carne.', 'Quiero una pizza de fugazzeta.', 'Dos muzza grandes y tres empanadas de pollo, una cerveza.', 'Veinte pizzas de rúcula grandes.', 'Quiero una pizza de anchoas y una de muzza chica.', 'Mmm, quiero pedir algo rico.', 'Hola, una grande de muzza, dos empanadas de jamón y queso y una coca lata. Soy Martín.'];

/* ============================================================
   18. EXPORTAR / HISTORIAL
   ============================================================ */

function descargarCorrida() { if (!state.ultima) return; const blob = new Blob([JSON.stringify(state.ultima, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'corrida-' + state.ultima.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
async function copiarCorrida() { if (!state.ultima) return; const txt = JSON.stringify(state.ultima, null, 2); try { await navigator.clipboard.writeText(txt); $('btn-copiar').textContent = 'Copiado'; setTimeout(() => { $('btn-copiar').textContent = 'Copiar'; }, 1400); } catch { $('hint-envio').textContent = 'No se pudo copiar. Usá Exportar JSON.'; } }

function exportarEvaluacion() {
  if (!state.eval) return;
  const salida = { ...state.eval, resumen: { casos: state.eval.resultados.length, aciertos_simulador: state.eval.resultados.filter(r => evaluarCaso(r.sim, r.caso.espera).ok).length, aciertos_modelo: state.eval.resultados.filter(r => r.modelo && evaluarCaso(r.modelo, r.caso.espera).ok).length, mismo_estado: state.eval.resultados.filter(r => r.modelo && compararCorridas(r.sim, r.modelo).estado).length, misma_secuencia_skills: state.eval.resultados.filter(r => r.modelo && compararCorridas(r.sim, r.modelo).skills).length, misma_secuencia_agentes: state.eval.resultados.filter(r => r.modelo && compararCorridas(r.sim, r.modelo).agentes).length }, detalle: state.eval.resultados.map(r => ({ caso: r.caso, simulador: { estado: r.sim.estado, duracion_ms: r.sim.duracion_ms, skills: skillsDe(r.sim), agentes: agentesDe(r.sim), resultado: r.sim.resultado }, modelo: r.modelo ? { estado: r.modelo.estado, duracion_ms: r.modelo.duracion_ms, skills: skillsDe(r.modelo), agentes: agentesDe(r.modelo), tokens: r.modelo.tokens, resultado: r.modelo.resultado } : null })) };
  const blob = new Blob([JSON.stringify(salida, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'evaluacion-' + Date.now() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const MAX_HIST = 15;
function guardarEnHistorial(corrida) { state.historial.unshift(corrida); state.historial = state.historial.slice(0, MAX_HIST); try { localStorage.setItem(LS.hist, JSON.stringify(state.historial)); } catch (e) { console.warn('Historial:', e); } pintarHistorial(); }
function cargarHistorial() { try { const raw = localStorage.getItem(LS.hist); state.historial = raw ? JSON.parse(raw) : []; if (!Array.isArray(state.historial)) state.historial = []; } catch { state.historial = []; } pintarHistorial(); }
function pintarHistorial() { const ul = $('historial'); ul.innerHTML = ''; $('historial-vacio').classList.toggle('hidden', state.historial.length > 0); for (const c of state.historial) { const li = document.createElement('li'); const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'hist-item'; const recorte = c.texto.length > 58 ? c.texto.slice(0, 58) + '…' : c.texto; btn.innerHTML = '<span><span class="punto ' + esc(c.estado) + '"></span>' + esc(recorte) + '</span><span class="hist-meta">' + esc(c.estado) + ' · ' + (c.duracion_ms / 1000).toFixed(1) + 's</span>'; btn.addEventListener('click', () => { state.ultima = c; $('transcripcion').value = c.texto; limpiarTraza(); $('timeline').innerHTML = ''; for (const [i, p] of c.pasos.entries()) pintarPaso(p, i + 1); if (c.pasos.length) $('traza-vacia').classList.add('hidden'); pintarMetricas(c); pintarResultado(c.resultado); marcarEstado(c.estado); $('btn-exportar').disabled = false; $('btn-copiar').disabled = false; }); li.appendChild(btn); ul.appendChild(li); } }

/* ============================================================
   19. MICRÓFONO
   ============================================================ */

function initMicrofono() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const btn = $('btn-mic');
  if (!SR) { $('mic-estado').textContent = 'Dictado no disponible'; $('mic-detalle').textContent = 'Este navegador no soporta Web Speech API. Escribí a mano.'; btn.disabled = true; return; }
  const rec = new SR(); rec.lang = 'es-AR'; rec.continuous = true; rec.interimResults = true; state.reconocimiento = rec; let base = '';
  rec.onstart = () => { state.grabando = true; btn.classList.add('grabando'); btn.querySelector('.mic-label').textContent = 'Detener'; $('mic-estado').textContent = 'Escuchando…'; $('mic-detalle').textContent = 'Hablá con naturalidad. Podés dictar y corregir antes de enviar.'; };
  rec.onresult = ev => { let final = '', interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript; } if (final) base = (base + ' ' + final).replace(/\s+/g, ' ').trim(); $('transcripcion').value = (base + ' ' + interim).trim(); };
  rec.onerror = ev => { const mensajes = { 'not-allowed': 'Permiso denegado. Habilitalo en el candado de la barra.', 'no-speech': 'No se escuchó nada. Probá más cerca.', network: 'Reconocimiento necesita internet.', 'audio-capture': 'Sin micrófono.' }; $('mic-estado').textContent = 'No se pudo grabar'; $('mic-detalle').textContent = mensajes[ev.error] || 'Error: ' + ev.error; try { rec.stop(); } catch (_) {} state.grabando = false; btn.classList.remove('grabando'); btn.querySelector('.mic-label').textContent = 'Grabar'; };
  rec.onend = () => { state.grabando = false; btn.classList.remove('grabando'); btn.querySelector('.mic-label').textContent = 'Grabar'; $('mic-estado').textContent = 'Micrófono listo'; $('mic-detalle').textContent = 'Revisá el texto y envialo.'; };
  btn.addEventListener('click', () => { if (state.grabando) { rec.stop(); return; } base = $('transcripcion').value.trim(); try { rec.start(); } catch (e) { $('mic-detalle').textContent = 'Error iniciando: ' + e.message; } });
}

/* ============================================================
   20. ESTADO GLOBAL & INIT
   ============================================================ */

const state = {
  menu: null,
  key: '', modelo: 'gemini-3.5-flash-lite',
  proveedor: 'gemini', key_openrouter: '', modelo_openrouter: '', openrouter_free_only: true,
  tts_engine: 'browser', tts_voice: '', tts_rate: 1.0, tts_pitch: 1.0,
  edge_voice: 'es-AR-ElenaNeural', piper_binary: 'piper', piper_model: '', piper_config: '',
  coqui_model: 'tts_models/es/css10/vits', coqui_speaker: '', coqui_language: 'es',
  historial: [], ultima: null, ocupado: false, grabando: false, reconocimiento: null,
  pedidoTexto: '', casos: null, eval: null, evaluando: false, detenerEval: false,
};

function init() {
  cargarConfigGuardada(); actualizarAgentesUI();
  actualizarBadge(); mostrarAvisoClave(state.proveedor === 'gemini' ? !state.key : !state.key_openrouter);
  cargarHistorial(); initEjemplos(); initMicrofono(); initConfigHandlers(); limpiarTraza();
  cargarMenu().then(menu => { $('tienda-nombre').textContent = menu.tienda.nombre; document.title = menu.tienda.nombre + ' — pedidos por voz'; $('horario').textContent = 'Abierto ' + menu.tienda.horario + ' · ' + menu.tienda.moneda; mostrarAvisoClave(state.proveedor === 'gemini' ? !state.key : !state.key_openrouter); }).catch(() => { const b = $('aviso-clave'); b.classList.remove('hidden'); b.innerHTML = 'No se pudo leer <code>data/menu.json</code>. Serví por HTTP: <code>python -m http.server 8080</code>.'; });
  $('btn-config').addEventListener('click', abrirConfig);
  $('btn-agencia').addEventListener('click', abrirAgencia);
  $('btn-orchestrator-trace').addEventListener('click', abrirOrchestratorTrace);
  $('form-config').addEventListener('submit', e => { e.preventDefault(); guardarConfig(); });
  $('btn-borrar-key').addEventListener('click', () => { state.key = ''; state.key_openrouter = ''; localStorage.removeItem(LS.key_gemini); localStorage.removeItem(LS.key_openrouter); $('input-key-gemini').value = ''; $('input-key-openrouter').value = ''; actualizarBadge(); mostrarAvisoClave(true); });
  $('chk-demo').addEventListener('change', e => { if (e.target.checked) { mostrarAvisoClave(false); $('hint-envio').textContent = 'Modo simulado: orquestador multi-agente con reglas locales.'; } else { mostrarAvisoClave(state.proveedor === 'gemini' ? !state.key : !state.key_openrouter); $('hint-envio').textContent = ''; } });
  $('btn-enviar').addEventListener('click', ejecutarPedido);
  $('transcripcion').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ejecutarPedido(); } });
  $('btn-exportar').addEventListener('click', descargarCorrida); $('btn-copiar').addEventListener('click', copiarCorrida);
  $('btn-eval').addEventListener('click', correrEvaluacion); $('btn-eval-exportar').addEventListener('click', exportarEvaluacion);
  $('btn-borrar-historial').addEventListener('click', () => { if (!state.historial.length) return; if (!confirm('¿Borrar historial?')) return; state.historial = []; localStorage.removeItem(LS.hist); pintarHistorial(); });
}

/* ============================================================
   AGENCIA — ÁRBOL DEL ORQUESTADOR (MVP: visualización real)
   ============================================================ */

const AGENCIA_NODES = {
  orchestrator: {
    id: 'orchestrator',
    type: 'orchestrator',
    name: '🎭 Orquestador',
    icon: '🎭',
    description: 'Recibe pedido → Decide flujo → Coordina agentes',
    children: ['intake', 'validator', 'clarifier', 'confirmer', 'decidir_siguiente_agente', 'evaluar_completitud_pedido', 'manejar_error_global', 'gestionar_timeouts', 'persistir_contexto', 'config_obtener'],
    status: 'pending',
    enabled: true
  },
  intake: {
    id: 'intake',
    type: 'agent',
    name: '🎙️ Receptor (Intake)',
    icon: '🎙️',
    description: 'Parsea texto libre → Items estructurados',
    skills: ['buscar_en_catalogo', 'extraer_items', 'detectar_cantidad', 'detectar_variante', 'pedir_aclaracion', 'cliente_buscar_o_crear', 'cliente_historial', 'whatsapp_enviar_mensaje', 'whatsapp_recibir_mensaje'],
    parent: 'orchestrator',
    status: 'pending',
    enabled: true
  },
  validator: {
    id: 'validator',
    type: 'agent',
    name: '✅ Validador',
    icon: '✅',
    description: 'Verifica stock → Calcula total exacto',
    skills: ['verificar_stock', 'calcular_total', 'validar_pedido_completo', 'verificar_extras_permitidos', 'calcular_tiempo_estimado', 'analytics_obtener_metricas', 'cocina_imprimir_ticket', 'cocina_estado_pedido'],
    parent: 'orchestrator',
    status: 'pending',
    enabled: true
  },
  clarifier: {
    id: 'clarifier',
    type: 'agent',
    name: '❓ Aclarador',
    icon: '❓',
    description: 'Pregunta al cliente cuando falta info crítica',
    skills: ['pedir_aclaracion', 'buscar_en_catalogo', 'generar_pregunta_tamaño', 'generar_pregunta_cantidad', 'generar_pregunta_item_desconocido', 'generar_pregunta_stock_bajo', 'generar_pregunta_extras', 'generar_pregunta_modificacion'],
    parent: 'orchestrator',
    status: 'pending',
    enabled: true
  },
  confirmer: {
    id: 'confirmer',
    type: 'agent',
    name: '🎫 Confirmador',
    icon: '🎫',
    description: 'Confirma pedido validado → Genera nº pedido',
    skills: ['confirmar_pedido', 'formatear_confirmacion_usuario', 'generar_numero_pedido', 'calcular_demora_entrega', 'formatear_ticket_cocina', 'enviar_notificacion_cliente', 'imprimir_ticket_cocina', 'registrar_pedido_bd', 'registrar_evento_analytics', 'analytics_registrar_evento', 'analytics_obtener_metricas', 'cocina_imprimir_ticket', 'cocina_estado_pedido', 'notificar_push', 'notificar_email'],
    parent: 'orchestrator',
    status: 'pending',
    enabled: true
  },
  // Skills MVP (habilitados)
  buscar_en_catalogo: { id: 'buscar_en_catalogo', type: 'skill', name: '🔍 Buscar en catálogo', icon: '🔍', parent: 'intake', status: 'pending', enabled: true, description: 'Busca items en catálogo por nombre/alias' },
  detectar_cantidad: { id: 'detectar_cantidad', type: 'skill', name: '🔢 Detectar cantidad', icon: '🔢', parent: 'intake', status: 'pending', enabled: true, description: 'Extrae cantidad de texto (dos, tres, un par, 3)' },
  detectar_variante: { id: 'detectar_variante', type: 'skill', name: '📏 Detectar variante', icon: '📏', parent: 'intake', status: 'pending', enabled: true, description: 'Detecta tamaño/variante en texto' },
  extraer_items: { id: 'extraer_items', type: 'skill', name: '📦 Extraer items', icon: '📦', parent: 'intake', status: 'pending', enabled: true, description: 'Extrae items estructurados de texto libre' },
  pedir_aclaracion: { id: 'pedir_aclaracion', type: 'skill', name: '❓ Pedir aclaración', icon: '❓', parent: 'intake', status: 'pending', enabled: true, description: 'Pregunta al cliente cuando falta info crítica' },
  generar_pregunta_tamaño: { id: 'generar_pregunta_tamaño', type: 'skill', name: '❓ Preguntar tamaño', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta para aclarar tamaño de pizza' },
  generar_pregunta_cantidad: { id: 'generar_pregunta_cantidad', type: 'skill', name: '❓ Preguntar cantidad', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta para aclarar cantidad' },
  generar_pregunta_item_desconocido: { id: 'generar_pregunta_item_desconocido', type: 'skill', name: '❓ Preguntar item desconocido', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta cuando item no existe, con sugerencias' },
  generar_pregunta_stock_bajo: { id: 'generar_pregunta_stock_bajo', type: 'skill', name: '❓ Preguntar stock bajo', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta cuando hay stock bajo' },
  generar_pregunta_extras: { id: 'generar_pregunta_extras', type: 'skill', name: '❓ Preguntar extras', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta para extras' },
  generar_pregunta_modificacion: { id: 'generar_pregunta_modificacion', type: 'skill', name: '❓ Preguntar modificación', icon: '❓', parent: 'clarifier', status: 'pending', enabled: true, description: 'Genera pregunta para modificar un item' },
  verificar_stock: { id: 'verificar_stock', type: 'skill', name: '📦 Verificar stock', icon: '📦', parent: 'validator', status: 'pending', enabled: true, description: 'Verifica disponibilidad para cantidad pedida' },
  calcular_total: { id: 'calcular_total', type: 'skill', name: '💰 Calcular total', icon: '💰', parent: 'validator', status: 'pending', enabled: true, description: 'Calcula precios, subtotales, total' },
  validar_pedido_completo: { id: 'validar_pedido_completo', type: 'skill', name: '✅ Validar pedido completo', icon: '✅', parent: 'validator', status: 'pending', enabled: true, description: 'Valida items, tamaños, extras, stock, horarios' },
  verificar_extras_permitidos: { id: 'verificar_extras_permitidos', type: 'skill', name: '✅ Verificar extras', icon: '✅', parent: 'validator', status: 'pending', enabled: true, description: 'Verifica que extras sean permitidos para el item' },
  calcular_tiempo_estimado: { id: 'calcular_tiempo_estimado', type: 'skill', name: '⏱️ Calcular tiempo', icon: '⏱️', parent: 'validator', status: 'pending', enabled: true, description: 'Calcula tiempo de preparación basado en items' },
  confirmar_pedido: { id: 'confirmar_pedido', type: 'skill', name: '✅ Confirmar pedido', icon: '✅', parent: 'confirmer', status: 'pending', enabled: true, description: 'Genera número pedido y demora' },
  formatear_confirmacion_usuario: { id: 'formatear_confirmacion_usuario', type: 'skill', name: '📝 Formatear confirmación', icon: '📝', parent: 'confirmer', status: 'pending', enabled: true, description: 'Formatea confirmación bonita para el cliente' },
  generar_numero_pedido: { id: 'generar_numero_pedido', type: 'skill', name: '🔢 Generar nº pedido', icon: '🔢', parent: 'confirmer', status: 'pending', enabled: true, description: 'Genera número de pedido único (timestamp + random)' },
  calcular_demora_entrega: { id: 'calcular_demora_entrega', type: 'skill', name: '🚚 Calcular demora', icon: '🚚', parent: 'confirmer', status: 'pending', enabled: true, description: 'Calcula demora total: preparación + delivery según zona' },
  formatear_confirmacion_usuario: { id: 'formatear_confirmacion_usuario', type: 'skill', name: '📝 Formatear confirmación', icon: '📝', parent: 'confirmer', status: 'pending', enabled: true, description: 'Formatea confirmación bonita para el cliente' },
  formatear_ticket_cocina: { id: 'formatear_ticket_cocina', type: 'skill', name: '🖨️ Formatear ticket cocina', icon: '🖨️', parent: 'confirmer', status: 'pending', enabled: true, description: 'Formatea ticket ESC/POS 80mm para impresora térmica' },
  enviar_notificacion_cliente: { id: 'enviar_notificacion_cliente', type: 'skill', name: '📤 Notificar cliente', icon: '📤', parent: 'confirmer', status: 'pending', enabled: true, description: 'Envía notificación al cliente (push/WhatsApp/SMS/Email)' },
  imprimir_ticket_cocina: { id: 'imprimir_ticket_cocina', type: 'skill', name: '🖨️ Imprimir ticket cocina', icon: '🖨️', parent: 'confirmer', status: 'pending', enabled: true, description: 'Envía ticket a impresora térmica o KDS' },
  registrar_pedido_bd: { id: 'registrar_pedido_bd', type: 'skill', name: '💾 Registrar pedido BD', icon: '💾', parent: 'confirmer', status: 'pending', enabled: true, description: 'Persiste pedido en BD con idempotencia' },
  registrar_evento_analytics: { id: 'registrar_evento_analytics', type: 'skill', name: '📊 Registrar analytics', icon: '📊', parent: 'confirmer', status: 'pending', enabled: true, description: 'Registra evento en analytics (Mixpanel/Amplitude/GA4)' },
  // Orchestrator skills
  decidir_siguiente_agente: { id: 'decidir_siguiente_agente', type: 'skill', name: '🧭 Decidir siguiente agente', icon: '🧭', parent: 'orchestrator', status: 'pending', enabled: true, description: 'Decide próximo agente basado en contexto (reglas routing)' },
  evaluar_completitud_pedido: { id: 'evaluar_completitud_pedido', type: 'skill', name: '✅ Evaluar completitud', icon: '✅', parent: 'orchestrator', status: 'pending', enabled: true, description: 'Evalúa si el pedido está completo para confirmar' },
  manejar_error_global: { id: 'manejar_error_global', type: 'skill', name: '🛡️ Manejar error global', icon: '🛡️', parent: 'orchestrator', status: 'pending', enabled: true, description: 'Manejo centralizado de errores con recovery sugerido' },
  gestionar_timeouts: { id: 'gestionar_timeouts', type: 'skill', name: '⏱️ Gestionar timeouts', icon: '⏱️', parent: 'orchestrator', status: 'pending', enabled: true, description: 'Gestiona timeouts por agente con reintentos y escalado' },
  persistir_contexto: { id: 'persistir_contexto', type: 'skill', name: '💾 Persistir contexto', icon: '💾', parent: 'orchestrator', status: 'pending', enabled: true, description: 'Guarda/restaura contexto entre reconexiones WebSocket' },
  // Skills futuros (deshabilitados en MVP)
  whatsapp_enviar_mensaje: { id: 'whatsapp_enviar_mensaje', type: 'skill', name: '💬 WhatsApp Enviar', icon: '💬', parent: 'intake', status: 'pending', enabled: false, disabledReason: 'Requiere whatsapp-web.js local' },
  whatsapp_recibir_mensaje: { id: 'whatsapp_recibir_mensaje', type: 'skill', name: '💬 WhatsApp Recibir', icon: '💬', parent: 'intake', status: 'pending', enabled: false, disabledReason: 'Requiere webhook/polling' },
  notificar_push: { id: 'notificar_push', type: 'skill', name: '🔔 Push', icon: '🔔', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere VAPID/Firebase' },
  notificar_email: { id: 'notificar_email', type: 'skill', name: '📧 Email', icon: '📧', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere SendGrid/Resend' },
  cocina_imprimir_ticket: { id: 'cocina_imprimir_ticket', type: 'skill', name: '🍳 Imprimir Ticket', icon: '🍳', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere impresora ESC/POS' },
  cocina_estado_pedido: { id: 'cocina_estado_pedido', type: 'skill', name: '🍳 Estado Cocina', icon: '🍳', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere KDS/API cocina' },
  analytics_registrar_evento: { id: 'analytics_registrar_evento', type: 'skill', name: '📊 Analytics Evento', icon: '📊', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere Mixpanel/Amplitude/GA4' },
  analytics_obtener_metricas: { id: 'analytics_obtener_metricas', type: 'skill', name: '📊 Analytics Métricas', icon: '📊', parent: 'confirmer', status: 'pending', enabled: false, disabledReason: 'Requiere backend analytics' },
  cliente_buscar_o_crear: { id: 'cliente_buscar_o_crear', type: 'skill', name: '👥 Cliente CRM', icon: '👥', parent: 'intake', status: 'pending', enabled: false, disabledReason: 'Requiere DB (Supabase/Firebase)' },
  cliente_historial: { id: 'cliente_historial', type: 'skill', name: '👥 Historial Cliente', icon: '👥', parent: 'intake', status: 'pending', enabled: false, disabledReason: 'Requiere DB' },
  config_obtener: { id: 'config_obtener', type: 'skill', name: '⚙️ Config Remota', icon: '⚙️', parent: 'orchestrator', status: 'pending', enabled: false, disabledReason: 'Requiere Firebase/LaunchDarkly' },
};

let agenciaState = {
  nodes: { ...AGENCIA_NODES },
  selectedNodeId: null,
  autoExpand: true,
  showSkills: true,
  lastTraceEvents: [],
};

function getStatusLabel(status) {
  const labels = { pending: 'Pendiente', active: 'Activo', completed: 'Completado', skipped: 'Saltado', error: 'Error' };
  return labels[status] || status;
}

function renderAgenciaTree() {
  const container = $('agencia-tree');
  if (!container) return;
  
  const showSkills = $('chk-agencia-show-skills')?.checked ?? true;

    // NO resetear children aquí - mantener el estado persistente
    // agenciaState.nodes.orchestrator.children = ['intake', 'validator', 'clarifier', 'confirmer'];

    const html = renderNode('orchestrator', 0, showSkills);
    container.innerHTML = `<ul>${html}</ul>`;

    container.querySelectorAll('.agencia-node').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.node-toggle')) return;
        if (e.target.closest('.node-skills-toggle')) return;
        const nodeId = el.dataset.nodeId;
        selectAgenciaNode(nodeId);
      });
      el.querySelector('.node-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = el.closest('.agencia-node').dataset.nodeId;
        toggleAgenciaNode(nodeId);
      });
      // Toggle para skills container
      el.querySelector('.node-skills-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = el.closest('.agencia-node').dataset.nodeId;
        toggleAgenciaSkills(nodeId);
      });
    });
  
  if (agenciaState.selectedNodeId) {
    const el = container.querySelector(`[data-node-id="${agenciaState.selectedNodeId}"]`);
    if (el) el.classList.add('selected');
    showAgenciaDetail(agenciaState.selectedNodeId);
  }
}

function renderNode(nodeId, depth, showSkills) {
  const node = agenciaState.nodes[nodeId];
  if (!node) return '';
  
  const isDisabled = !node.enabled;
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = node.expanded !== false && (depth < 2 || agenciaState.autoExpand);
  
  const statusClass = `status-${node.status}`;
  const statusLabel = getStatusLabel(node.status);
  const typeBadge = getTypeBadge(node);
  const nodeTypeClass = node.type === 'orchestrator' ? 'type-orchestrator' : (node.type === 'agent' ? 'type-agent' : 'type-skill');
  const disabledClass = isDisabled ? 'disabled' : '';
  
  let toggleHtml = '';
  if (hasChildren) {
    toggleHtml = `<span class="node-toggle" aria-label="${isExpanded ? 'Colapsar' : 'Expandir'}">${isExpanded ? '▾' : '▸'}</span>`;
  } else {
    toggleHtml = '<span class="node-toggle" style="visibility: hidden;">▸</span>';
  }
  
  const skillsHtml = showSkills && node.skills && node.skills.length > 0 ? `
    <div class="node-skills">
      <span class="node-skills-toggle" aria-label="${node.skillsExpanded ? 'Ocultar skills' : 'Mostrar skills'}">${node.skillsExpanded ? '▾' : '▸'}</span>
      <div class="node-skills-list" style="${node.skillsExpanded ? '' : 'display: none;'}">
      ${node.skills.map(skillId => {
        const skill = agenciaState.nodes[skillId];
        if (!skill) return '';
        const skillDisabled = !skill.enabled;
        const skillStatus = skillDisabled ? 'disabled' : (skill.status || 'pending');
        return `
          <div class="agencia-node type-skill ${skillDisabled ? 'disabled' : ''} status-${skillStatus}" data-node-id="${skillId}" style="margin-top: 2px;">
            <span class="node-toggle"></span>
            <span class="node-icon">${skill.icon || '⚙️'}</span>
            <div class="node-label">
              <span class="node-name">${skill.name}</span>
              <span class="node-meta">${skill.description || ''}</span>
            </div>
            <span class="node-status status-${skillStatus}">${getStatusLabel(skillStatus)}</span>
            <span class="node-type-badge" ${skillDisabled ? 'disabled' : ''}>SKILL</span>
          </div>
        `;
      }).join('')}
      </div>
    </div>
  ` : '';
  
  const childrenHtml = hasChildren && isExpanded ? `
    <ul>
      ${node.children.map(childId => renderNode(childId, depth + 1, showSkills)).join('')}
    </ul>
  ` : '';
  
  return `
    <li>
      <div class="agencia-node ${nodeTypeClass} status-${node.status} ${disabledClass}" data-node-id="${nodeId}" ${isDisabled ? 'aria-disabled="true"' : ''}>
        ${toggleHtml}
        <span class="node-icon">${node.icon}</span>
        <div class="node-label">
          <span class="node-name">${node.name}</span>
          <span class="node-meta">${node.description}</span>
        </div>
        <span class="node-status status-${node.status}">${getStatusLabel(node.status)}</span>
        <span class="node-type-badge" ${isDisabled ? 'disabled' : ''}>${getTypeBadge(node)}</span>
      </div>
      ${skillsHtml}
      ${childrenHtml}
    </li>
  `;
}

function getStatusLabel(status) {
  const labels = { pending: 'Pendiente', active: 'Activo', completed: 'Completado', skipped: 'Saltado', error: 'Error' };
  return labels[status] || status;
}

function getTypeBadge(node) {
  const badges = { orchestrator: 'ORQUESTADOR', agent: 'AGENTE', skill: 'SKILL' };
  return badges[node.type] || node.type.toUpperCase();
}

function selectAgenciaNode(nodeId) {
  document.querySelectorAll('.agencia-node.selected').forEach(el => el.classList.remove('selected'));
  const el = document.querySelector(`#agencia-tree [data-node-id="${nodeId}"]`);
  if (el) el.classList.add('selected');
  agenciaState.selectedNodeId = nodeId;
  showAgenciaDetail(nodeId);
}

function toggleAgenciaNode(nodeId) {
  const node = agenciaState.nodes[nodeId];
  if (!node || !node.children || node.children.length === 0) return;
  node.expanded = !node.expanded;
  renderAgenciaTree();
}

function toggleAgenciaSkills(nodeId) {
  const node = agenciaState.nodes[nodeId];
  if (!node || !node.skills || node.skills.length === 0) return;
  node.skillsExpanded = !node.skillsExpanded;
  console.log('toggleAgenciaSkills:', nodeId, node.skillsExpanded);
  renderAgenciaTree();
}

// Expose for debugging
window.toggleAgenciaSkills = toggleAgenciaSkills;
window.agenciaState = agenciaState;

function showAgenciaDetail(nodeId) {
  const panel = $('agencia-detail-panel');
  const content = $('agencia-detail-content');
  const node = agenciaState.nodes[nodeId];
  if (!node || !panel || !content) return;
  panel.hidden = false;
  
  const events = agenciaState.lastTraceEvents.filter(e => e.agent_id === nodeId);
  const lastEvent = events[events.length - 1];
  
  const disabledInfo = !node.enabled ? `
    <div class="detail-row">
      <span class="detail-label">⚠️ Estado</span>
      <span class="detail-value"><strong>Deshabilitado</strong>: ${node.disabledReason || 'No configurado'}</span>
    </div>
  ` : '';
  
  content.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Tipo</span>
      <span class="detail-value">${AGENCIA_NODES[nodeId]?.type || 'N/A'}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Estado actual</span>
      <span class="detail-value"><span class="node-status status-${node.status}">${getStatusLabel(node.status)}</span></span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Habilitado</span>
      <span class="detail-value">${node.enabled ? '✅ Sí' : '❌ No (MVP)'}</span>
    </div>
    ${disabledInfo}
    <div class="detail-row">
      <span class="detail-label">Descripción</span>
      <span class="detail-value">${node.description}</span>
    </div>
    ${node.skills && node.skills.length > 0 ? `
    <div class="detail-row">
      <span class="detail-label">Skills</span>
      <span class="detail-value">${node.skills.map(s => '<code>' + esc(s) + '</code>').join(', ')}</span>
    </div>
    ` : ''}
    ${events.length > 0 ? `
    <div class="detail-row">
      <span class="detail-label">Último evento</span>
      <span class="detail-value"><pre>${esc(JSON.stringify(events[events.length - 1].data, null, 2))}</pre></span>
    </div>
    ` : ''}
    <div class="detail-row">
      <span class="detail-label">Eventos totales</span>
      <span class="detail-value">${events.length}</span>
    </div>
  `;
}

function abrirAgencia() {
  renderAgenciaTree();
  initAgenciaHandlers();
  $('dlg-agencia').showModal();
}

function handleAgenciaTraceEvent(trace) {
  const agentId = trace.agent_id;
  const eventType = trace.event_type;
  const data = trace.data || {};
  
  const agentMap = {
    'intake': 'intake',
    'validator': 'validator',
    'clarifier': 'clarifier',
    'confirmer': 'confirmer',
    'orchestrator': 'orchestrator',
  };
  
  const nodeId = agentMap[agentId];
  if (!nodeId) return;
  
  const node = agenciaState.nodes[nodeId];
  if (!node) return;
  
  agenciaState.lastTraceEvents.push(trace);
  if (agenciaState.lastTraceEvents.length > 100) {
    agenciaState.lastTraceEvents.shift();
  }
  
  switch (eventType) {
    case 'agent_activate':
      node.status = 'active';
      node.expanded = true;
      break;
    case 'agent_deactivate':
      node.status = 'completed';
      break;
    case 'handoff':
      if (data.from_agent && agentMap[data.from_agent]) {
        agenciaState.nodes[agentMap[data.from_agent]].status = 'completed';
      }
      break;
    case 'skill_call':
      node.status = 'active';
      break;
    case 'skill_result':
      if (!data.success) {
        node.status = 'error';
      }
      break;
  }
  
  if ($('dlg-agencia')?.open) {
    renderAgenciaTree();
    if (agenciaState.selectedNodeId) {
      showAgenciaDetail(agenciaState.selectedNodeId);
    }
  }
}


// ============================================
// ORCHESTRATOR TRACE TREE - Vista jerárquica del flujo del orquestador
// ============================================

const orchestratorTraceState = {
  events: [],           // Todos los eventos de traza recibidos
  tree: null,           // Árbol jerárquico construido
  currentSessionId: null,
  maxEvents: 200
};

function handleOrchestratorTraceEvent(trace) {
  const sessionId = trace.session_id;
  if (!sessionId) return;
  
  orchestratorTraceState.currentSessionId = sessionId;
  orchestratorTraceState.events.push(trace);
  
  if (orchestratorTraceState.events.length > orchestratorTraceState.maxEvents) {
    orchestratorTraceState.events.shift();
  }
  
  // Reconstruir árbol cuando hay nuevos eventos
  buildOrchestratorTraceTree();
  
  // Siempre actualizar la UI si existe el container (independiente del diálogo)
  const container = $('orchestrator-trace-tree');
  if (container) {
    renderOrchestratorTraceTree();
  }
  
  // Si el dialog está abierto, asegurar handlers
  if ($('dlg-orchestrator-trace')?.open) {
    initOrchestratorTraceHandlers();
  }
}

function buildOrchestratorTraceTree() {
  const events = orchestratorTraceState.events;
  if (events.length === 0) {
    orchestratorTraceState.tree = null;
    return;
  }
  
  // Mapa de eventos por event_id
  const eventMap = {};
  const roots = [];
  
  // Primero, crear nodos para todos los eventos
  events.forEach(evt => {
    const node = {
      ...evt,
      children: [],
      // Formatear para display
      display: formatTraceEventForDisplay(evt)
    };
    eventMap[evt.event_id] = node;
  });
  
  // Luego, construir jerarquía usando parent_event_id
  events.forEach(evt => {
    const node = eventMap[evt.event_id];
    if (evt.parent_event_id && eventMap[evt.parent_event_id]) {
      // Es hijo de otro evento
      eventMap[evt.parent_event_id].children.push(node);
    } else {
      // Es raíz (evento de decisión del orquestador sin padre)
      roots.push(node);
    }
  });
  
  // Ordenar hijos por step_number
  function sortChildren(node) {
    node.children.sort((a, b) => (a.step_number || 0) - (b.step_number || 0));
    node.children.forEach(sortChildren);
  }
  roots.forEach(sortChildren);
  
  orchestratorTraceState.tree = roots;
}

function formatTraceEventForDisplay(evt) {
  const type = evt.event_type;
  const data = evt.data || {};
  const agentId = evt.agent_id;
  const sourceAgent = data.source_agent || data.skill_source || data.skill_source_agent || null;
  
  let icon = '';
  let label = '';
  let detail = '';
  let cssClass = '';
  
  switch (type) {
    case 'orchestrator_decision':
      icon = '🎭';
      label = `Decisión: ${data.decision || 'next agent'}`;
      detail = `Razón: ${data.reason || evt.decision_reason || ''}`;
      cssClass = 'orchestrator-decision';
      if (data.context_summary) {
        const items = data.context_summary.items_parsed;
        const total = data.context_summary.total_calculated;
        detail += ` | Items: ${items?.length || 0} | Total: ${total ? (typeof total === 'object' ? total.total || 'N/A' : total) : 'N/A'} | Aclaración: ${data.context_summary.aclaracion_pendiente ? 'Sí' : 'No'}`;
      }
      // Indicar que el orquestador decide, no procesa
      if (evt.orchestrator) {
        detail += ' | Decide, no procesa directamente';
      }
      break;
    case 'agent_activate':
      icon = '▶';
      label = `${data.agent_name || agentId} activado`;
      detail = `Agente: ${agentId}`;
      cssClass = 'agent-activate';
      break;
    case 'agent_deactivate':
      icon = '✓';
      label = `${data.agent_name || agentId} finalizado`;
      cssClass = 'agent-deactivate';
      break;
    case 'handoff':
      icon = '🔄';
      label = `Handoff: ${data.from_agent || evt.from_agent} → ${data.to_agent || evt.to_agent}`;
      detail = `Razón: ${data.reason || evt.handoff_reason || ''}`;
      cssClass = 'handoff';
      break;
    case 'skill_call':
      icon = '🔧';
      label = `Skill: ${data.skill_name}`;
      detail = `Desde: ${sourceAgent || 'orchestrator'} | Args: ${JSON.stringify(data.args || {})}`;
      cssClass = 'skill-call';
      break;
    case 'skill_result':
      icon = data.success ? '📋' : '❌';
      label = `Resultado: ${data.skill_name}`;
      if (data.success && data.data) {
        const dataStr = JSON.stringify(data.data);
        // Mostrar solo el resumen si es largo
        detail = dataStr.length > 150 ? `OK: ${dataStr.substring(0, 150)}...` : `OK: ${dataStr}`;
      } else {
        detail = `Error: ${data.error}`;
      }
      cssClass = data.success ? 'skill-result-ok' : 'skill-result-error';
      break;
    default:
      icon = '📡';
      label = type;
      detail = 'Sin detalles';
      cssClass = 'unknown';
  }
  
  return {
    icon,
    label,
    detail,
    cssClass,
    stepNumber: evt.step_number,
    eventId: evt.event_id,
    parentEventId: evt.parent_event_id,
    agentId,
    sourceAgent  // ¿De qué agente proviene este skill/evento?
  };
}

function renderOrchestratorTraceTree() {
  const container = $('orchestrator-trace-tree');
  if (!container) return;
  
  const tree = orchestratorTraceState.tree;
  
  if (!tree || tree.length === 0) {
    container.innerHTML = '<div class="trace-empty">Sin eventos de traza. Inicia una conversación para ver el flujo del orquestador.</div>';
    return;
  }
  
  // Corregir: asegurar que los nodos raíz sean los nodos ORQUESTADOR, no las skills
  // Los nodos que NO tienen parentEventId son raíces (decisión del orquestador)
  const roots = [];
  const nodeMap = {};
  
  tree.forEach(node => {
    nodeMap[node.eventId] = node;
    // Solo eventos del orchestrator o de agentes son raíces
    if (node.parentEventId === null || node.parentEventId === undefined) {
      roots.push(node);
    }
  });
  
  // Construir jerarquía anidada
  const buildTree = (parentId) => {
    return roots.filter(node => node.parentEventId === parentId).map(node => {
      node.children = buildTree(node.eventId);
      return node;
    });
  };
  
  let html = '<ul class="orchestrator-trace-ul">';
  buildTree(null).forEach(root => {
    html += renderTraceNode(root, 0, true);
  });
  html += '</ul>';
  container.innerHTML = html;
  
  // Agregar event listeners para expand/colapse
  container.querySelectorAll('.trace-node-toggle').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeEl = e.target.closest('.trace-node');
      if (nodeEl) {
        const eventId = nodeEl.dataset.eventId;
        toggleTraceNode(eventId);
      }
    });
  });
  
  // Click en nodo para ver detalle
  container.querySelectorAll('.trace-node-content').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.trace-node-toggle')) return;
      const nodeEl = e.target.closest('.trace-node');
      if (nodeEl) {
        const eventId = nodeEl.dataset.eventId;
        showTraceNodeDetail(eventId);
      }
    });
  });
}

function renderTraceNode(node, depth, isRoot = false) {
  const display = node.display;
  const hasChildren = node.children && node.children.length > 0;
  const expanded = node.expanded !== false; // Por defecto expandido
  const indent = depth * 20;
  
  let childrenHtml = '';
  if (hasChildren && expanded) {
    childrenHtml = '<ul class="trace-children">';
    node.children.forEach(child => {
      childrenHtml += renderTraceNode(child, depth + 1);
    });
    childrenHtml += '</ul>';
  } else if (hasChildren) {
    childrenHtml = '<ul class="trace-children" style="display: none;"></ul>';
  }
  
  const toggleIcon = hasChildren ? (expanded ? '▾' : '▸') : '·';
  const stepBadge = display.stepNumber ? `<span class="trace-step-badge">#${display.stepNumber}</span>` : '';
  
  return `
    <li class="trace-node ${display.cssClass}" data-event-id="${node.event_id}" style="margin-left: ${indent}px;">
      <div class="trace-node-content">
        <span class="trace-node-toggle">${toggleIcon}</span>
        ${stepBadge}
        <span class="trace-icon">${display.icon}</span>
        <span class="trace-label">${display.label}</span>
        ${display.detail ? `<span class="trace-detail">${esc(display.detail)}</span>` : ''}
        <span class="trace-agent-badge">${node.agent_id}</span>
      </div>
      ${childrenHtml}
    </li>
  `;
}

function toggleTraceNode(eventId) {
  const node = findTraceNode(orchestratorTraceState.tree, eventId);
  if (node) {
    node.expanded = !node.expanded;
    renderOrchestratorTraceTree();
  }
}

function findTraceNode(nodes, eventId) {
  for (const node of nodes) {
    if (node.event_id === eventId) return node;
    if (node.children && node.children.length > 0) {
      const found = findTraceNode(node.children, eventId);
      if (found) return found;
    }
  }
  return null;
}

function showTraceNodeDetail(eventId) {
  const node = findTraceNode(orchestratorTraceState.tree, eventId);
  if (!node) return;
  
  const panel = $('orchestrator-trace-detail');
  if (!panel) return;
  
  const display = node.display;
  const evt = node;
  
  panel.innerHTML = `
    <div class="detail-header">
      <span class="detail-icon">${display.icon}</span>
      <strong>${display.label}</strong>
    </div>
    <div class="detail-row">
      <span class="detail-label">Tipo de evento</span>
      <span class="detail-value">${evt.event_type}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Agente</span>
      <span class="detail-value">${evt.agent_id}</span>
    </div>
    ${evt.step_number ? `<div class="detail-row"><span class="detail-label">Paso #</span><span class="detail-value">${evt.step_number}</span></div>` : ''}
    ${evt.parent_event_id ? `<div class="detail-row"><span class="detail-label">Padre</span><span class="detail-value"><code>${evt.parent_event_id}</code></span></div>` : ''}
    <div class="detail-row">
      <span class="detail-label">Timestamp</span>
      <span class="detail-value">${new Date(evt.timestamp * 1000).toLocaleTimeString()}</span>
    </div>
    ${display.detail ? `<div class="detail-row"><span class="detail-label">Detalle</span><span class="detail-value">${esc(display.detail)}</span></div>` : ''}
    <div class="detail-row">
      <span class="detail-label">Dato del evento</span>
      <span class="detail-value"><pre>${esc(JSON.stringify(evt.data, null, 2))}</pre></span>
    </div>
  `;
  panel.hidden = false;
}

function abrirOrchestratorTrace() {
  // Limpiar eventos anteriores de otra sesión si es diferente
  if (orchestratorTraceState.events.length > 0 && orchestratorTraceState.currentSessionId) {
    // Mantener solo eventos de la sesión actual
    orchestratorTraceState.events = orchestratorTraceState.events.filter(e => e.session_id === orchestratorTraceState.currentSessionId);
  }
  buildOrchestratorTraceTree();
  renderOrchestratorTraceTree();
  initOrchestratorTraceHandlers();
  $('dlg-orchestrator-trace').showModal();
}

function cerrarOrchestratorTrace() {
  $('dlg-orchestrator-trace').close();
  // MANTENER el árbol para que siga recibiendo eventos
  // Solo se reconstruye cuando se abre de nuevo
}

function renderOrchestratorTraceTree() {
  const container = $('orchestrator-trace-tree');
  if (!container) return;
  
  const tree = orchestratorTraceState.tree;
  
  if (!tree || tree.length === 0) {
    container.innerHTML = '<div class="trace-empty">Sin eventos de traza. Inicia una conversación para ver el flujo del orquestador.</div>';
    return;
  }
  
  // Construir jerarquía: raíces = eventos sin parentEventId (decisión del orquestador, agentes)
  const roots = [];
  const nodeMap = {};
  
  tree.forEach(node => {
    nodeMap[node.eventId] = node;
    if (node.parentEventId === null || node.parentEventId === undefined) {
      roots.push(node);
    }
  });
  
  const buildTree = (parentId) => {
    return roots.filter(node => node.parentEventId === parentId).map(node => {
      node.children = buildTree(node.eventId);
      return node;
    });
  };
  
  let html = '<ul class="orchestrator-trace-ul">';
  buildTree(null).forEach(root => {
    html += renderTraceNode(root, 0, true);
  });
  html += '</ul>';
  container.innerHTML = html;

  // Agregar event listeners para expand/colapse
  container.querySelectorAll('.trace-node-toggle').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeEl = e.target.closest('.trace-node');
      if (nodeEl) {
        const eventId = nodeEl.dataset.eventId;
        toggleTraceNode(eventId);
      }
    });
  });

  // Click en nodo para ver detalle
  container.querySelectorAll('.trace-node-content').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.trace-node-toggle')) return;
      const nodeEl = e.target.closest('.trace-node');
      if (nodeEl) {
        const eventId = nodeEl.dataset.eventId;
        showTraceNodeDetail(eventId);
      }
    });
  });
}

function initAgenciaHandlers() {
  $('btn-agencia-expand-all')?.addEventListener('click', () => {
    Object.values(agenciaState.nodes).forEach(n => { if (n.children?.length) n.expanded = true; });
    renderAgenciaTree();
  });
  
  $('btn-agencia-collapse-all')?.addEventListener('click', () => {
    Object.values(agenciaState.nodes).forEach(n => { if (n.children?.length) n.expanded = false; });
    renderAgenciaTree();
  });
  
  $('btn-agencia-refresh')?.addEventListener('click', renderAgenciaTree);
  
  $('chk-agencia-autoexpand')?.addEventListener('change', e => {
    agenciaState.autoExpand = e.target.checked;
    renderAgenciaTree();
  });
  
  $('chk-agencia-show-skills')?.addEventListener('change', renderAgenciaTree);
}

function initOrchestratorTraceHandlers() {
  $('btn-trace-expand-all')?.addEventListener('click', () => {
    function expandAll(nodes) {
      nodes.forEach(n => {
        n.expanded = true;
        if (n.children?.length) expandAll(n.children);
      });
    }
    if (orchestratorTraceState.tree) expandAll(orchestratorTraceState.tree);
    renderOrchestratorTraceTree();
  });
  
  $('btn-trace-collapse-all')?.addEventListener('click', () => {
    function collapseAll(nodes) {
      nodes.forEach(n => {
        n.expanded = false;
        if (n.children?.length) collapseAll(n.children);
      });
    }
    if (orchestratorTraceState.tree) collapseAll(orchestratorTraceState.tree);
    renderOrchestratorTraceTree();
  });
  
  $('btn-trace-refresh')?.addEventListener('click', renderOrchestratorTraceTree);
  
  $('chk-trace-autoexpand')?.addEventListener('change', e => {
    orchestratorTraceState.autoExpand = e.target.checked;
    renderOrchestratorTraceTree();
  });
  
  $('chk-trace-show-steps')?.addEventListener('change', renderOrchestratorTraceTree);
}

function abrirAgencia() {
  renderAgenciaTree();
  initAgenciaHandlers();
  $('dlg-agencia').showModal();
}

document.addEventListener('DOMContentLoaded', init);
