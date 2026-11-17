/* Pizzería La Esquina — orquestador de pedidos por voz
   App estática: sin build, sin backend. La clave de Gemini vive en localStorage. */

const LS = {
  key: 'pizzeria_apikey_v1',
  modelo: 'pizzeria_modelo_v1',
  hist: 'pizzeria_historial_v1',
};

const MODELOS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (rápido, free tier)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (más razonamiento)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (respaldo)' },
];

const MAX_PASOS = 8;

const state = {
  menu: null,
  key: '',
  modelo: MODELOS[0].id,
  historial: [],
  ultima: null,
  ocupado: false,
  grabando: false,
  reconocimiento: null,
  pedidoTexto: '',
  casos: null,
  eval: null,
  evaluando: false,
  detenerEval: false,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
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

/* ------------------------------------------------------------------ */
/* Catálogo                                                            */
/* ------------------------------------------------------------------ */

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
  const out = {
    item_id: it.id,
    nombre: it.nombre,
    categoria: it.categoria,
    stock: it.stock,
  };
  if (it.variantes) {
    out.variantes = it.variantes.map((v) => ({ variante_id: v.id, nombre: v.nombre, precio: v.precio }));
  } else {
    out.precio = it.precio;
    out.unidad = it.unidad || 'unidad';
  }
  if (it.extrasPermitidos) {
    out.extras_permitidos = it.extrasPermitidos
      .map((id) => extraById(id))
      .filter(Boolean)
      .map((e) => ({ extra_id: e.id, nombre: e.nombre, precio: e.precio }));
  }
  return out;
}

/* Similitud simple para tolerar errores de transcripción. */
function similitud(a, b) {
  if (a === b) return 1;
  if (Math.abs(a.length - b.length) > 6) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return 1 - dp[b.length] / Math.max(a.length, b.length);
}

/* ------------------------------------------------------------------ */
/* Skills (las herramientas que el orquestador puede llamar)           */
/* ------------------------------------------------------------------ */

const SKILLS = {
  buscar_en_catalogo(args) {
    const q = norm(args.consulta);
    if (!q) return { ok: false, error: 'La consulta está vacía.' };

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
    if (!items.length) {
      return { ok: true, encontrados: 0, mensaje: 'No hay ningún ítem que coincida con esa descripción.' };
    }
    return { ok: true, encontrados: items.length, items };
  },

  verificar_stock(args) {
    const it = itemById(args.item_id);
    if (!it) return { ok: false, error: `No existe el ítem "${args.item_id}".` };
    const cantidad = Math.max(1, parseInt(args.cantidad, 10) || 1);
    return {
      ok: true,
      item_id: it.id,
      nombre: it.nombre,
      pedido: cantidad,
      stock: it.stock,
      disponible: cantidad <= it.stock,
    };
  },

  calcular_total(args, ctx) {
    const lineas = Array.isArray(args.lineas) ? args.lineas : [];
    if (!lineas.length) return { ok: false, error: 'No recibí líneas de pedido.' };

    const salida = [];
    const problemas = [];
    let total = 0;

    for (const l of lineas) {
      const it = itemById(l.item_id);
      if (!it) { problemas.push(`No existe el ítem "${l.item_id}".`); continue; }

      const cantidad = Math.max(1, parseInt(l.cantidad, 10) || 1);
      let variante = null;
      if (it.variantes) {
        const vid = norm(l.variante_id);
        variante = it.variantes.find((v) => v.id === l.variante_id || norm(v.nombre).includes(vid)) || null;
        if (!variante) {
          problemas.push(`${it.nombre}: falta el tamaño (chica, mediana o grande).`);
          continue;
        }
      }
      if (cantidad > it.stock) {
        problemas.push(`${it.nombre}: pediste ${cantidad} y quedan ${it.stock}.`);
        continue;
      }

      const extras = [];
      for (const raw of (l.extras || [])) {
        const ex = extraById(raw);
        if (!ex) { problemas.push(`Extra desconocido: "${raw}".`); continue; }
        if (it.extrasPermitidos && !it.extrasPermitidos.includes(ex.id)) {
          problemas.push(`${it.nombre} no admite ${ex.nombre}.`);
          continue;
        }
        extras.push(ex);
      }

      const base = variante ? variante.precio : it.precio;
      const extraUnit = extras.reduce((a, e) => a + e.precio, 0);
      const subtotal = (base + extraUnit) * cantidad;
      total += subtotal;

      salida.push({
        item_id: it.id,
        nombre: it.nombre,
        variante: variante ? variante.nombre : null,
        variante_id: variante ? variante.id : null,
        cantidad,
        extras: extras.map((e) => e.nombre),
        precio_unitario: base + extraUnit,
        subtotal,
      });
    }

    if (problemas.length) return { ok: false, problemas };

    const r = {
      ok: true,
      lineas: salida,
      total,
      moneda: state.menu.tienda.moneda,
      tiempo_estimado_min: state.menu.tienda.tiempoEstimadoMin,
    };
    ctx.total = r;
    return r;
  },

  pedir_aclaracion(args, ctx) {
    const pregunta = String(args.pregunta || '').trim();
    if (!pregunta) return { ok: false, error: 'La aclaración no puede estar vacía.' };
    ctx.aclaracion = pregunta;
    return { ok: true, aclaracion: pregunta };
  },

  confirmar_pedido(args, ctx) {
    if (!ctx.total) {
      return { ok: false, error: 'Antes de confirmar tenés que calcular el total con calcular_total.' };
    }
    const numero = '#' + String(1000 + Math.floor(Math.random() * 9000));
    const resultado = {
      tipo: 'confirmado',
      numero,
      lineas: ctx.total.lineas,
      total: ctx.total.total,
      moneda: ctx.total.moneda,
      tiempo_estimado_min: ctx.total.tiempo_estimado_min,
      cliente: {
        nombre: args.nombre_cliente || null,
        telefono: args.telefono || null,
        direccion: args.direccion || null,
        notas: args.notas || null,
      },
      confirmado_en: new Date().toISOString(),
    };
    ctx.confirmado = resultado;
    return {
      ok: true,
      pedido: numero,
      total: resultado.total,
      moneda: resultado.moneda,
      tiempo_estimado_min: resultado.tiempo_estimado_min,
      mensaje: 'Pedido confirmado y enviado a cocina.',
    };
  },
};

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'buscar_en_catalogo',
      description: 'Busca platos o bebidas del catálogo por nombre, alias o descripción del cliente. Devuelve ids, precios, variantes, extras permitidos y stock. Usala siempre antes de asumir que un ítem existe.',
      parameters: {
        type: 'OBJECT',
        properties: {
          consulta: { type: 'STRING', description: 'Lo que dijo el cliente, por ejemplo "muzza grande" o "cerveza".' },
        },
        required: ['consulta'],
      },
    },
    {
      name: 'verificar_stock',
      description: 'Verifica si hay stock suficiente de un ítem para la cantidad pedida.',
      parameters: {
        type: 'OBJECT',
        properties: {
          item_id: { type: 'STRING' },
          cantidad: { type: 'INTEGER', description: 'Cantidad pedida, mínimo 1.' },
        },
        required: ['item_id', 'cantidad'],
      },
    },
    {
      name: 'calcular_total',
      description: 'Valida el pedido completo (ítems, tamaños, extras y stock) y devuelve precios y total. Es obligatorio llamarla antes de confirmar.',
      parameters: {
        type: 'OBJECT',
        properties: {
          lineas: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                item_id: { type: 'STRING' },
                variante_id: { type: 'STRING', description: 'chica | mediana | grande (solo pizzas).' },
                cantidad: { type: 'INTEGER' },
                extras: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Ids de extras permitidos por el ítem.' },
              },
              required: ['item_id', 'cantidad'],
            },
          },
        },
        required: ['lineas'],
      },
    },
    {
      name: 'pedir_aclaracion',
      description: 'Le hace una pregunta al cliente cuando falta un dato imprescindible (tamaño, cantidad, ítem inexistente). Termina la corrida.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pregunta: { type: 'STRING', description: 'Pregunta corta y concreta, en español rioplatense.' },
        },
        required: ['pregunta'],
      },
    },
    {
      name: 'confirmar_pedido',
      description: 'Confirma el pedido ya calculado y devuelve número de pedido y demora estimada. Solo después de calcular_total exitoso.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nombre_cliente: { type: 'STRING' },
          telefono: { type: 'STRING' },
          direccion: { type: 'STRING' },
          notas: { type: 'STRING' },
        },
      },
    },
  ],
}];

