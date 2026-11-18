from typing import Dict, List, Any, Optional
from agents.base import ConversationContext
from difflib import SequenceMatcher
import json
import random
import os
import re
from datetime import datetime

_MENU_CACHE = None


def get_menu():
    global _MENU_CACHE
    if _MENU_CACHE is None:
        # En Docker: /app/data/menu.json, en desarrollo: ../data/menu.json
        docker_path = "/app/data/menu.json"
        dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "menu.json")
        menu_path = docker_path if os.path.exists(docker_path) else dev_path
        with open(menu_path, "r", encoding="utf-8") as f:
            _MENU_CACHE = json.load(f)
    return _MENU_CACHE


def norm(s: str) -> str:
    return s.lower().strip()


def _item_resumen(item: Dict) -> Dict:
    out = {"item_id": item["id"], "nombre": item["nombre"], "categoria": item["categoria"], "stock": item["stock"]}
    if item.get("variantes"):
        out["variantes"] = [{"variante_id": v["id"], "nombre": v["nombre"], "precio": v["precio"]} for v in item["variantes"]]
    else:
        out["precio"] = item["precio"]
        out["unidad"] = item.get("unidad", "unidad")
    if item.get("extrasPermitidos"):
        out["extras_permitidos"] = item["extrasPermitidos"]
    return out