function promptSistema() {
  const t = state.menu.tienda;
  const catalogo = state.menu.items.map((it) => {
    const precios = it.variantes
      ? it.variantes.map((v) => `${v.id} ${fmt(v.precio)}`).join(' / ')
      : `${fmt(it.precio)} por ${it.unidad || 'unidad'}`;
    return `- ${it.id}: ${it.nombre} (${precios}) stock ${it.stock}`;
  }).join('\n');

  return `Sos el orquestador de pedidos telefónicos de "${t.nombre}" (${t.moneda}, demora habitual ${t.tiempoEstimadoMin} min, horario ${t.horario}).

Tu trabajo: convertir el pedido dictado por un cliente en un pedido confirmado, usando ÚNICAMENTE las herramientas. Nunca inventes precios, ítems ni stock.

Reglas:
1. Buscá en el catálogo con buscar_en_catalogo antes de dar por válido un ítem. Los clientes hablan con alias ("muzza", "napo", "birra").
2. Si el cliente pide una pizza sin tamaño, usá pedir_aclaracion (chica/mediana/grande). No elijas un tamaño por tu cuenta.
3. Si no está claro cuántas unidades quiere, o el ítem no existe, pedí aclaración con una pregunta corta. Si el ítem no existe, ofrecé las alternativas más parecidas del catálogo.
4. Verificá el stock con verificar_stock cuando la cantidad sea relevante y resolvé los conflictos con pedir_aclaracion.
5. Calculá el total con calcular_total antes de confirmar. Si devuelve problemas, pedí aclaración en vez de confirmar.
6. Confirmá con confirmar_pedido solo si calcular_total salió bien. Pasá los datos del cliente que aparezcan en el pedido; no inventes dirección ni teléfono.
7. No pidas datos de pago ni de tarjeta. No prometas demoras distintas a las del catálogo.
8. Sé breve y claro, en español riosplatense. Tu texto final es solo para el operador; el cliente recibe la confirmación generada por la app.

Catálogo (ids y precios vigentes):
${catalogo}

Extras disponibles: ${state.menu.extras.map((e) => `${e.id} = ${e.nombre} ${fmt(e.precio)}`).join('; ')}`;
}

/* ------------------------------------------------------------------ */
/* Cliente Gemini                                                      */
/* ------------------------------------------------------------------ */

function extraerMensajeError(texto) {
  try {
    const j = JSON.parse(texto);
    return j.error?.message || texto.slice(0, 200);
  } catch {
    return texto.slice(0, 200);
  }
}

async function llamarGemini(contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(state.modelo)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': state.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: promptSistema() }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`La API respondió ${res.status}: ${extraerMensajeError(t)}`);
  }
  const data = await res.json();
  if (data.promptFeedback?.blockReason) {
    throw new Error('La API bloqueó el pedido: ' + data.promptFeedback.blockReason);
  }
  if (!data.candidates?.length) {
    throw new Error('La API no devolvió candidatos (respuesta vacía).');
  }
  return data;
}

function acumularTokens(corrida, usage) {
  if (!usage) return;
  corrida.tokens.entrada += usage.promptTokenCount || 0;
  corrida.tokens.salida += (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  corrida.tokens.total += usage.totalTokenCount || 0;
}

/* ------------------------------------------------------------------ */
/* Traza                                                               */
/* ------------------------------------------------------------------ */

function nuevaCorrida(texto, modo) {
  return {
    id: 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fecha: new Date().toISOString(),
    texto,
    modo,
    modelo: modo === 'demo' ? 'simulado (reglas locales)' : state.modelo,
    silencioso: false,
    estado: 'corriendo',
    duracion_ms: 0,
    pasos: [],
    tokens: { entrada: 0, salida: 0, total: 0 },
    resultados: null,
  };
}

function addPaso(corrida, paso) {
  corrida.pasos.push(paso);
  if (corrida.silencioso) return;
  pintarPaso(paso, corrida.pasos.length);
  $('traza-vacia').classList.add('hidden');
}

function pintarPaso(paso, n) {
  const li = document.createElement('li');
  li.className = 'paso';

  const io = paso.io
    ? `<div class="io">
        <details><summary>argumentos</summary><pre>${esc(JSON.stringify(paso.io.args, null, 2))}</pre></details>
        <details><summary>resultado</summary><pre>${esc(JSON.stringify(paso.io.resultado, null, 2))}</pre></details>
      </div>`
    : '';

  li.innerHTML = `
    <div class="paso-head">
      <span class="paso-titulo"><span class="paso-n">${n}</span>${esc(paso.titulo)}</span>
      <span class="paso-meta">${esc(paso.meta || '')}${paso.ok === false ? ' · <span style="color:var(--err)">falló</span>' : ''}</span>
    </div>
    ${paso.pensamiento ? `<div class="paso-pensamiento">${esc(paso.pensamiento)}</div>` : ''}
    ${paso.texto ? `<div class="paso-texto">${esc(paso.texto)}</div>` : ''}
    ${io}
  `;

  if (paso.tipo === 'tool') {
    const tag = document.createElement('span');
    tag.className = 'tag-skill' + (paso.ok === false ? ' error' : ' ok');
    tag.textContent = paso.skill;
    li.querySelector('.paso-titulo').appendChild(tag);
  }

  $('timeline').appendChild(li);
  $('panel-traza').scrollTo?.(0, $('panel-traza').scrollHeight);
}

function limpiarTraza() {
  $('timeline').innerHTML = '';
  $('metricas').classList.add('hidden');
  $('metricas').innerHTML = '';
  $('traza-vacia').classList.remove('hidden');
}

function pintarMetricas(corrida) {
  const tools = corrida.pasos.filter((p) => p.tipo === 'tool');
  const llm = corrida.pasos.filter((p) => p.tipo === 'llm');
  const fallidas = tools.filter((p) => p.ok === false).length;

  const items = [
    ['duración', (corrida.duracion_ms / 1000).toFixed(2) + ' s'],
    ['pasos', String(corrida.pasos.length)],
    ['llamadas LLM', String(llm.length)],
    ['tool calls', `${tools.length}${fallidas ? ` (${fallidas} falló)` : ''}`],
    ['tokens', corrida.tokens.total ? String(corrida.tokens.total) : '—'],
    ['entrada/salida', corrida.tokens.total ? `${corrida.tokens.entrada}/${corrida.tokens.salida}` : '—'],
  ];

  $('metricas').innerHTML = items
    .map(([k, v]) => `<div class="metrica"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
  $('metricas').classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* Ejecución de skills                                                 */
/* ------------------------------------------------------------------ */

async function ejecutarSkill(call, ctx, corrida) {
  const t0 = performance.now();
  let response;
  let ok = true;

  try {
    const fn = SKILLS[call.name];
    if (!fn) throw new Error(`Skill desconocida: ${call.name}`);
    response = fn(call.args || {}, ctx) || {};
    if (response.error || response.ok === false) ok = false;
  } catch (e) {
    response = { error: String(e?.message || e) };
    ok = false;
  }

  const ms = Math.round(performance.now() - t0);
  addPaso(corrida, {
    tipo: 'tool',
    skill: call.name,
    titulo: 'Skill',
    ok,
    io: { args: call.args || {}, resultado: response },
    meta: `${ms} ms`,
  });

  return response;
}

/* ------------------------------------------------------------------ */
/* Orquestador con LLM                                                 */
/* ------------------------------------------------------------------ */

async function correrConModelo(corrida, ctx, texto) {
  const contents = [{ role: 'user', parts: [{ text: texto }] }];

  for (let n = 1; n <= MAX_PASOS; n++) {
    const t0 = performance.now();
    const data = await llamarGemini(contents);
    const ms = Math.round(performance.now() - t0);
    acumularTokens(corrida, data.usageMetadata);

    const parts = data.candidates[0].content?.parts || [];
    const pensamiento = parts.filter((p) => p.thought && p.text).map((p) => p.text).join('\n').trim();
    const libre = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join('\n').trim();
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    addPaso(corrida, {
      tipo: 'llm',
      titulo: calls.length ? `Razonamiento · ${calls.length} tool call${calls.length > 1 ? 's' : ''}` : 'Cierre del modelo',
      texto: libre || null,
      pensamiento: pensamiento || null,
      meta: `${ms} ms · paso ${n}`,
    });

    if (!calls.length) {
      ctx.textoFinal = libre || ctx.textoFinal;
      return;
    }

    // Se reenvía el contenido del modelo tal cual (incluye thoughtSignature).
    contents.push({ role: 'model', parts });

    const respuestas = [];
    for (const call of calls) {
      const response = await ejecutarSkill(call, ctx, corrida);
      const part = { functionResponse: { name: call.name, response } };
      if (call.id) part.functionResponse.id = call.id;
      respuestas.push(part);
      if (ctx.confirmado || ctx.aclaracion) break;
    }
    contents.push({ role: 'user', parts: respuestas });

    if (ctx.confirmado || ctx.aclaracion) return;
  }

  ctx.textoFinal = ctx.textoFinal || `Se alcanzó el límite de ${MAX_PASOS} pasos sin cerrar el pedido.`;
}

/* ------------------------------------------------------------------ */
/* Modo simulado (reglas locales, sin API)                             */
/* ------------------------------------------------------------------ */

const NUM = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15,
  veinte: 20, treinta: 30, docena: 12,
};

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

/* Coincidencia de alias tolerante al plural: "muzza" también matchea "muzzas". */
function patronAlias(alias) {
  const cuerpo = alias
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?')
    .join(' +');
  return new RegExp('(?:^|\\s)(' + cuerpo + ')(?=\\s|$)', 'g');
}

function mencionesDe(texto) {
  const out = [];
  for (const it of state.menu.items) {
    const alias = [...new Set([it.nombre, ...(it.alias || [])])].map(norm).filter((a) => a.length >= 3);
    for (const a of alias) {
      const re = patronAlias(a);
      let m;
      while ((m = re.exec(texto))) {
        const frase = m[1];
        const start = m.index + (m[0].length - frase.length);
        out.push({
          item: it,
          start,
          end: start + frase.length,
          len: frase.length,
          plural: /s$/.test(frase.split(' ')[0]),
        });
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
    if (elegidos.some((p) => m.start < p.end && m.end > p.start)) continue;
    if (elegidos.some((p) => p.item.id === m.item.id)) continue; // una línea por ítem
    elegidos.push(m);
  }

  const lineas = elegidos.map((m, i) => {
    const prevEnd = i === 0 ? 0 : elegidos[i - 1].end;
    const nextStart = i + 1 < elegidos.length ? elegidos[i + 1].start : t.length;
    const antes = t.slice(prevEnd, m.start);
    const despues = t.slice(m.end, nextStart);

    let variante_id = null;
    if (m.item.variantes) {
      const v = buscarTamanio(despues) || buscarTamanio(antes.slice(-28));
      if (v) variante_id = v;
    }

    // Los extras se leen solo en el tramo que sigue al ítem, para no
    // arrastrarlos desde otra línea del pedido.
    const extras = [];
    for (const ex of state.menu.extras) {
      if (!m.item.extrasPermitidos?.includes(ex.id)) continue;
      const alias = [...new Set([ex.nombre, ...(ex.alias || [])])].map(norm);
      if (alias.some((a) => a.length >= 3 && despues.includes(a))) extras.push(ex.id);
    }

    const cantidadAntes = cantidadEn(antes);
    return {
      item: m.item,
      item_id: m.item.id,
      variante_id,
      cantidad: cantidadAntes ?? cantidadEn(despues.slice(0, 12)) ?? 1,
      cantidadExplicita: cantidadAntes != null,
      plural: m.plural,
      extras,
    };
  });

  return lineas;
}

/* Corta la frase del ítem en la primera palabra y la compara con el catálogo.
   Así "pizza de anchoas y una muzza" no se da por conocida solo porque
   aparece "muzza" más adelante en la misma frase. */
const CORTES_FRASE = new Set(['un', 'una', 'unos', 'unas', 'la', 'el', 'los', 'las', 'para', 'por', 'sin', 'con', 'favor']);

function esItemConocido(frase) {
  return state.menu.items.some((it) =>
    [it.nombre, ...(it.alias || [])]
      .map(norm)
      .some((n) => n.length >= 3 && (frase === n || frase.startsWith(n + ' ')))
  );
}

function detectarDesconocidos(texto) {
  const t = norm(texto);
  const out = [];
  const re = /(?:pizzas?|empanadas?)\s+de\s+([a-zñ0-9 ]{3,60})/g;
  let m;
  while ((m = re.exec(t))) {
    const palabras = m[1].split(' ').filter(Boolean).slice(0, 5);
    let conocida = false;
    let acumulado = '';
    for (const w of palabras) {
      acumulado = acumulado ? `${acumulado} ${w}` : w;
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
  const msBase = corrida.silencioso ? 0 : 110;
  const paso = async (p, ms = msBase) => {
    if (ms) await sleep(ms);
    addPaso(corrida, p);
  };

  const lineas = parsearPedido(texto);

  await paso({
    tipo: 'llm',
    titulo: 'Interpretación del pedido (simulada)',
    texto: lineas.length
      ? 'Detecté: ' + lineas.map((l) => `${l.cantidad}× ${l.item.nombre}${l.variante_id ? ` (${l.variante_id})` : ''}`).join(', ') + '.'
      : 'No reconocí ningún ítem del catálogo en el pedido.',
    meta: 'reglas locales · sin API',
  });

  const desconocidos = detectarDesconocidos(texto);
  if (desconocidos.length) {
    await ejecutarSkill({
      name: 'pedir_aclaracion',
      args: {
        pregunta: `No tenemos ${desconocidos.join(', ')} en la carta. ¿Querés que te pase las opciones de pizzas o empanadas?`,
      },
    }, ctx, corrida);
    return;
  }

  if (!lineas.length) {
    const pregunta = 'No pude identificar qué querés pedir. ¿Me repetís los platos y las cantidades?';
    await ejecutarSkill({ name: 'pedir_aclaracion', args: { pregunta } }, ctx, corrida);
    return;
  }

  for (const l of lineas) {
    await ejecutarSkill({
      name: 'buscar_en_catalogo',
      args: { consulta: l.item.nombre },
    }, ctx, corrida);
  }

  const sinTamanio = lineas.filter((l) => l.item.variantes && !l.variante_id);
  if (sinTamanio.length) {
    const nombres = sinTamanio.map((l) => l.item.nombre).join(', ');
    await ejecutarSkill({
      name: 'pedir_aclaracion',
      args: {
        pregunta: `${nombres}: ¿la querés chica, mediana o grande?`,
      },
    }, ctx, corrida);
    return;
  }

  // Plural sin número ("empanadas de carne"): hace falta preguntar cuántas.
  const sinCantidad = lineas.filter((l) => l.plural && !l.cantidadExplicita);
  if (sinCantidad.length) {
    const nombres = sinCantidad
      .map((l) => l.item.nombre.replace(/^Empanada/, 'Empanadas').replace(/^Pizza/, 'Pizzas'))
      .join(', ');
    await ejecutarSkill({
      name: 'pedir_aclaracion',
      args: { pregunta: `¿Cuántas ${nombres.toLowerCase()} querés?` },
    }, ctx, corrida);
    return;
  }

  for (const l of lineas) {
    const stock = await ejecutarSkill({
      name: 'verificar_stock',
      args: { item_id: l.item_id, cantidad: l.cantidad },
    }, ctx, corrida);
    if (stock.disponible === false) {
      await ejecutarSkill({
        name: 'pedir_aclaracion',
        args: {
          pregunta: `De ${l.item.nombre} quedan ${stock.stock} y pediste ${l.cantidad}. ¿Ajustamos la cantidad?`,
        },
      }, ctx, corrida);
      return;
    }
  }

  const total = await ejecutarSkill({
    name: 'calcular_total',
    args: {
      lineas: lineas.map((l) => ({
        item_id: l.item_id,
        variante_id: l.variante_id || undefined,
        cantidad: l.cantidad,
        extras: l.extras,
      })),
    },
  }, ctx, corrida);

  if (total.ok === false) {
    const problema = (total.problemas || [total.error]).filter(Boolean).join(' ');
    await ejecutarSkill({
      name: 'pedir_aclaracion',
      args: { pregunta: `${problema} ¿Cómo lo resolvemos?` },
    }, ctx, corrida);
    return;
  }

  await ejecutarSkill({
    name: 'confirmar_pedido',
    args: { nombre_cliente: detectarCliente(texto) || undefined },
  }, ctx, corrida);
}

/* ------------------------------------------------------------------ */
/* Ejecución completa                                                  */
/* ------------------------------------------------------------------ */

async function ejecutarPedido() {
  if (state.ocupado) return;

  const texto = $('transcripcion').value.trim();
  if (!texto) {
    $('hint-envio').textContent = 'Primero dictá o escribí el pedido.';
    $('transcripcion').focus();
    return;
  }

  const demo = $('chk-demo').checked;
  if (!demo && !state.key) {
    mostrarAvisoClave(true);
    abrirConfig();
    return;
  }

  await cargarMenu().catch(() => null);
  if (!state.menu) {
    $('hint-envio').textContent = 'No se pudo cargar data/menu.json. Serví la carpeta por HTTP (ver README).';
    return;
  }

  state.ocupado = true;
  state.pedidoTexto = texto;
  $('btn-enviar').disabled = true;
  $('hint-envio').textContent = demo ? 'Corriendo con el simulador local…' : 'Consultando al modelo…';
  marcarEstado('corriendo');

  const corrida = nuevaCorrida(texto, demo ? 'demo' : 'llm');
  const t0 = performance.now();
  const ctx = { total: null, aclaracion: null, confirmado: null, textoFinal: null };

  limpiarTraza();
  $('resultado').className = 'resultado-vacio';
  $('resultado').innerHTML = '<p class="muted">El orquestador está trabajando…</p>';

  try {
    if (demo) await correrDemo(corrida, ctx, texto);
    else await correrConModelo(corrida, ctx, texto);
  } catch (e) {
    ctx.error = String(e?.message || e);
  }
  cerrarCorrida(corrida, ctx, t0);

  state.ocupado = false;
  $('btn-enviar').disabled = false;
  $('hint-envio').textContent = '';

  pintarMetricas(corrida);
  pintarResultado(corrida.resultado);
  marcarEstado(corrida.estado);
  $('btn-exportar').disabled = false;
  $('btn-copiar').disabled = false;

  state.ultima = corrida;
  guardarEnHistorial(corrida);
}

function cerrarCorrida(corrida, ctx, t0) {
  corrida.duracion_ms = Math.round(performance.now() - t0);
  if (ctx.error) {
    corrida.estado = 'error';
    corrida.resultado = { tipo: 'error', mensaje: ctx.error };
    addPaso(corrida, { tipo: 'error', titulo: 'Error en la corrida', texto: ctx.error, ok: false, meta: 'abortado' });
    return corrida;
  }
  corrida.resultado = ctx.confirmado
    || (ctx.aclaracion ? { tipo: 'aclaracion', pregunta: ctx.aclaracion } : { tipo: 'texto', texto: ctx.textoFinal || 'El modelo no cerró el pedido.' });
  corrida.estado = ctx.confirmado ? 'confirmado' : (ctx.aclaracion ? 'aclaracion' : 'sin_confirmar');
  return corrida;
}

/* Corrida sin interfaz: la usa el modo de evaluación. */
async function correrCaso(texto, modo) {
  const corrida = nuevaCorrida(texto, modo);
  corrida.silencioso = true;
  const ctx = { total: null, aclaracion: null, confirmado: null, textoFinal: null, error: null };
  const t0 = performance.now();
  try {
    if (modo === 'demo') await correrDemo(corrida, ctx, texto);
    else await correrConModelo(corrida, ctx, texto);
  } catch (e) {
    ctx.error = String(e?.message || e);
  }
  return cerrarCorrida(corrida, ctx, t0);
}

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

function marcarEstado(estado) {
  const etiquetas = {
    corriendo: 'corriendo…',
    confirmado: 'confirmado',
    aclaracion: 'falta un dato',
    sin_confirmar: 'sin confirmar',
    error: 'error',
  };
  const badge = $('resultado-estado');
  badge.className = 'badge estado-' + estado;
  badge.textContent = etiquetas[estado] || estado;
}

function pintarResultado(res) {
  const box = $('resultado');
  box.className = '';
  box.innerHTML = '';

  if (!res) {
    box.className = 'resultado-vacio';
    box.innerHTML = '<p class="muted">Sin resultado.</p>';
    return;
  }

  if (res.tipo === 'confirmado') {
    const cliente = res.cliente || {};
    const datos = [cliente.nombre && `Cliente: ${cliente.nombre}`, cliente.direccion && `Envío: ${cliente.direccion}`, cliente.telefono && `Tel: ${cliente.telefono}`, cliente.notas && `Nota: ${cliente.notas}`]
      .filter(Boolean)
      .map((d) => `<div class="small muted">${esc(d)}</div>`)
      .join('');

    box.innerHTML = `
      <div class="ticket">
        <div>
          <div class="t-num">Pedido ${esc(res.numero)}</div>
          <div class="t-meta">Confirmado · demora estimada ${esc(res.tiempo_estimado_min)} min</div>
        </div>
        <span class="badge estado-confirmado">a cocina</span>
      </div>
      <ul class="lineas">
        ${res.lineas.map((l) => `
          <li>
            <span class="cant">${esc(l.cantidad)}×</span>
            <span>
              ${esc(l.nombre)}
              ${l.variante ? `<span class="detalle">${esc(l.variante)}${l.extras.length ? ' · ' + esc(l.extras.join(', ')) : ''}</span>` : (l.extras.length ? `<span class="detalle">${esc(l.extras.join(', '))}</span>` : '')}
            </span>
            <span class="precio">${fmt(l.subtotal)}</span>
          </li>`).join('')}
      </ul>
      <div class="total-row"><span>Total</span><strong>${fmt(res.total)}</strong></div>
      ${datos}
    `;
    return;
  }

  if (res.tipo === 'aclaracion') {
    box.innerHTML = `
      <div class="aclaracion">
        <div class="pregunta">${esc(res.pregunta)}</div>
        <div class="respuesta-row">
          <input type="text" id="input-respuesta" placeholder="Respondé acá…" autocomplete="off">
          <button type="button" id="btn-responder" class="primary">Responder</button>
        </div>
        <div class="small muted">La respuesta se agrega al pedido y el orquestador vuelve a correr.</div>
      </div>
    `;
    const input = $('input-respuesta');
    const responder = () => {
      const r = input.value.trim();
      if (!r) return;
      $('transcripcion').value = `${state.pedidoTexto || $('transcripcion').value} — ${r}`;
      ejecutarPedido();
    };
    $('btn-responder').addEventListener('click', responder);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') responder(); });
    input.focus();
    return;
  }

  if (res.tipo === 'error') {
    box.innerHTML = `<div class="error-box"><strong>No se pudo completar el pedido.</strong><br>${esc(res.mensaje)}</div>`;
    return;
  }

  box.innerHTML = `<div class="error-box">${esc(res.texto || 'El modelo no confirmó el pedido.')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Historial                                                           */
/* ------------------------------------------------------------------ */

const MAX_HIST = 15;

function guardarEnHistorial(corrida) {
  state.historial.unshift(corrida);
  state.historial = state.historial.slice(0, MAX_HIST);
  try {
    localStorage.setItem(LS.hist, JSON.stringify(state.historial));
  } catch (e) {
    console.warn('No se pudo guardar el historial', e);
  }
  pintarHistorial();
}

function cargarHistorial() {
  try {
    const raw = localStorage.getItem(LS.hist);
    state.historial = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.historial)) state.historial = [];
  } catch {
    state.historial = [];
  }
  pintarHistorial();
}

function pintarHistorial() {
  const ul = $('historial');
  ul.innerHTML = '';
  $('historial-vacio').classList.toggle('hidden', state.historial.length > 0);

  for (const c of state.historial) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hist-item';
    const recorte = c.texto.length > 58 ? c.texto.slice(0, 58) + '…' : c.texto;
    btn.innerHTML = `
      <span><span class="punto ${esc(c.estado)}"></span>${esc(recorte)}</span>
      <span class="hist-meta">${esc(c.estado)} · ${(c.duracion_ms / 1000).toFixed(1)}s</span>
    `;
    btn.addEventListener('click', () => {
      state.ultima = c;
      $('transcripcion').value = c.texto;
      limpiarTraza();
      $('timeline').innerHTML = '';
      for (const [i, p] of c.pasos.entries()) pintarPaso(p, i + 1);
      if (c.pasos.length) $('traza-vacia').classList.add('hidden');
      pintarMetricas(c);
      pintarResultado(c.resultado);
      marcarEstado(c.estado);
      $('btn-exportar').disabled = false;
      $('btn-copiar').disabled = false;
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* Evaluación: 10 pedidos difíciles, simulador vs modelo               */
/* ------------------------------------------------------------------ */

async function cargarCasos() {
  if (state.casos) return state.casos;
  const res = await fetch('data/pedidos-prueba.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('No se pudo leer data/pedidos-prueba.json (HTTP ' + res.status + ').');
  const data = await res.json();
  state.casos = data.casos || [];
  return state.casos;
}

function firmaLineas(lineas) {
  return (lineas || [])
    .map((l) => {
      // La traza devuelve extras por nombre; el set de prueba usa ids.
      const extras = (l.extras || []).map((e) => extraById(e)?.id || e).sort();
      return `${l.cantidad}x${l.item_id}/${l.variante_id || '-'}/${extras.join('+')}`;
    })
    .sort()
    .join(' | ');
}

function evaluarCaso(corrida, espera) {
  const r = corrida.resultado || {};
  if (corrida.estado !== espera.estado) {
    return { ok: false, motivo: `estado ${corrida.estado}, esperaba ${espera.estado}` };
  }
  if (espera.estado !== 'confirmado') return { ok: true, motivo: '' };

  if (r.total !== espera.total) {
    return { ok: false, motivo: `total ${r.total ?? '—'}, esperaba ${espera.total}` };
  }
  if (firmaLineas(r.lineas) !== firmaLineas(espera.lineas)) {
    return { ok: false, motivo: 'las líneas no coinciden con lo esperado' };
  }
  return { ok: true, motivo: '' };
}

function skillsDe(corrida) {
  return (corrida?.pasos || []).filter((p) => p.tipo === 'tool').map((p) => p.skill);
}

function compararCorridas(a, b) {
  const sa = skillsDe(a);
  const sb = skillsDe(b);
  return {
    estado: a.estado === b.estado,
    total: (a.resultado?.total ?? null) === (b.resultado?.total ?? null),
    skills: sa.length === sb.length && sa.every((s, i) => s === sb[i]),
    skillsSim: sa,
    skillsModelo: sb,
  };
}

function etiquetaEspera(espera) {
  return espera.estado === 'confirmado' ? `confirmado · ${fmt(espera.total)}` : 'aclaración';
}

function resumenLineas(corrida) {
  const r = corrida.resultado || {};
  if (corrida.estado === 'confirmado') return `${r.lineas?.length || 0} ítems · ${fmt(r.total)}`;
  if (corrida.estado === 'aclaracion') return r.pregunta || 'pregunta';
  if (corrida.estado === 'error') return r.mensaje || 'error';
  return r.texto || 'sin confirmar';
}

function celdaVeredicto(ev, extra) {
  if (!ev) return '<td class="muted">sin modelo</td>';
  const marca = ev.ok ? '<span class="veredicto ok">✓</span>' : '<span class="veredicto err">✗</span>';
  return `<td>${marca}${extra || ''}${ev.ok ? '' : `<div class="small muted">${esc(ev.motivo)}</div>`}</td>`;
}

function pintarEvaluacion(resultados, total) {
  const conModelo = resultados.some((r) => r.modelo);
  const evals = resultados.map((r) => ({
    evalSim: evaluarCaso(r.sim, r.caso.espera),
    evalModelo: r.modelo ? evaluarCaso(r.modelo, r.caso.espera) : null,
    comp: r.modelo ? compararCorridas(r.sim, r.modelo) : null,
  }));

  const aciertosSim = evals.filter((e) => e.evalSim.ok).length;
  const aciertosModelo = evals.filter((e) => e.evalModelo?.ok).length;
  const mismosEstados = evals.filter((e) => e.comp?.estado).length;
  const mismasSkills = evals.filter((e) => e.comp?.skills).length;
  const msModelo = resultados.reduce((a, r) => a + (r.modelo?.duracion_ms || 0), 0);

  const chips = [
    ['casos corridos', `${resultados.length}/${total}`],
    ['simulador', `${aciertosSim}/${resultados.length}`],
    ['modelo', conModelo ? `${aciertosModelo}/${resultados.length}` : 'sin clave'],
    ['mismo estado', conModelo ? `${mismosEstados}/${resultados.length}` : '—'],
    ['misma secuencia de skills', conModelo ? `${mismasSkills}/${resultados.length}` : '—'],
    ['tiempo modelo', conModelo ? (msModelo / 1000).toFixed(1) + ' s' : '—'],
  ];
  $('eval-resumen').innerHTML = chips
    .map(([k, v]) => `<div class="metrica"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
  $('eval-resumen').classList.remove('hidden');

  const filas = resultados.map((r, i) => {
    const e = evals[i];
    const comp = e.comp;
    const traza = comp
      ? [
          `estado ${comp.estado ? '=' : '≠'}`,
          `total ${comp.total ? '=' : '≠'}`,
          `skills ${comp.skills ? '=' : '≠'} (${comp.skillsSim.length} vs ${comp.skillsModelo.length})`,
        ].join(' · ')
      : '—';
    return `
      <tr>
        <td><code>${esc(r.caso.id)}</code><div class="small muted">${esc(r.caso.dificultad)}</div></td>
        <td class="eval-texto">${esc(r.caso.texto)}<div class="small muted">esperado: ${esc(etiquetaEspera(r.caso.espera))}</div></td>
        <td class="small">${esc(resumenLineas(r.sim))}</td>
        ${celdaVeredicto(e.evalSim)}
        <td class="small">${r.modelo ? esc(resumenLineas(r.modelo)) : '—'}</td>
        ${celdaVeredicto(e.evalModelo)}
        <td class="small ${comp && (comp.estado && comp.total && comp.skills) ? '' : 'muted'}">${esc(traza)}</td>
      </tr>`;
  });

  $('eval-tabla').innerHTML = `
    <thead>
      <tr>
        <th>caso</th><th>pedido</th><th>simulador</th><th>✓</th><th>modelo</th><th>✓</th><th>traza</th>
      </tr>
    </thead>
    <tbody>${filas.join('')}</tbody>`;
  $('eval-tabla-wrap').classList.remove('hidden');
  $('eval-vacio').classList.add('hidden');
}

async function correrEvaluacion() {
  if (state.evaluando) {
    state.detenerEval = true;
    $('btn-eval').textContent = 'Deteniendo…';
    return;
  }

  let casos;
  try {
    casos = await cargarCasos();
    await cargarMenu();
  } catch (e) {
    $('eval-progreso').textContent = 'No se pudo leer el catálogo o el set de prueba: ' + e.message;
    return;
  }
  if (!casos.length) return;

  const conModelo = $('chk-eval-modelo').checked;
  if (conModelo && !state.key) {
    $('eval-progreso').textContent = 'Para comparar contra el modelo hace falta la clave de Gemini. Se corre solo el simulador.';
    $('chk-eval-modelo').checked = false;
  }

  state.evaluando = true;
  state.detenerEval = false;
  $('btn-eval').textContent = 'Detener';
  $('eval-resumen').classList.add('hidden');
  $('eval-tabla-wrap').classList.add('hidden');

  const resultados = [];
  const usarModelo = $('chk-eval-modelo').checked;

  for (const [i, caso] of casos.entries()) {
    if (state.detenerEval) break;
    $('eval-progreso').textContent = `Corriendo ${i + 1}/${casos.length} · ${caso.id} · simulador…`;
    const sim = await correrCaso(caso.texto, 'demo');
    let modelo = null;
    if (usarModelo) {
      $('eval-progreso').textContent = `Corriendo ${i + 1}/${casos.length} · ${caso.id} · modelo…`;
      modelo = await correrCaso(caso.texto, 'llm');
    }
    resultados.push({ caso, sim, modelo });
    pintarEvaluacion(resultados, casos.length);
  }

  const cortado = state.detenerEval && resultados.length < casos.length;
  $('eval-progreso').textContent = cortado
    ? `Detenido en ${resultados.length}/${casos.length} casos.`
    : `Listo: ${resultados.length} casos ${usarModelo ? 'con el mismo texto en los dos modos' : '(solo simulador)'}.`;
  $('btn-eval').textContent = 'Correr de nuevo';
  $('btn-eval-exportar').disabled = false;
  state.eval = { fecha: new Date().toISOString(), modelo: usarModelo ? state.modelo : null, resultados };
  state.evaluando = false;
  state.detenerEval = false;
}

function exportarEvaluacion() {
  if (!state.eval) return;
  const salida = {
    ...state.eval,
    resumen: {
      casos: state.eval.resultados.length,
      aciertos_simulador: state.eval.resultados.filter((r) => evaluarCaso(r.sim, r.caso.espera).ok).length,
      aciertos_modelo: state.eval.resultados.filter((r) => r.modelo && evaluarCaso(r.modelo, r.caso.espera).ok).length,
      mismo_estado: state.eval.resultados.filter((r) => r.modelo && compararCorridas(r.sim, r.modelo).estado).length,
      misma_secuencia_skills: state.eval.resultados.filter((r) => r.modelo && compararCorridas(r.sim, r.modelo).skills).length,
    },
    detalle: state.eval.resultados.map((r) => ({
      caso: r.caso,
      simulador: { estado: r.sim.estado, duracion_ms: r.sim.duracion_ms, skills: skillsDe(r.sim), resultado: r.sim.resultado },
      modelo: r.modelo ? { estado: r.modelo.estado, duracion_ms: r.modelo.duracion_ms, skills: skillsDe(r.modelo), tokens: r.modelo.tokens, resultado: r.modelo.resultado } : null,
    })),
  };
  const blob = new Blob([JSON.stringify(salida, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `evaluacion-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */

function abrirConfig() {
  $('input-key').value = state.key;
  $('select-modelo').value = state.modelo;
  const dlg = $('dlg-config');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function mostrarAvisoClave(mostrar) {
  const b = $('aviso-clave');
  b.classList.toggle('hidden', !mostrar);
  if (mostrar) {
    b.innerHTML = 'Falta la clave de Gemini. Abrí <strong>Configurar</strong> y pegala, o activá <em>Simular modelo</em> para probar el flujo sin API.';
  }
}

function actualizarBadge() {
  $('modelo-badge').textContent = state.key ? state.modelo.replace('gemini-', 'Gemini ') : 'sin clave · simulador';
}

/* ------------------------------------------------------------------ */
/* Micrófono                                                           */
/* ------------------------------------------------------------------ */

function initMicrofono() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('btn-mic');

  if (!SR) {
    $('mic-estado').textContent = 'Dictado no disponible';
    $('mic-detalle').textContent = 'Este navegador no soporta Web Speech API. Escribí el pedido a mano.';
    btn.disabled = true;
    return;
  }

  const rec = new SR();
  rec.lang = 'es-AR';
  rec.continuous = true;
  rec.interimResults = true;
  state.reconocimiento = rec;

  let base = '';

  rec.onstart = () => {
    state.grabando = true;
    btn.classList.add('grabando');
    btn.querySelector('.mic-label').textContent = 'Detener';
    $('mic-estado').textContent = 'Escuchando…';
    $('mic-detalle').textContent = 'Hablá con naturalidad. Podés dictar y corregir antes de enviar.';
  };

  rec.onresult = (ev) => {
    let final = '';
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (final) base = (base + ' ' + final).replace(/\s+/g, ' ').trim();
    $('transcripcion').value = (base + ' ' + interim).trim();
  };

  rec.onerror = (ev) => {
    const mensajes = {
      'not-allowed': 'Permiso de micrófono denegado. Habilitalo en el candado de la barra de direcciones.',
      'no-speech': 'No se escuchó nada. Probá de nuevo más cerca del micrófono.',
      network: 'El reconocimiento de voz necesita conexión a internet.',
      'audio-capture': 'No se encontró micrófono.',
    };
    $('mic-estado').textContent = 'No se pudo grabar';
    $('mic-detalle').textContent = mensajes[ev.error] || `Error de dictado: ${ev.error}`;
  };

  rec.onend = () => {
    state.grabando = false;
    btn.classList.remove('grabando');
    btn.querySelector('.mic-label').textContent = 'Grabar';
    $('mic-estado').textContent = 'Micrófono listo';
    $('mic-detalle').textContent = 'Revisá el texto y envialo al orquestador.';
  };

  btn.addEventListener('click', () => {
    if (state.grabando) {
      rec.stop();
      return;
    }
    base = $('transcripcion').value.trim();
    try {
      rec.start();
    } catch (e) {
      $('mic-detalle').textContent = 'No se pudo iniciar el dictado: ' + e.message;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Ejemplos                                                            */
/* ------------------------------------------------------------------ */

const EJEMPLOS = [
  'Hola, quiero dos pizzas de muzza medianas y una coca de litro y medio.',
  'Una napolitana grande con extra queso y cuatro empanadas de carne.',
  'Quiero una pizza de fugazzeta.',
  'Dos muzza grandes y tres empanadas de pollo, una cerveza.',
  'Veinte pizzas de rúcula grandes.',
  'Quiero una pizza de anchoas y una de muzza chica.',
  'Mmm, quiero pedir algo rico.',
  'Hola, una grande de muzza, dos empanadas de jamón y queso y una coca lata. Soy Martín.',
];

function initEjemplos() {
  const sel = $('select-ejemplo');
  for (const [i, ej] of EJEMPLOS.entries()) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ej;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const i = sel.value;
    if (i === '') return;
    $('transcripcion').value = EJEMPLOS[Number(i)];
    $('hint-envio').textContent = '';
    sel.value = '';
  });
}

/* ------------------------------------------------------------------ */
/* Exportar                                                            */
/* ------------------------------------------------------------------ */

function descargarCorrida() {
  if (!state.ultima) return;
  const blob = new Blob([JSON.stringify(state.ultima, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `corrida-${state.ultima.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copiarCorrida() {
  if (!state.ultima) return;
  const txt = JSON.stringify(state.ultima, null, 2);
  try {
    await navigator.clipboard.writeText(txt);
    $('btn-copiar').textContent = 'Copiado';
    setTimeout(() => { $('btn-copiar').textContent = 'Copiar'; }, 1400);
  } catch {
    $('hint-envio').textContent = 'El navegador no permitió copiar. Usá Exportar JSON.';
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function init() {
  state.key = localStorage.getItem(LS.key) || '';
  state.modelo = localStorage.getItem(LS.modelo) || MODELOS[0].id;

  const selModelo = $('select-modelo');
  for (const m of MODELOS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    selModelo.appendChild(opt);
  }
  selModelo.value = state.modelo;

  actualizarBadge();
  mostrarAvisoClave(!state.key);
  cargarHistorial();
  initEjemplos();
  initMicrofono();
  limpiarTraza();

  cargarMenu()
    .then((menu) => {
      $('tienda-nombre').textContent = menu.tienda.nombre;
      document.title = `${menu.tienda.nombre} — pedidos por voz`;
      $('horario').textContent = `Abierto ${menu.tienda.horario} · ${menu.tienda.moneda}`;
      mostrarAvisoClave(!state.key);
    })
    .catch(() => {
      const b = $('aviso-clave');
      b.classList.remove('hidden');
      b.innerHTML = 'No se pudo leer <code>data/menu.json</code>. Si abriste el archivo con doble clic, serví la carpeta por HTTP: <code>python -m http.server 8080</code> y entrá a <code>localhost:8080</code>.';
    });

  $('btn-config').addEventListener('click', abrirConfig);

  $('form-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('input-key').value.trim();
    state.key = key;
    state.modelo = $('select-modelo').value;
    if (key) localStorage.setItem(LS.key, key);
    else localStorage.removeItem(LS.key);
    localStorage.setItem(LS.modelo, state.modelo);
    actualizarBadge();
    mostrarAvisoClave(!state.key);
    $('dlg-config').close();
  });

  $('btn-borrar-key').addEventListener('click', () => {
    state.key = '';
    localStorage.removeItem(LS.key);
    $('input-key').value = '';
    actualizarBadge();
    mostrarAvisoClave(true);
  });

  $('chk-demo').addEventListener('change', (e) => {
    if (e.target.checked) {
      mostrarAvisoClave(false);
      $('hint-envio').textContent = 'Modo simulado: el orquestador usa reglas locales, sin llamar a la API.';
    } else {
      mostrarAvisoClave(!state.key);
      $('hint-envio').textContent = '';
    }
  });

  $('btn-enviar').addEventListener('click', ejecutarPedido);
  $('transcripcion').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ejecutarPedido();
    }
  });

  $('btn-exportar').addEventListener('click', descargarCorrida);
  $('btn-copiar').addEventListener('click', copiarCorrida);

  $('btn-eval').addEventListener('click', correrEvaluacion);
  $('btn-eval-exportar').addEventListener('click', exportarEvaluacion);

  $('btn-borrar-historial').addEventListener('click', () => {
    if (!state.historial.length) return;
    if (!confirm('¿Borrar el historial de este navegador?')) return;
    state.historial = [];
    localStorage.removeItem(LS.hist);
    pintarHistorial();
  });
}

document.addEventListener('DOMContentLoaded', init);