async def buscar_en_catalogo(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    consulta = norm(args.get("consulta", ""))
    if not consulta:
        return {"ok": False, "error": "Consulta vacía"}

    menu = get_menu()
    items = menu.get("items", [])

    scored = []
    for item in items:
        nombres = [item["nombre"]] + item.get("alias", [])
        nombres_norm = [norm(n) for n in nombres]

        best = 0
        for n in nombres_norm:
            if consulta == n:
                best = 100
            elif consulta in n and len(n) >= 3:
                best = max(best, 60 + len(n))
            elif n in consulta and len(consulta) >= 4:
                best = max(best, 45 + len(consulta))
            else:
                sim = SequenceMatcher(None, consulta, n).ratio()
                if sim > 0.7:
                    best = max(best, int(30 * sim))

        if best > 0:
            scored.append({"item": item, "score": best})

    scored.sort(key=lambda x: -x["score"])
    top = scored[:4]

    return {
        "ok": True,
        "encontrados": len(top),
        "items": [_item_resumen(item["item"]) for item in top]
    }


async def verificar_stock(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    item_id = args.get("item_id")
    cantidad = max(1, int(args.get("cantidad", 1)))

    menu = get_menu()
    item = next((i for i in menu["items"] if i["id"] == item_id), None)

    if not item:
        return {"ok": False, "error": f"Item {item_id} no existe"}

    return {
        "ok": True,
        "item_id": item["id"],
        "nombre": item["nombre"],
        "pedido": cantidad,
        "stock": item["stock"],
        "disponible": cantidad <= item["stock"]
    }


async def calcular_total(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    lineas = args.get("lineas", [])
    if not lineas:
        return {"ok": False, "error": "Sin líneas de pedido"}

    menu = get_menu()
    salida = []
    problemas = []
    total = 0

    for l in lineas:
        item_id = l["item_id"]
        cantidad = max(1, int(l.get("cantidad", 1)))
        variante_id = l.get("variante_id")
        extras = l.get("extras", [])

        item = next((i for i in menu["items"] if i["id"] == item_id), None)
        if not item:
            problemas.append(f'Item "{item_id}" no existe')
            continue

        variante = None
        if item.get("variantes"):
            variante = next((v for v in item["variantes"] if v["id"] == variante_id), None)
            if not variante:
                problemas.append(f'{item["nombre"]}: falta tamaño (chica/mediana/grande)')
                continue

        if cantidad > item["stock"]:
            problemas.append(f'{item["nombre"]}: pediste {cantidad}, stock {item["stock"]}')
            continue

        extras_validos = []
        for ext in extras:
            ext_item = next((e for e in menu.get("extras", []) if e["id"] == ext), None)
            if not ext_item:
                problemas.append(f'Extra "{ext}" desconocido')
                continue
            if item.get("extrasPermitidos") and ext not in item["extrasPermitidos"]:
                problemas.append(f'{item["nombre"]} no admite {ext_item["nombre"]}')
                continue
            extras_validos.append(ext_item)

        base = variante["precio"] if variante else item["precio"]
        extra_unit = sum(e["precio"] for e in extras_validos)
        subtotal = (base + extra_unit) * cantidad
        total += subtotal

        salida.append({
            "item_id": item["id"],
            "nombre": item["nombre"],
            "variante": variante["nombre"] if variante else None,
            "variante_id": variante["id"] if variante else None,
            "cantidad": cantidad,
            "extras": [e["nombre"] for e in extras_validos],
            "precio_unitario": base + extra_unit,
            "subtotal": subtotal
        })

    if problemas:
        return {"ok": False, "problemas": problemas}

    tienda = menu.get("tienda", {})
    return {
        "ok": True,
        "lineas": salida,
        "total": total,
        "moneda": tienda.get("moneda", "ARS"),
        "tiempo_estimado_min": tienda.get("tiempoEstimadoMin", 35)
    }


async def pedir_aclaracion(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    pregunta = args.get("pregunta", "").strip()
    if not pregunta:
        return {"ok": False, "error": "Pregunta vacía"}

    context.aclaracion_pendiente = pregunta
    return {"ok": True, "aclaracion": pregunta, "termina_turno": True}


async def confirmar_pedido(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    if not context.total_calculated:
        return {"ok": False, "error": "Falta calcular_total previo"}

    numero = f"#{random.randint(1000, 9999)}"
    total_data = context.total_calculated

    resultado = {
        "tipo": "confirmado",
        "numero": numero,
        "lineas": total_data["lineas"],
        "total": total_data["total"],
        "moneda": total_data["moneda"],
        "tiempo_estimado_min": total_data["tiempo_estimado_min"],
        "cliente": {
            "nombre": args.get("nombre_cliente"),
            "telefono": args.get("telefono"),
            "direccion": args.get("direccion"),
            "notas": args.get("notas")
        },
        "confirmado_en": "2024-01-01T00:00:00Z"
    }

    context.metadata["confirmacion"] = resultado
    return {
        "ok": True,
        "pedido": numero,
        "total": resultado["total"],
        "moneda": resultado["moneda"],
        "tiempo_estimado_min": resultado["tiempo_estimado_min"],
        "mensaje": "Pedido confirmado y enviado a cocina"
    }


# =====================================================================
# PRIORIDAD ALTA - Skills faltantes críticas
# =====================================================================

async def extraer_items(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Extrae items estructurados de texto libre usando matching tolerante + NLP básico."""
    texto = norm(args.get("texto", ""))
    if not texto:
        return {"ok": False, "error": "Texto vacío", "items": []}

    menu = get_menu()
    items = menu.get("items", [])

    # Detectar items usando matching tolerante (alias + fuzzy)
    items_encontrados = []
    palabras = texto.split()

    for item in items:
        nombres = [item["nombre"]] + item.get("alias", [])
        nombres_norm = [norm(n) for n in nombres]

        for nombre_norm in nombres_norm:
            # Buscar coincidencia exacta o contenida
            if nombre_norm in texto or any(nombre_norm in p for p in palabras):
                # Detectar cantidad (números antes del nombre)
                cantidad = 1
                for i, p in enumerate(palabras):
                    if nombre_norm in p or nombre_norm in (palabras[i-1] if i > 0 else ""):
                        # Buscar número antes
                        for j in range(max(0, i-2), i):
                            if palabras[j].isdigit():
                                cantidad = int(palabras[j])
                                break
                            # Números en palabras
                            num_words = {"un": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
                                       "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
                                       "un par": 2, "un pareja": 2, "media docena": 6, "docena": 12}
                            for kw, val in num_words.items():
                                if kw in palabras[j] or (j > 0 and kw in palabras[j-1]):
                                    cantidad = val
                                    break

                # Detectar variante si es pizza
                variante_id = None
                if item.get("variantes"):
                    if "grande" in texto or "familiar" in texto or "12 porciones" in texto:
                        variante_id = "grande"
                    elif "mediana" in texto or "8 porciones" in texto:
                        variante_id = "mediana"
                    elif "chica" in texto or "chiquita" in texto or "6 porciones" in texto:
                        variante_id = "chica"

                # Detectar extras
                extras = []
                for ext in item.get("extrasPermitidos", []):
                    ext_item = next((e for e in get_menu().get("extras", []) if e["id"] == ext), None)
                    if ext_item and norm(ext_item["nombre"]) in texto:
                        extras.append(ext)

                items_encontrados.append({
                    "item_id": item["id"],
                    "item": _item_resumen(item),
                    "cantidad": cantidad,
                    "variante_id": variante_id,
                    "extras": extras,
                    "confianza": 0.9
                })
                break  # Solo una mención por item

    return {
        "ok": True,
        "items": items_encontrados,
        "texto_original": args.get("texto", "")
    }


async def detectar_cantidad(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Extrae cantidad de texto ('dos', 'tres', 'un par', '3')."""
    texto = norm(args.get("texto", ""))
    if not texto:
        return {"ok": False, "error": "Texto vacío", "cantidad": 1}

    # Números directos
    match = re.search(r"\b(\d+)\b", texto)
    if match:
        return {"ok": True, "cantidad": int(match.group(1))}

    # Palabras numéricas
    num_words = {
        "un": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
        "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
        "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
        "un par": 2, "pareja": 2, "media docena": 6, "docena": 12
    }
    for palabra, valor in num_words.items():
        if re.search(rf"\b{palabra}\b", texto):
            return {"ok": True, "cantidad": valor}

    return {"ok": True, "cantidad": 1}  # Default


async def detectar_variante(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Detecta variante/tamaño en texto."""
    texto = norm(args.get("texto", ""))
    if not texto:
        return {"ok": False, "error": "Texto vacío"}

    if "grande" in args.get("texto", "") or "familiar" in args.get("texto", "") or "12 porciones" in args.get("texto", ""):
        return {"ok": True, "variante_id": "grande"}
    elif "mediana" in args.get("texto", "") or "8 porciones" in args.get("texto", ""):
        return {"ok": True, "variante_id": "mediana"}
    elif "chica" in args.get("texto", "") or "chiquita" in args.get("texto", "") or "6 porciones" in args.get("texto", ""):
        return {"ok": True, "variante_id": "chica"}
    return {"ok": True, "variante_id": None}


async def generar_pregunta_tamaño(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta para aclarar tamaño de pizza."""
    item = args.get("item", {})
    nombre = item.get("nombre", "el item")
    variantes = item.get("variantes", [])

    if not variantes:
        return {"ok": False, "error": "Item sin variantes", "pregunta": ""}

    opciones = ", ".join([v["nombre"] for v in variantes])
    pregunta = f"{nombre}: ¿la querés {opciones}?"

    return {"ok": True, "pregunta": pregunta, "tipo": "tamaño"}


async def generar_pregunta_cantidad(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta para aclarar cantidad."""
    item_nombre = args.get("item_nombre", "eso")
    pregunta = f"¿Cuántas {item_nombre} querés?"
    return {"ok": True, "pregunta": pregunta, "tipo": "cantidad"}


async def generar_pregunta_item_desconocido(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta cuando el item no existe, con sugerencias."""
    consulta = args.get("consulta", "")
    sugerencias = args.get("sugerencias", [])

    if sugerencias:
        opciones = ", ".join([s["nombre"] for s in sugerencias[:3]])
        pregunta = f"No tenemos '{consulta}'. ¿Quizás {opciones}?"
    else:
        pregunta = f"No tenemos '{consulta}'. ¿Querés que te pase la carta?"

    return {"ok": True, "pregunta": pregunta, "tipo": "item_desconocido"}


async def generar_pregunta_stock_bajo(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta cuando hay stock bajo."""
    nombre = args.get("nombre", "el item")
    stock = args.get("stock", 0)
    pedido = args.get("pedido", 1)

    if stock == 0:
        pregunta = f"De {nombre} no queda stock. ¿Querés otra cosa?"
    else:
        pregunta = f"De {nombre} quedan {stock} y pediste {pedido}. ¿Ajustamos a {stock}?"

    return {"ok": True, "pregunta": pregunta, "tipo": "stock_bajo"}


async def generar_pregunta_extras(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta para extras."""
    item_nombre = args.get("item_nombre", "eso")
    extras = args.get("extras_disponibles", [])
    if extras:
        opciones = ", ".join(extras)
        pregunta = f"¿Querés agregar {opciones} a tu {item_nombre}?"
    else:
        pregunta = f"¿Querés algún extra en tu {item_nombre}?"
    return {"ok": True, "pregunta": pregunta, "tipo": "extras"}


async def generar_pregunta_modificacion(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera pregunta para modificar un item."""
    accion = args.get("accion", "quitar")  # quitar, cambiar, agregar
    item = args.get("item", "eso")
    detalle = args.get("detalle", "")
    pregunta = f"¿{accion.capitalize()} {detalle} del {item}?"
    return {"ok": True, "pregunta": pregunta, "tipo": "modificacion"}


# =====================================================================
# PRIORIDAD MEDIA - Validator / Confirmer
# =====================================================================

async def validar_pedido_completo(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Valida pedido completo: items, tamaños, extras, stock, horarios."""
    lineas = args.get("lineas", [])
    if not lineas:
        return {"ok": False, "error": "Sin líneas de pedido", "problemas": ["Pedido vacío"]}

    menu = get_menu()
    problemas = []
    lineas_validas = []

    for l in lineas:
        item_id = l.get("item_id")
        cantidad = max(1, int(l.get("cantidad", 1)))
        variante_id = l.get("variante_id")
        extras = l.get("extras", [])

        item = next((i for i in get_menu().get("items", []) if i["id"] == item_id), None)
        if not item:
            problemas.append(f'Item "{item_id}" no existe')
            continue

        # Validar variante si es pizza
        if item.get("variantes"):
            if not variante_id:
                problemas.append(f'{item["nombre"]}: falta tamaño (chica/mediana/grande)')
                continue
            variante = next((v for v in item["variantes"] if v["id"] == variante_id), None)
            if not variante:
                problemas.append(f'{item["nombre"]}: variante "{variante_id}" no existe')
                continue

        # Validar stock
        if cantidad > item["stock"]:
            problemas.append(f'{item["nombre"]}: pediste {cantidad}, stock {item["stock"]}')
            continue

        # Validar extras
        extras_validos = []
        for ext in extras:
            ext_item = next((e for e in get_menu().get("extras", []) if e["id"] == ext), None)
            if not ext_item:
                problemas.append(f'Extra "{ext}" desconocido')
                continue
            if item.get("extrasPermitidos") and ext not in item.get("extrasPermitidos", []):
                problemas.append(f'{item["nombre"]} no admite ese extra')
                continue
            extras_validos.append(ext)

        lineas_validas.append({
            "item_id": item_id,
            "item": item,
            "cantidad": cantidad,
            "variante_id": variante_id,
            "extras": extras_validos
        })

    return {
        "ok": len(problemas) == 0,
        "problemas": problemas,
        "lineas_validas": lineas_validas
    }


async def verificar_extras_permitidos(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Verifica que los extras sean permitidos para el item."""
    item_id = args.get("item_id")
    extras = args.get("extras", [])

    menu = get_menu()
    item = next((i for i in get_menu().get("items", []) if i["id"] == item_id), None)
    if not item:
        return {"ok": False, "error": "Item no existe"}

    permitidos = item.get("extrasPermitidos", [])
    no_permitidos = [e for e in extras if e not in permitidos]

    return {
        "ok": len(no_permitidos) == 0,
        "permitidos": permitidos,
        "no_permitidos": no_permitidos
    }


async def calcular_tiempo_estimado(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Calcula tiempo de preparación basado en items."""
    lineas = args.get("lineas", [])
    if not lineas:
        return {"ok": True, "tiempo_min": 0}

    # Tiempos base por categoría
    tiempos_cat = {
        "pizzas": 35,
        "empanadas": 20,
        "bebidas": 5
    }

    tiempo_max = 0
    for l in lineas:
        item_id = l.get("item_id")
        item = next((i for i in get_menu().get("items", []) if i["id"] == item_id), None)
        if item:
            cat = item.get("categoria", "pizzas")
            tiempo_max = max(tiempo_max, {"pizzas": 35, "empanadas": 20, "bebidas": 5}.get(item.get("categoria", "pizzas"), 35))

    return {"ok": True, "tiempo_min": tiempo_max}


async def formatear_confirmacion_usuario(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Formatea confirmación bonita para el cliente."""
    data = args.get("data", {})
    if not data:
        return {"ok": False, "error": "Sin datos de confirmación"}

    lines = [f"✅ Pedido {data.get('numero', 'N/A')} confirmado"]
    lines.append("")

    for l in data.get("lineas", []):
        linea = f"  {l.get('cantidad', 1)}x {l.get('nombre', 'Item')}"
        if l.get("variante"):
            linea += f" ({l['variante']})"
        if l.get("extras"):
            linea += f" + {', '.join(l['extras'])}"
        linea += f" - ${l.get('subtotal', 0):,}"
        lines.append(linea)

    lines.append("")
    lines.append(f"Total: ${data.get('total', 0):,}")
    lines.append(f"Demora: ~{data.get('tiempo_estimado_min', 35)} min")

    if data.get("cliente", {}).get("nombre"):
        lines.append(f"Para: {data['cliente']['nombre']}")

    return {"ok": True, "texto": "\n".join(lines)}


async def generar_numero_pedido(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Genera número de pedido único."""
    # Usar timestamp + random para unicidad
    timestamp = int(datetime.now().timestamp() * 1000) % 100000
    random_part = random.randint(100, 999)
    numero = f"#{timestamp}{random_part}"
    return {"ok": True, "numero": numero, "formato": "timestamp_random"}


async def calcular_demora_entrega(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Calcula demora total: preparación + delivery según zona."""
    tiempo_prep = args.get("tiempo_preparacion", 35)
    zona = args.get("zona", "centro")

    tiempos_entrega = {
        "centro": 10,
        "norte": 15,
        "sur": 15,
        "oeste": 20,
        "este": 20
    }

    demora_entrega = tiempos_entrega.get(zona, 15)
    total = tiempo_prep + demora_entrega

    return {"ok": True, "tiempo_preparacion": args.get("tiempo_preparacion", 35), "demora_entrega": demora_entrega, "total_min": total}


async def formatear_ticket_cocina(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Formatea ticket para impresora térmica ESC/POS 80mm."""
    data = args.get("data", {})
    if not data:
        return {"ok": False, "error": "Sin datos"}

    # Formato ESC/POS simplificado (texto plano)
    lines = []
    lines.append("=" * 32)
    lines.append("   PIZZERIA LA ESQUINA")
    lines.append("   COCINA - TICKET")
    lines.append("=" * 32)
    lines.append(f"Pedido: {data.get('numero', 'N/A')}")
    lines.append(f"Hora: {datetime.now().strftime('%H:%M')}")
    lines.append("-" * 32)

    for l in data.get("lineas", []):
        linea = f"{l.get('cantidad', 1)}x {l.get('nombre', 'Item')}"
        if l.get("variante"):
            linea += f" ({l['variante']})"
        if l.get("extras"):
            linea += f" + {', '.join(l['extras'])}"
        lines.append(linea)

    lines.append("-" * 32)
    lines.append(f"Total: ${data.get('total', 0):,}")
    lines.append(f"Demora: ~{data.get('tiempo_estimado_min', 35)} min")
    lines.append("=" * 32)

    return {"ok": True, "texto_escpos": "\n".join(lines)}


async def enviar_notificacion_cliente(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Envía notificación al cliente (push/WhatsApp/SMS/Email)."""
    canal = args.get("canal", "push")
    mensaje = args.get("mensaje", "")
    destino = args.get("destino", "")

    # Placeholder - implementar integración real
    return {"ok": True, "enviado": True, "canal": canal, "destino": destino, "message_id": f"msg_{random.randint(1000,9999)}"}


async def imprimir_ticket_cocina(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Envía ticket a impresora térmica o KDS."""
    ticket = args.get("ticket", "")
    impresora = args.get("impresora", "cocina_principal")

    # Placeholder - implementar ESC/POS real
    return {"ok": True, "impreso": True, "impresora": impresora, "bytes": len(ticket)}


async def registrar_pedido_bd(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Persiste pedido en BD con idempotencia."""
    data = args.get("data", {})
    # Placeholder: implementar Supabase/PostgreSQL
    return {"ok": True, "guardado": True, "pedido_id": data.get("numero", ""), "idempotency_key": args.get("idempotency_key")}


async def registrar_evento_analytics(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Registra evento en analytics (Mixpanel/Amplitude/GA4)."""
    evento = args.get("evento")
    propiedades = args.get("propiedades", {})
    user_id = args.get("user_id")

    # Placeholder - implementar Mixpanel/Amplitude/GA4
    return {"ok": True, "registrado": True, "event_id": f"evt_{random.randint(10000,99999)}"}


async def decidir_siguiente_agente(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Decide próximo agente basado en contexto."""
    ctx = args.get("contexto", {})

    # Reglas de routing
    if ctx.get("aclaracion_pendiente"):
        return {"ok": True, "siguiente_agente": "clarifier", "razon": "Hay aclaración pendiente"}
    if not ctx.get("items_parsed"):
        return {"ok": True, "siguiente_agente": "intake", "razon": "No hay items parseados"}
    if ctx.get("items_parsed") and not ctx.get("total_calculated"):
        return {"ok": True, "siguiente_agente": "validator", "razon": "Items listos para validar"}
    if ctx.get("total_calculated") and not ctx.get("metadata", {}).get("confirmacion"):
        return {"ok": True, "siguiente_agente": "confirmer", "razon": "Total calculado, listo para confirmar"}

    return {"ok": True, "siguiente_agente": "intake", "razon": "Default: intake"}


async def evaluar_completitud_pedido(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Evalúa si el pedido está completo para confirmar."""
    ctx = args.get("contexto", {})
    checks = {
        "tiene_items": bool(ctx.get("items_parsed")),
        "tiene_tamanos": all(l.get("variante_id") for l in ctx.get("items_parsed", []) if l.get("item", {}).get("variantes")),
        "tiene_stock_ok": all(l.get("cantidad", 1) <= l.get("item", {}).get("stock", 999) for l in ctx.get("items_parsed", [])),
        "tiene_total": bool(ctx.get("total_calculated")),
    }

    completo = all(checks.values())
    faltantes = [k for k, v in checks.items() if not v]

    return {"ok": True, "completo": completo, "checks": checks, "faltantes": faltantes}


async def manejar_error_global(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Manejo centralizado de errores con recovery."""
    error = args.get("error", "Error desconocido")
    agente = args.get("agente", "desconocido")

    # Log del error
    print(f"ERROR en {agente}: {error}")

    # Estrategias de recovery
    if "stock" in str(error).lower():
        recovery = "Ofrecer alternativas o ajustar cantidad"
    elif "variante" in str(error).lower() or "tamaño" in str(error).lower():
        recovery = "Preguntar tamaño faltante"
    elif "item" in str(error).lower() and "existe" in str(error).lower():
        recovery = "Sugerir alternativas del catálogo"
    else:
        recovery = "Contactar soporte / reintentar"

    return {"ok": True, "error": error, "agente": agente, "recovery_sugerido": recovery}


async def gestionar_timeouts(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Gestiona timeouts por agente con reintentos."""
    agente = args.get("agente", "desconocido")
    timeout_seg = args.get("timeout", 30)
    intento = args.get("intento", 1)
    max_intentos = args.get("max_intentos", 3)

    if intento >= max_intentos:
        return {"ok": False, "accion": "escalar", "mensaje": f"Max intentos ({max_intentos}) alcanzado para {agente}"}

    return {"ok": True, "accion": "reintentar", "siguiente_intento": intento + 1, "timeout": timeout_seg}


async def persistir_contexto(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    """Guarda/restaura contexto entre reconexiones WebSocket."""
    accion = args.get("accion", "guardar")  # guardar, restaurar
    session_id = args.get("session_id", context.session_id)

    if accion == "guardar":
        data = context.model_dump()
        # Placeholder: guardar en Redis/DB
        return {"ok": True, "guardado": True, "session_id": session_id}
    else:
        # Placeholder: restaurar de Redis/DB
        return {"ok": True, "restaurado": True, "session_id": session_id}


# =====================================================================
# Skills futuras (deshabilitadas - placeholders)
# =====================================================================

async def whatsapp_enviar_mensaje(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "WhatsApp no configurado. Requiere servidor local con whatsapp-web.js (puerto 3001)"}


async def whatsapp_recibir_mensaje(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "WhatsApp no configurado"}


async def notificar_push(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Push notifications no configurado. Requiere VAPID keys"}


async def notificar_email(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Email no configurado. Requiere SendGrid/Resend"}


async def cocina_imprimir_ticket(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Impresora cocina no configurada. Requiere ESC/POS"}


async def cocina_estado_pedido(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Sistema de cocina no integrado. Requiere API cocina o base compartida"}


async def analytics_registrar_evento(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": True, "registrado": True, "evento": args.get("evento")}


async def analytics_obtener_metricas(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Analytics no configurado. Requiere backend con base de datos de pedidos"}


async def cliente_buscar_o_crear(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "CRM clientes no configurado. Requiere base de datos (Supabase/Firebase/SQLite)"}


async def cliente_historial(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Historial clientes no configurado. Requiere base de datos"}


async def config_obtener(args: Dict[str, Any], context: ConversationContext) -> Dict[str, Any]:
    return {"ok": False, "error": "Config remota no configurada. Requiere: Firebase Remote Config / LaunchDarkly / Supabase"}


SKILL_DEFINITIONS = {
    # MVP - Skills habilitadas
    "buscar_en_catalogo": {
        "description": "Busca platos/bebidas por nombre, alias o descripción. Tolerante a errores de transcripción.",
        "parameters": {
            "type": "object",
            "properties": {"consulta": {"type": "string", "description": "Ej: 'muzza grande' o 'cerveza'"}},
            "required": ["consulta"]
        },
        "returns": {
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "object"}},
                "encontrados": {"type": "integer"}
            }
        },
        "fn": buscar_en_catalogo,
        "terminates_turn": False
    },
    "verificar_stock": {
        "description": "Verifica disponibilidad de un item para una cantidad.",
        "parameters": {
            "type": "object",
            "properties": {"item_id": {"type": "string"}, "cantidad": {"type": "integer", "minimum": 1}},
            "required": ["item_id", "cantidad"]
        },
        "returns": {
            "type": "object",
            "properties": {
                "item_id": {"type": "string"},
                "nombre": {"type": "string"},
                "pedido": {"type": "integer"},
                "stock": {"type": "integer"},
                "disponible": {"type": "boolean"}
            }
        },
        "fn": verificar_stock,
        "terminates_turn": False
    },
    "calcular_total": {
        "description": "Valida pedido completo (items, tamaños, extras, stock) y devuelve total. OBLIGATORIO antes de confirmar.",
        "parameters": {
            "type": "object",
            "properties": {
                "lineas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_id": {"type": "string"},
                            "variante_id": {"type": "string", "enum": ["chica", "mediana", "grande"]},
                            "cantidad": {"type": "integer", "minimum": 1},
                            "extras": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["item_id", "cantidad"]
                    }
                }
            },
            "required": ["lineas"]
        },
        "fn": calcular_total,
        "terminates_turn": False
    },
    "pedir_aclaracion": {
        "description": "Pregunta al cliente cuando falta un dato esencial. TERMINA el turno actual.",
        "parameters": {
            "type": "object",
            "properties": {"pregunta": {"type": "string", "description": "Pregunta corta en español rioplatense"}},
            "required": ["pregunta"]
        },
        "fn": pedir_aclaracion,
        "terminates_turn": True
    },
    "confirmar_pedido": {
        "description": "Confirma pedido YA VALIDADO (requiere calcular_total previo). Genera número y demora.",
        "parameters": {
            "type": "object",
            "properties": {
                "nombre_cliente": {"type": "string"},
                "telefono": {"type": "string"},
                "direccion": {"type": "string"},
                "notas": {"type": "string"}
            }
        },
        "fn": confirmar_pedido,
        "terminates_turn": False
    },

    # PRIORIDAD ALTA - Skills faltantes críticas
    "extraer_items": {
        "description": "Extrae items estructurados de texto libre usando matching tolerante + NLP básico.",
        "parameters": {
            "type": "object",
            "properties": {"texto": {"type": "string", "description": "Texto libre del cliente"}},
            "required": ["texto"]
        },
        "returns": {
            "type": "object",
            "properties": {
                "items": {"type": "array", "items": {"type": "object"}},
                "texto_original": {"type": "string"}
            }
        },
        "fn": extraer_items,
        "terminates_turn": False
    },
    "detectar_cantidad": {
        "description": "Extrae cantidad de texto ('dos', 'tres', 'un par', '3').",
        "parameters": {
            "type": "object",
            "properties": {"texto": {"type": "string"}},
            "required": ["texto"]
        },
        "returns": {"type": "object", "properties": {"cantidad": {"type": "integer"}}},
        "fn": detectar_cantidad,
        "terminates_turn": False
    },
    "detectar_variante": {
        "description": "Detecta variante/tamaño en texto.",
        "parameters": {
            "type": "object",
            "properties": {"texto": {"type": "string"}},
            "required": ["texto"]
        },
        "returns": {"type": "object", "properties": {"variante_id": {"type": "string"}}},
        "fn": detectar_variante,
        "terminates_turn": False
    },
    "generar_pregunta_tamaño": {
        "description": "Genera pregunta para aclarar tamaño de pizza.",
        "parameters": {
            "type": "object",
            "properties": {"item": {"type": "object"}},
            "required": ["item"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_tamaño,
        "terminates_turn": True
    },
    "generar_pregunta_cantidad": {
        "description": "Genera pregunta para aclarar cantidad.",
        "parameters": {
            "type": "object",
            "properties": {"item_nombre": {"type": "string"}},
            "required": ["item_nombre"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_cantidad,
        "terminates_turn": True
    },
    "generar_pregunta_item_desconocido": {
        "description": "Genera pregunta cuando el item no existe, con sugerencias.",
        "parameters": {
            "type": "object",
            "properties": {"consulta": {"type": "string"}, "sugerencias": {"type": "array"}},
            "required": ["consulta"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_item_desconocido,
        "terminates_turn": True
    },
    "generar_pregunta_stock_bajo": {
        "description": "Genera pregunta cuando hay stock bajo.",
        "parameters": {
            "type": "object",
            "properties": {"nombre": {"type": "string"}, "stock": {"type": "integer"}, "pedido": {"type": "integer"}},
            "required": ["nombre", "stock", "pedido"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_stock_bajo,
        "terminates_turn": True
    },
    "generar_pregunta_extras": {
        "description": "Genera pregunta para extras.",
        "parameters": {
            "type": "object",
            "properties": {"item_nombre": {"type": "string"}, "extras_disponibles": {"type": "array"}},
            "required": ["item_nombre"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_extras,
        "terminates_turn": True
    },
    "generar_pregunta_modificacion": {
        "description": "Genera pregunta para modificar un item.",
        "parameters": {
            "type": "object",
            "properties": {"accion": {"type": "string"}, "item": {"type": "string"}, "detalle": {"type": "string"}},
            "required": ["accion", "item", "detalle"]
        },
        "returns": {"type": "object", "properties": {"pregunta": {"type": "string"}, "tipo": {"type": "string"}}},
        "fn": generar_pregunta_modificacion,
        "terminates_turn": True
    },

    # PRIORIDAD MEDIA
    "validar_pedido_completo": {
        "description": "Valida pedido completo: items, tamaños, extras, stock, horarios.",
        "parameters": {
            "type": "object",
            "properties": {
                "lineas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_id": {"type": "string"},
                            "cantidad": {"type": "integer", "minimum": 1},
                            "variante_id": {"type": "string"},
                            "extras": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["item_id", "cantidad"]
                    }
                }
            },
            "required": ["lineas"]
        },
        "fn": validar_pedido_completo,
        "terminates_turn": False
    },
    "verificar_extras_permitidos": {
        "description": "Verifica que los extras sean permitidos para el item.",
        "parameters": {
            "type": "object",
            "properties": {
                "item_id": {"type": "string"},
                "extras": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["item_id", "extras"]
        },
        "fn": verificar_extras_permitidos,
        "terminates_turn": False
    },
    "calcular_tiempo_estimado": {
        "description": "Calcula tiempo de preparación basado en items.",
        "parameters": {
            "type": "object",
            "properties": {
                "lineas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_id": {"type": "string"}
                        },
                        "required": ["item_id"]
                    }
                }
            },
            "required": ["lineas"]
        },
        "fn": calcular_tiempo_estimado,
        "terminates_turn": False
    },
    "formatear_confirmacion_usuario": {
        "description": "Formatea confirmación bonita para el cliente.",
        "parameters": {
            "type": "object",
            "properties": {"data": {"type": "object"}},
            "required": ["data"]
        },
        "fn": formatear_confirmacion_usuario,
        "terminates_turn": False
    },
    "generar_numero_pedido": {
        "description": "Genera número de pedido único (timestamp + random).",
        "parameters": {"type": "object", "properties": {}},
        "fn": generar_numero_pedido,
        "terminates_turn": False
    },
    "calcular_demora_entrega": {
        "description": "Calcula demora total: preparación + delivery según zona.",
        "parameters": {
            "type": "object",
            "properties": {
                "tiempo_preparacion": {"type": "integer"},
                "zona": {"type": "string"}
            },
            "required": ["tiempo_preparacion", "zona"]
        },
        "fn": calcular_demora_entrega,
        "terminates_turn": False
    },
    "formatear_confirmacion_usuario": {
        "description": "Formatea confirmación bonita para el cliente.",
        "parameters": {
            "type": "object",
            "properties": {"data": {"type": "object"}},
            "required": ["data"]
        },
        "fn": formatear_confirmacion_usuario,
        "terminates_turn": False
    },
    "formatear_ticket_cocina": {
        "description": "Formatea ticket ESC/POS 80mm para impresora térmica.",
        "parameters": {
            "type": "object",
            "properties": {"data": {"type": "object"}},
            "required": ["data"]
        },
        "fn": formatear_ticket_cocina,
        "terminates_turn": False
    },
    "enviar_notificacion_cliente": {
        "description": "Envía notificación al cliente (push/WhatsApp/SMS/Email).",
        "parameters": {
            "type": "object",
            "properties": {
                "canal": {"type": "string", "enum": ["push", "whatsapp", "sms", "email"]},
                "mensaje": {"type": "string"},
                "destino": {"type": "string"}
            },
            "required": ["canal", "mensaje", "destino"]
        },
        "fn": enviar_notificacion_cliente,
        "terminates_turn": False
    },
    "imprimir_ticket_cocina": {
        "description": "Envía ticket a impresora térmica o KDS.",
        "parameters": {
            "type": "object",
            "properties": {"ticket": {"type": "string"}, "impresora": {"type": "string"}},
            "required": ["ticket", "impresora"]
        },
        "fn": imprimir_ticket_cocina,
        "terminates_turn": False
    },
    "registrar_pedido_bd": {
        "description": "Persiste pedido en BD con idempotencia (Supabase/PostgreSQL).",
        "parameters": {
            "type": "object",
            "properties": {
                "data": {"type": "object"},
                "idempotency_key": {"type": "string"}
            },
            "required": ["data"]
        },
        "fn": registrar_pedido_bd,
        "terminates_turn": False
    },
    "registrar_evento_analytics": {
        "description": "Registra evento en analytics (Mixpanel/Amplitude/GA4).",
        "parameters": {
            "type": "object",
            "properties": {
                "evento": {"type": "string"},
                "propiedades": {"type": "object"},
                "user_id": {"type": "string"}
            },
            "required": ["evento"]
        },
        "fn": registrar_evento_analytics,
        "terminates_turn": False
    },
    "decidir_siguiente_agente": {
        "description": "Decide próximo agente basado en contexto (reglas de routing).",
        "parameters": {
            "type": "object",
            "properties": {"contexto": {"type": "object"}},
            "required": ["contexto"]
        },
        "fn": decidir_siguiente_agente,
        "terminates_turn": False
    },
    "evaluar_completitud_pedido": {
        "description": "Evalúa si el pedido está completo para confirmar.",
        "parameters": {
            "type": "object",
            "properties": {"contexto": {"type": "object"}},
            "required": ["contexto"]
        },
        "fn": evaluar_completitud_pedido,
        "terminates_turn": False
    },
    "manejar_error_global": {
        "description": "Manejo centralizado de errores con recovery sugerido.",
        "parameters": {
            "type": "object",
            "properties": {"error": {"type": "string"}, "agente": {"type": "string"}},
            "required": ["error", "agente"]
        },
        "fn": manejar_error_global,
        "terminates_turn": False
    },
    "gestionar_timeouts": {
        "description": "Gestiona timeouts por agente con reintentos y escalado.",
        "parameters": {
            "type": "object",
            "properties": {
                "agente": {"type": "string"},
                "timeout": {"type": "integer"},
                "intento": {"type": "integer"},
                "max_intentos": {"type": "integer"}
            },
            "required": ["agente"]
        },
        "fn": gestionar_timeouts,
        "terminates_turn": False
    },
    "persistir_contexto": {
        "description": "Guarda/restaura contexto entre reconexiones WebSocket.",
        "parameters": {
            "type": "object",
            "properties": {
                "accion": {"type": "string", "enum": ["guardar", "restaurar"]},
                "session_id": {"type": "string"}
            },
            "required": ["accion"]
        },
        "fn": persistir_contexto,
        "terminates_turn": False
    },

    # Futuras (deshabilitadas - placeholders)
    "whatsapp_enviar_mensaje": {
        "description": "[FUTURO] Envía mensaje via WhatsApp Web API.",
        "enabled": False,
        "fn": whatsapp_enviar_mensaje
    },
    "whatsapp_recibir_mensaje": {
        "description": "[FUTURO] Polling mensajes entrantes WhatsApp.",
        "enabled": False,
        "fn": whatsapp_recibir_mensaje
    },
    "notificar_push": {
        "description": "[FUTURO] Push notification via Web Push/Firebase.",
        "enabled": False,
        "fn": notificar_push
    },
    "notificar_email": {
        "description": "[FUTURO] Email via SendGrid/Resend.",
        "enabled": False,
        "fn": notificar_email
    },
    "cocina_imprimir_ticket": {
        "description": "[FUTURO] Imprime ticket ESC/POS 80mm.",
        "enabled": False,
        "fn": cocina_imprimir_ticket
    },
    "cocina_estado_pedido": {
        "description": "[FUTURO] Consulta estado de pedido en cocina.",
        "enabled": False,
        "fn": cocina_estado_pedido
    },
    "analytics_registrar_evento": {
        "description": "[FUTURO] Registra evento en analytics (Mixpanel/Amplitude/GA4).",
        "enabled": False,
        "fn": analytics_registrar_evento
    },
    "analytics_obtener_metricas": {
        "description": "[FUTURO] Consulta métricas agregadas.",
        "enabled": False,
        "fn": analytics_obtener_metricas
    },
    "cliente_buscar_o_crear": {
        "description": "[FUTURO] CRM: busca/crea cliente por teléfono.",
        "enabled": False,
        "fn": cliente_buscar_o_crear
    },
    "cliente_historial": {
        "description": "[FUTURO] Historial de pedidos de un cliente.",
        "enabled": False,
        "fn": cliente_historial
    },
    "config_obtener": {
        "description": "[FUTURO] Config remota (feature flags, precios dinámicos).",
        "enabled": False,
        "fn": config_obtener
    },
    # Skills de clarificación (para clarifier)
    "generar_pregunta_tamaño": {
        "description": "Genera pregunta para aclarar tamaño de pizza.",
        "parameters": {"type": "object", "properties": {"item": {"type": "object"}}, "required": ["item"]},
        "fn": generar_pregunta_tamaño,
        "terminates_turn": True
    },
    "generar_pregunta_cantidad": {
        "description": "Genera pregunta para aclarar cantidad.",
        "parameters": {"type": "object", "properties": {"item_nombre": {"type": "string"}}, "required": ["item_nombre"]},
        "fn": generar_pregunta_cantidad,
        "terminates_turn": True
    },
    "generar_pregunta_item_desconocido": {
        "description": "Genera pregunta cuando el item no existe, con sugerencias.",
        "parameters": {
            "type": "object",
            "properties": {"consulta": {"type": "string"}, "sugerencias": {"type": "array"}},
            "required": ["consulta"]
        },
        "fn": generar_pregunta_item_desconocido,
        "terminates_turn": True
    },
    "generar_pregunta_stock_bajo": {
        "description": "Genera pregunta cuando hay stock bajo.",
        "parameters": {
            "type": "object",
            "properties": {"nombre": {"type": "string"}, "stock": {"type": "integer"}, "pedido": {"type": "integer"}},
            "required": ["nombre", "stock", "pedido"]
        },
        "fn": generar_pregunta_stock_bajo,
        "terminates_turn": True
    },
    "generar_pregunta_extras": {
        "description": "Genera pregunta para extras.",
        "parameters": {
            "type": "object",
            "properties": {"item_nombre": {"type": "string"}, "extras_disponibles": {"type": "array"}},
            "required": ["item_nombre"]
        },
        "fn": generar_pregunta_extras,
        "terminates_turn": True
    },
    "generar_pregunta_modificacion": {
        "description": "Genera pregunta para modificar un item.",
        "parameters": {
            "type": "object",
            "properties": {"accion": {"type": "string"}, "item": {"type": "string"}, "detalle": {"type": "string"}},
            "required": ["accion", "item", "detalle"]
        },
        "fn": generar_pregunta_modificacion,
        "terminates_turn": True
    },
    # Validator skills
    "validar_pedido_completo": {
        "description": "Valida pedido completo: items, tamaños, extras, stock, horarios.",
        "parameters": {
            "type": "object",
            "properties": {
                "lineas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "item_id": {"type": "string"},
                            "cantidad": {"type": "integer", "minimum": 1},
                            "variante_id": {"type": "string"},
                            "extras": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["item_id", "cantidad"]
                    }
                }
            },
            "required": ["lineas"]
        },
        "fn": validar_pedido_completo,
        "terminates_turn": False
    },
    "verificar_extras_permitidos": {
        "description": "Verifica que los extras sean permitidos para el item.",
        "parameters": {
            "type": "object",
            "properties": {
                "item_id": {"type": "string"},
                "extras": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["item_id", "extras"]
        },
        "fn": verificar_extras_permitidos,
        "terminates_turn": False
    },
    "calcular_tiempo_estimado": {
        "description": "Calcula tiempo de preparación basado en items.",
        "parameters": {
            "type": "object",
            "properties": {"lineas": {"type": "array", "items": {"type": "object", "properties": {"item_id": {"type": "string"}}}}},
            "required": ["lineas"]
        },
        "fn": calcular_tiempo_estimado,
        "terminates_turn": False
    },
    # Confirmer skills
    "formatear_confirmacion_usuario": {
        "description": "Formatea confirmación bonita para el cliente.",
        "parameters": {"type": "object", "properties": {"data": {"type": "object"}}, "required": ["data"]},
        "fn": formatear_confirmacion_usuario,
        "terminates_turn": False
    },
    "generar_numero_pedido": {
        "description": "Genera número de pedido único (timestamp + random).",
        "fn": generar_numero_pedido,
        "terminates_turn": False
    },
    "calcular_demora_entrega": {
        "description": "Calcula demora total: preparación + delivery según zona.",
        "parameters": {
            "type": "object",
            "properties": {"tiempo_preparacion": {"type": "integer"}, "zona": {"type": "string"}},
            "required": ["tiempo_preparacion", "zona"]
        },
        "fn": calcular_demora_entrega,
        "terminates_turn": False
    },
    "formatear_ticket_cocina": {
        "description": "Formatea ticket ESC/POS 80mm para impresora térmica.",
        "parameters": {"type": "object", "properties": {"data": {"type": "object"}}, "required": ["data"]},
        "fn": formatear_ticket_cocina,
        "terminates_turn": False
    },
    "enviar_notificacion_cliente": {
        "description": "Envía notificación al cliente (push/WhatsApp/SMS/Email).",
        "parameters": {
            "type": "object",
            "properties": {"canal": {"type": "string"}, "mensaje": {"type": "string"}, "destino": {"type": "string"}},
            "required": ["canal", "mensaje", "destino"]
        },
        "fn": enviar_notificacion_cliente,
        "terminates_turn": False
    },
    "imprimir_ticket_cocina": {
        "description": "Envía ticket a impresora térmica o KDS.",
        "parameters": {"type": "object", "properties": {"ticket": {"type": "string"}, "impresora": {"type": "string"}}, "required": ["ticket", "impresora"]},
        "fn": imprimir_ticket_cocina,
        "terminates_turn": False
    },
    "registrar_pedido_bd": {
        "description": "Persiste pedido en BD con idempotencia (Supabase/PostgreSQL).",
        "parameters": {"type": "object", "properties": {"data": {"type": "object"}, "idempotency_key": {"type": "string"}}, "required": ["data"]},
        "fn": registrar_pedido_bd,
        "terminates_turn": False
    },
    "registrar_evento_analytics": {
        "description": "Registra evento en analytics (Mixpanel/Amplitude/GA4).",
        "parameters": {"type": "object", "properties": {"evento": {"type": "string"}, "propiedades": {"type": "object"}, "user_id": {"type": "string"}}, "required": ["evento"]},
        "fn": registrar_evento_analytics,
        "terminates_turn": False
    },
    # Orchestrator skills
    "decidir_siguiente_agente": {
        "description": "Decide próximo agente basado en contexto (reglas de routing).",
        "parameters": {"type": "object", "properties": {"contexto": {"type": "object"}}, "required": ["contexto"]},
        "fn": decidir_siguiente_agente,
        "terminates_turn": False
    },
    "evaluar_completitud_pedido": {
        "description": "Evalúa si el pedido está completo para confirmar.",
        "parameters": {"type": "object", "properties": {"contexto": {"type": "object"}}, "required": ["contexto"]},
        "fn": evaluar_completitud_pedido,
        "terminates_turn": False
    },
    "manejar_error_global": {
        "description": "Manejo centralizado de errores con recovery sugerido.",
        "parameters": {"type": "object", "properties": {"error": {"type": "string"}, "agente": {"type": "string"}}, "required": ["error", "agente"]},
        "fn": manejar_error_global,
        "terminates_turn": False
    },
    "gestionar_timeouts": {
        "description": "Gestiona timeouts por agente con reintentos y escalado.",
        "parameters": {"type": "object", "properties": {"agente": {"type": "string"}, "timeout": {"type": "integer"}, "intento": {"type": "integer"}, "max_intentos": {"type": "integer"}}, "required": ["agente"]},
        "fn": gestionar_timeouts,
        "terminates_turn": False
    },
    "persistir_contexto": {
        "description": "Guarda/restaura contexto entre reconexiones WebSocket.",
        "parameters": {"type": "object", "properties": {"accion": {"type": "string", "enum": ["guardar", "restaurar"]}, "session_id": {"type": "string"}}, "required": ["accion"]},
        "fn": persistir_contexto,
        "terminates_turn": False
    },
    # Futuras
    "whatsapp_enviar_mensaje": {"description": "[FUTURO] Envía mensaje via WhatsApp Web API.", "enabled": False, "fn": whatsapp_enviar_mensaje},
    "whatsapp_recibir_mensaje": {"description": "[FUTURO] Polling mensajes entrantes WhatsApp.", "enabled": False, "fn": whatsapp_recibir_mensaje},
    "notificar_push": {"description": "[FUTURO] Push notification via Web Push/Firebase.", "enabled": False, "fn": notificar_push},
    "notificar_email": {"description": "[FUTURO] Email via SendGrid/Resend.", "enabled": False, "fn": notificar_email},
    "cocina_imprimir_ticket": {"description": "[FUTURO] Imprime ticket ESC/POS 80mm.", "enabled": False, "fn": cocina_imprimir_ticket},
    "cocina_estado_pedido": {"description": "[FUTURO] Consulta estado de pedido en cocina.", "enabled": False, "fn": cocina_estado_pedido},
    "analytics_registrar_evento": {"description": "[FUTURO] Registra evento en analytics.", "enabled": False, "fn": analytics_registrar_evento},
    "analytics_obtener_metricas": {"description": "[FUTURO] Consulta métricas agregadas.", "enabled": False, "fn": analytics_obtener_metricas},
    "cliente_buscar_o_crear": {"description": "[FUTURO] CRM: busca/crea cliente por teléfono.", "enabled": False, "fn": cliente_buscar_o_crear},
    "cliente_historial": {"description": "[FUTURO] Historial de pedidos de un cliente.", "enabled": False, "fn": cliente_historial},
    "config_obtener": {"description": "[FUTURO] Config remota (feature flags, precios dinámicos).", "enabled": False, "fn": config_obtener},
    # Skills de clarificación (para clarifier)
    "generar_pregunta_tamaño": {"description": "Genera pregunta para aclarar tamaño de pizza.", "parameters": {"type": "object", "properties": {"item": {"type": "object"}}, "required": ["item"]}, "fn": generar_pregunta_tamaño, "terminates_turn": True},
    "generar_pregunta_cantidad": {"description": "Genera pregunta para aclarar cantidad.", "parameters": {"type": "object", "properties": {"item_nombre": {"type": "string"}}, "required": ["item_nombre"]}, "fn": generar_pregunta_cantidad, "terminates_turn": True},
    "generar_pregunta_item_desconocido": {"description": "Genera pregunta cuando el item no existe, con sugerencias.", "parameters": {"type": "object", "properties": {"consulta": {"type": "string"}, "sugerencias": {"type": "array"}}, "required": ["consulta"]}, "fn": generar_pregunta_item_desconocido, "terminates_turn": True},
    "generar_pregunta_stock_bajo": {"description": "Genera pregunta cuando hay stock bajo.", "parameters": {"type": "object", "properties": {"nombre": {"type": "string"}, "stock": {"type": "integer"}, "pedido": {"type": "integer"}}, "required": ["nombre", "stock", "pedido"]}, "fn": generar_pregunta_stock_bajo, "terminates_turn": True},
    "generar_pregunta_extras": {"description": "Genera pregunta para extras.", "parameters": {"type": "object", "properties": {"item_nombre": {"type": "string"}, "extras_disponibles": {"type": "array"}}, "required": ["item_nombre"]}, "fn": generar_pregunta_extras, "terminates_turn": True},
    "generar_pregunta_modificacion": {"description": "Genera pregunta para modificar un item.", "parameters": {"type": "object", "properties": {"accion": {"type": "string"}, "item": {"type": "string"}, "detalle": {"type": "string"}}, "required": ["accion", "item", "detalle"]}, "fn": generar_pregunta_modificacion, "terminates_turn": True},
    # Validator skills
    "validar_pedido_completo": {"description": "Valida pedido completo: items, tamaños, extras, stock, horarios.", "parameters": {"type": "object", "properties": {"lineas": {"type": "array", "items": {"type": "object", "properties": {"item_id": {"type": "string"}, "cantidad": {"type": "integer", "minimum": 1}, "variante_id": {"type": "string"}, "extras": {"type": "array", "items": {"type": "string"}}}, "required": ["item_id", "cantidad"]}}}, "required": ["lineas"]}, "fn": validar_pedido_completo, "terminates_turn": False},
    "verificar_extras_permitidos": {"description": "Verifica que los extras sean permitidos para el item.", "parameters": {"type": "object", "properties": {"item_id": {"type": "string"}, "extras": {"type": "array", "items": {"type": "string"}}}, "required": ["item_id", "extras"]}, "fn": verificar_extras_permitidos, "terminates_turn": False},
    "calcular_tiempo_estimado": {"description": "Calcula tiempo de preparación basado en items.", "parameters": {"type": "object", "properties": {"lineas": {"type": "array", "items": {"type": "object", "properties": {"item_id": {"type": "string"}}}}}, "required": ["lineas"]}, "fn": calcular_tiempo_estimado, "terminates_turn": False},
    # Confirmer skills
    "formatear_confirmacion_usuario": {"description": "Formatea confirmación bonita para el cliente.", "parameters": {"type": "object", "properties": {"data": {"type": "object"}}, "required": ["data"]}, "fn": formatear_confirmacion_usuario, "terminates_turn": False},
    "generar_numero_pedido": {"description": "Genera número de pedido único (timestamp + random).", "fn": generar_numero_pedido, "terminates_turn": False},
    "calcular_demora_entrega": {"description": "Calcula demora total: preparación + delivery según zona.", "parameters": {"type": "object", "properties": {"tiempo_preparacion": {"type": "integer"}, "zona": {"type": "string"}}, "required": ["tiempo_preparacion", "zona"]}, "fn": calcular_demora_entrega, "terminates_turn": False},
    "formatear_ticket_cocina": {"description": "Formatea ticket ESC/POS 80mm para impresora térmica.", "parameters": {"type": "object", "properties": {"data": {"type": "object"}}, "required": ["data"]}, "fn": formatear_ticket_cocina, "terminates_turn": False},
    "enviar_notificacion_cliente": {"description": "Envía notificación al cliente (push/WhatsApp/SMS/Email).", "parameters": {"type": "object", "properties": {"canal": {"type": "string", "enum": ["push", "whatsapp", "sms", "email"]}, "mensaje": {"type": "string"}, "destino": {"type": "string"}}, "required": ["canal", "mensaje", "destino"]}, "fn": enviar_notificacion_cliente, "terminates_turn": False},
    "imprimir_ticket_cocina": {"description": "Envía ticket a impresora térmica o KDS.", "parameters": {"type": "object", "properties": {"ticket": {"type": "string"}, "impresora": {"type": "string"}}, "required": ["ticket", "impresora"]}, "fn": imprimir_ticket_cocina, "terminates_turn": False},
    "registrar_pedido_bd": {"description": "Persiste pedido en BD con idempotencia (Supabase/PostgreSQL).", "parameters": {"type": "object", "properties": {"data": {"type": "object"}, "idempotency_key": {"type": "string"}}, "required": ["data"]}, "fn": registrar_pedido_bd, "terminates_turn": False},
    "registrar_evento_analytics": {"description": "Registra evento en analytics (Mixpanel/Amplitude/GA4).", "parameters": {"type": "object", "properties": {"evento": {"type": "string"}, "propiedades": {"type": "object"}, "user_id": {"type": "string"}}, "required": ["evento"]}, "fn": registrar_evento_analytics, "terminates_turn": False},
    # Orchestrator skills
    "decidir_siguiente_agente": {"description": "Decide próximo agente basado en contexto (reglas de routing).", "parameters": {"type": "object", "properties": {"contexto": {"type": "object"}}, "required": ["contexto"]}, "fn": decidir_siguiente_agente, "terminates_turn": False},
    "evaluar_completitud_pedido": {"description": "Evalúa si el pedido está completo para confirmar.", "parameters": {"type": "object", "properties": {"contexto": {"type": "object"}}, "required": ["contexto"]}, "fn": evaluar_completitud_pedido, "terminates_turn": False},
    "manejar_error_global": {"description": "Manejo centralizado de errores con recovery sugerido.", "parameters": {"type": "object", "properties": {"error": {"type": "string"}, "agente": {"type": "string"}}, "required": ["error", "agente"]}, "fn": manejar_error_global, "terminates_turn": False},
    "gestionar_timeouts": {"description": "Gestiona timeouts por agente con reintentos y escalado.", "parameters": {"type": "object", "properties": {"agente": {"type": "string"}, "timeout": {"type": "integer"}, "intento": {"type": "integer"}, "max_intentos": {"type": "integer"}}, "required": ["agente"]}, "fn": gestionar_timeouts, "terminates_turn": False},
    "persistir_contexto": {"description": "Guarda/restaura contexto entre reconexiones WebSocket.", "parameters": {"type": "object", "properties": {"accion": {"type": "string", "enum": ["guardar", "restaurar"]}, "session_id": {"type": "string"}}, "required": ["accion"]}, "fn": persistir_contexto, "terminates_turn": False},
    # Futuras
    "whatsapp_enviar_mensaje": {"description": "[FUTURO] Envía mensaje via WhatsApp Web API.", "enabled": False, "fn": whatsapp_enviar_mensaje},
    "whatsapp_recibir_mensaje": {"description": "[FUTURO] Polling mensajes entrantes WhatsApp.", "enabled": False, "fn": whatsapp_recibir_mensaje},
    "notificar_push": {"description": "[FUTURO] Push notification via Web Push/Firebase.", "enabled": False, "fn": notificar_push},
    "notificar_email": {"description": "[FUTURO] Email via SendGrid/Resend.", "enabled": False, "fn": notificar_email},
    "cocina_imprimir_ticket": {"description": "[FUTURO] Imprime ticket ESC/POS 80mm.", "enabled": False, "fn": cocina_imprimir_ticket},
    "cocina_estado_pedido": {"description": "[FUTURO] Consulta estado de pedido en cocina.", "enabled": False, "fn": cocina_estado_pedido},
    "analytics_registrar_evento": {"description": "[FUTURO] Registra evento en analytics.", "enabled": False, "fn": analytics_registrar_evento},
    "analytics_obtener_metricas": {"description": "[FUTURO] Consulta métricas agregadas.", "enabled": False, "fn": analytics_obtener_metricas},
    "cliente_buscar_o_crear": {"description": "[FUTURO] CRM: busca/crea cliente por teléfono.", "enabled": False, "fn": cliente_buscar_o_crear},
    "cliente_historial": {"description": "[FUTURO] Historial de pedidos de un cliente.", "enabled": False, "fn": cliente_historial},
    "config_obtener": {"description": "[FUTURO] Config remota (feature flags, precios dinámicos).", "enabled": False, "fn": config_obtener},
}


async def register_all_skills(registry):
    """Registra todas las skills en el registry"""
    from agents.base import SkillDefinition

    for name, defn in SKILL_DEFINITIONS.items():
        enabled = defn.get("enabled", True)
        # Usar staticmethod para evitar que se convierta en bound method
        registry.register(type("obj", (object,), {
            "name": name,
            "description": defn["description"],
            "function": staticmethod(defn["fn"]),
            "parameters_schema": defn.get("parameters", {"type": "object", "properties": {}}),
            "returns_schema": defn.get("returns", {"type": "object"}),
            "terminates_turn": defn.get("terminates_turn", False),
            "enabled": enabled
        })())