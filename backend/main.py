import os
import asyncio
import json
import logging
import time
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Dict, Optional, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Importar módulos del backend
from agents.base import SkillRegistry, MessageBus, ConversationContext, TraceEvent
from agents.intake_agent import IntakeAgent
from agents.validator_agent import ValidatorAgent
from agents.confirmer_agent import ConfirmerAgent
from agents.clarifier_agent import ClarifierAgent
from agents.main_agent import MainAgent
from config.agents import load_agents_config
from orchestrator.handoff import HandoffService, DynamicPlanner, HandoffRequest, HandoffType
from services.menu_service import MenuService
from services.recibo_service import generar_recibo_pdf
from transport.webrtc_transport import WebSocketTransport, create_transport
from skills.catalog import register_all_skills

# Estado global del servidor (única instancia compartida por todos los agentes)
class AppState:
    def __init__(self):
        self.bus: Optional[MessageBus] = None              # Bus de mensajes interno (pub/sub)
        self.skill_registry: Optional[SkillRegistry] = None  # Registro de skills disponibles
        self.menu_service: Optional[MenuService] = None    # Servicio del menú (carga data/menu.json)
        self.recibo_service: Optional[Any] = None          # Servicio de generación de recibos PDF
        self.transport: Optional[WebSocketTransport] = None # Transporte WebSocket (comunicación frontend)
        self.handoff_service: Optional[HandoffService] = None # Servicio de cambio entre agentes (handoffs)
        self.planner: Optional[DynamicPlanner] = None      # Planificador que decide qué agente va después
        self.agents: Dict[str, Any] = {}                   # Diccionario de instancias de agentes por ID
        self.running = False                               # Flag de estado del servidor

app_state = AppState()


# Handler para eventos de traza - reenviar a WebSocket (frontend panel Agencia)
async def handle_trace_event(data: Dict):
    """Recibe eventos de traza del bus y los reenvía a todos los WebSocket conectados."""
    # Asegurar que transport y websocket estan inicializados
    if not app_state.transport or not app_state.transport._websocket:
        # Si no hay conexión activa, no hacer nada
        logger.warning(f"handle_trace_event: no hay WebSocket activo, evento {data.get('event_type')} descartado")
        return
    try:
        await app_state.transport._websocket.send_json({
            "type": "trace",
            "data": data
        })
        logger.info(f"handle_trace_event: enviado al frontend - type={data.get('event_type')}, session={data.get('session_id')}, agent={data.get('agent_id')}")
    except Exception as e:
        logger.warning(f"Error sending trace event: {e}")


# Handler para procesar handoffs solicitados por los agentes
async def handle_handoff_request(data: Dict):
    """Consume handoff_requested del bus y ejecuta el handoff real via HandoffService."""
    logger.info(f"handle_handoff_request: {data.get('from')} -> {data.get('to')}")
    if not app_state.handoff_service:
        logger.error("handle_handoff_request: handoff_service is None")
        return

    try:
        request = HandoffRequest(
            from_agent=data["from"],
            to_agent=data["to"],
            reason=data["reason"],
            handoff_type=HandoffType(data["type"]),
            context=data["context"],
            args=data.get("args", {})
        )
        logger.info(f"Calling handoff_service.request_handoff")
        await app_state.handoff_service.request_handoff(request)
        logger.info(f"Handoff request completed")
    except Exception as e:
        logger.error(f"Error in handle_handoff_request: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan de la aplicación FastAPI. Ejecuta inicio (startup) y apagado (shutdown)."""

    # =====================================================================
    # STARTUP - Inicialización de todos los servicios y agentes
    # =====================================================================
    logger.info("🍕 Iniciando Pizzería La Esquina - Orquestador Multi-Agente")

    # 1. Inicializar servicios centrales
    app_state.bus = MessageBus()                              # Crear bus de mensajes interno
    app_state.skill_registry = SkillRegistry()                # Crear registro de skills
    app_state.menu_service = MenuService()                    # Crear servicio del menú
    app_state.menu_service.load()                             # Cargar data/menu.json en memoria
    app_state.recibo_service = generar_recibo_pdf             # Función de generación de recibos PDF

    # 2. Registrar todas las skills en el registro
    await register_all_skills(app_state.skill_registry)

    # 3. Cargar configuración de agentes desde config/agents.py
    agents_config = load_agents_config()

    # 4. Crear instancias de los 5 agentes
    app_state.agents = {}

    # Main Agent - maneja transporte STT/TTS
    main_agent = MainAgent(
        agents_config["main"],
        app_state.skill_registry,
        app_state.bus,
        app_state.menu_service
    )
    app_state.agents["main"] = main_agent

    # LLM Agents del pipeline
    app_state.agents["intake"] = IntakeAgent(                 # Agente Receptor - parsea texto del cliente
        agents_config["intake"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["validator"] = ValidatorAgent(           # Agente Validador - stock y total
        agents_config["validator"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["confirmer"] = ConfirmerAgent(           # Agente Confirmador - confirma pedido
        agents_config["confirmer"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["clarifier"] = ClarifierAgent(           # Agente Aclarador - pregunta al cliente
        agents_config["clarifier"],
        app_state.skill_registry,
        app_state.bus
    )

    # 5. Configurar HandoffService (servicio de cambio entre agentes)
    app_state.handoff_service = HandoffService(agents_config, app_state.bus)

    # 6. Suscribir a eventos de traza para enviar al frontend (panel Agencia)
    app_state.bus.subscribe("trace_event", handle_trace_event)

    # Registrar cada instancia de agente en el handoff service
    for agent_id, agent in app_state.agents.items():
        app_state.handoff_service.register_agent_instance(agent_id, agent)

    # Registrar hooks pre/post handoff (para logging)
    app_state.handoff_service.register_hook("pre_handoff", lambda req: logger.info(f"Handoff: {req.from_agent} → {req.to_agent}"))
    app_state.handoff_service.register_hook("post_handoff", lambda req, ctx: logger.info(f"Handoff completado: {req.to_agent} activo"))

    # 7. Configurar DynamicPlanner (decide qué agente sigue según el contexto)
    app_state.planner = DynamicPlanner(app_state.handoff_service)

    # 8. Configurar Transport (WebSocketTransport creado más abajo)
    app_state.agents["main"].set_transport(app_state.transport)

    # Iniciar el transport (escuchar conexiones WebSocket)
    await app_state.transport.start()

    # 9. Suscribir handler de handoffs al bus (cuando un agente pide handoff)
    app_state.bus.subscribe("handoff_requested", handle_handoff_request)

    app_state.running = True
    logger.info("✅ Sistema iniciado correctamente")
    logger.info(f"   Agentes: {list(app_state.agents.keys())}")
    logger.info(f"   Skills: {[s for s in app_state.skill_registry._skills.keys()]}")

    yield  # Punto de ejecución: el servidor está arriba

    # =====================================================================
    # SHUTDOWN - Apagado limpio del servidor
    # =====================================================================
    logger.info("🛑 Apagando sistema...")
    await app_state.transport.stop()
    app_state.running = False


# Crear app FastAPI principal (definida UNA SOLA VEZ con lifespan)
app = FastAPI(
    title="Pizzería La Esquina - Orquestador Multi-Agente",
    version="1.0.0",
    lifespan=lifespan
)

# Configurar CORS para permitir conexiones desde cualquier origen (frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Servir archivos estáticos (HTML, CSS, JS del frontend)
app.mount("/static", StaticFiles(directory="/app"), name="static")

# Middleware: forzar no-cache en todas las respuestas (evita caché del navegador)
@app.middleware("http")
async def no_cache_middleware(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# Handler de mensajes WebSocket entrantes del cliente
async def handle_websocket_message(websocket: WebSocket, msg: Dict, context: ConversationContext, session_id: str):
    """Procesa mensajes entrantes del cliente vía WebSocket."""
    logger.info(f"handle_websocket_message({session_id}): msg_type={msg.get('type')}, context_id={id(context)}, aclaracion_pendiente={context.aclaracion_pendiente}")
    msg_type = msg.get("type")

    if msg_type == "stt":
        # Mensaje de reconocimiento de voz (STT)
        transcript = msg.get("transcript", "")
        is_final = msg.get("is_final", False)

        if is_final and transcript.strip():
            await process_order(transcript, context, websocket, session_id)

    elif msg_type == "text":
        # Mensaje de texto directo del cliente
        text = msg.get("text", "")
        if text.strip():
            await process_order(text, context, websocket, session_id)

    elif msg_type == "clarification_response":
        # Cliente respondió a una pregunta de aclaración (ej: "grande")
        logger.info(f"handle_websocket_message({session_id}): clarification_response received: {msg.get('response')}, aclaracion_pendiente={context.aclaracion_pendiente}, context_id={id(context)}")
        response = msg.get("response", "")
        if context.aclaracion_pendiente:
            context.transcript.append({"role": "user", "content": response})
            context.aclaracion_pendiente = None
            logger.info(f"handle_websocket_message({session_id}): calling process_order for clarification response, context_id={id(context)}")
            await process_order(response, context, websocket, session_id, is_clarification=True)
            logger.info(f"handle_websocket_message({session_id}): process_order returned")
        else:
            logger.warning(f"handle_websocket_message({session_id}): clarification_response received but no aclaracion_pendiente in context")

    elif msg_type == "ping":
        # Heartbeat - responder con pong
        await websocket.send_json({"type": "pong"})


# Crear transport UNA SOLA VEZ (antes del lifespan para que esté disponible)
transport = WebSocketTransport(
    host=os.getenv("HOST", "0.0.0.0"),
    port=int(os.getenv("PORT", "8080"))
)
transport.set_message_handler(handle_websocket_message)

# Asignar a app_state ANTES del lifespan para que esté disponible al iniciar
app_state.transport = transport

# Incluir rutas del transport (/, /api/menu, /api/health, /ws, /data/menu.json)
app.include_router(transport.get_fastapi_routes())


# Modelos Pydantic para API REST de prueba
class TextInput(BaseModel):
    text: str


# Endpoint para procesar texto directo (testing sin WebSocket)
@app.post("/api/process-text")
async def process_text(input: TextInput):
    context = ConversationContext()
    context.menu = app_state.menu_service.get_menu()

    intake = app_state.agents["intake"]
    await intake.activate(context)
    result = await intake.process_turn(input.text)

    return {
        "success": True,
        "context": context.model_dump(),
        "result": result.model_dump()
    }


# =====================================================================
# FUNCIÓN ORQUESTADORA PRINCIPAL - process_order()
# =====================================================================
# Esta es la función más importante. Orquesta TODO el flujo de un pedido:
#   Intake → Validator → Confirmer, con aclaraciones intermedias si falta info.
# =====================================================================
async def process_order(text: str, context: ConversationContext, websocket: WebSocket, session_id: str, is_clarification: bool = False):
    """Procesa un pedido a través del orquestador usando handoffs reales y espera el resultado final."""
    logger.info(f"process_order({session_id}): START text='{text}' is_clarification={is_clarification} aclaracion_pendiente_before={context.aclaracion_pendiente}")
    # Crear event para esperar la finalización del flujo (se setea cuando llega confirmation_ready o clarification_requested)
    completion_event = asyncio.Event()
    final_result = {"data": None, "type": None}

    # Handler para eventos del bus: confirmación lista (viene del ConfirmerAgent)
    async def handle_confirmation_ready(data: Dict):
        logger.info(f"process_order({session_id}): handle_confirmation_ready called with data={data}")
        if data.get("session_id") == session_id:
            final_result["data"] = data.get("confirmacion")
            final_result["type"] = "confirmation"
            completion_event.set()
            logger.info(f"process_order({session_id}): completion_event set for confirmation")

    # Handler para eventos del bus: aclaración solicitada (viene del ClarifierAgent)
    async def handle_clarification(data: Dict):
        logger.info(f"process_order({session_id}): handle_clarification called with data={data}")
        if data.get("session_id") == session_id:
            final_result["data"] = data.get("question")
            final_result["type"] = "clarification"
            completion_event.set()
            logger.info(f"process_order({session_id}): completion_event set for clarification, aclaracion_pendiente set to: {data.get('question')}")
            context.aclaracion_pendiente = data.get("question")

    # Suscribir a eventos del bus para recibir confirmación y aclaración
    app_state.bus.subscribe("confirmation_ready", handle_confirmation_ready)
    app_state.bus.subscribe("clarification_requested", handle_clarification)

    try:
        # Inicializar contexto si es nuevo (no tiene menú cargado)
        if not context.menu:
            context.menu = app_state.menu_service.get_menu()

        # =====================================================================
        # PASO 1: Primera pasada - no hay items_parsed -> iniciar con IntakeAgent
        # =====================================================================
        if not context.items_parsed and not is_clarification:
            # Emitir decisión del orquestador (trace para el frontend panel Agencia)
            decision_event_id = f"evt_{int(time.time()*1000000)}"
            await app_state.bus.publish("trace_event", TraceEvent(
                session_id=session_id,
                event_type="orchestrator_decision",
                agent_id="orchestrator",
                data={
                    "decision": "next agent: intake",
                    "to_agent": "intake",
                    "reason": "No hay items parseados, iniciar con intake",
                    "context_summary": {
                        "items_parsed": context.items_parsed,
                        "total_calculated": context.total_calculated,
                        "aclaracion_pendiente": context.aclaracion_pendiente,
                        "handoff_history_len": len(context.handoff_history or [])
                    },
                    "source_agent": "orchestrator"
                },
                event_id=decision_event_id,
                decision_reason="No hay items parseados, iniciar con intake",
                decision_context={"to_agent": "intake"},
                from_agent="orchestrator",
                to_agent="intake",
                handoff_type="planner_decision",
                handoff_reason="No hay items parseados, iniciar con intake"
            ).model_dump())

            # Activar IntakeAgent y parsear el texto del cliente
            logger.info(f"process_order({session_id}): Starting intake for text='{text}'")
            intake = app_state.agents["intake"]
            await intake.activate(context, parent_event_id=decision_event_id)
            result = await intake.process_turn(text)
            logger.info(f"process_order({session_id}): Intake result: {result}")

            # Si intake devuelve una aclaración (item desconocido), enviarla al usuario y esperar respuesta
            if result.success and getattr(result, 'data', None) and result.data.get("aclaracion") and result.data.get("termina_turno"):
                logger.info(f"process_order({session_id}): Intake returned clarification: {result.data['aclaracion']}")
                await websocket.send_json({
                    "type": "clarification",
                    "question": result.data["aclaracion"]
                })
                # Esperar respuesta del usuario - el flujo continuará cuando llegue clarification_response
                return

            # Esperar a que el flujo complete (evento del bus: confirmación o aclaración)
            try:
                logger.info(f"process_order({session_id}): Waiting for completion_event (30s timeout)")
                await asyncio.wait_for(completion_event.wait(), timeout=30.0)
                logger.info(f"process_order({session_id}): completion_event fired, final_result={final_result}")
            except asyncio.TimeoutError:
                logger.error(f"process_order({session_id}): Timeout waiting for completion_event")
                await websocket.send_json({
                    "type": "error",
                    "message": "Timeout procesando el pedido"
                })
                return

            # Enviar resultado según el tipo recibido
            if final_result["type"] == "confirmation":
                confirmacion = final_result["data"]
                logger.info(f"process_order({session_id}): Sending confirmation: {confirmacion}")
                await websocket.send_json({
                    "type": "confirmation",
                    "data": confirmacion
                })
                confirmation_text = f"Pedido {confirmacion['pedido']} confirmado. Total {confirmacion['total']} pesos. Demora {confirmacion['tiempo_estimado_min']} minutos."
                await websocket.send_json({
                    "type": "tts",
                    "text": confirmation_text
                })

                # Generar y enviar recibo PDF
                # total_calculated vive en el contexto del confirmer (último agente del pipeline),
                # no en el contexto original de process_order (los handoffs crean nuevos contextos).
                recibo_context = app_state.agents["confirmer"].context
                lineas_recibo = []
                if recibo_context and recibo_context.total_calculated:
                    for linea in recibo_context.total_calculated.get("lineas", []):
                        item = linea.get("item", {}) if isinstance(linea.get("item"), dict) else {}
                        lineas_recibo.append({
                            "item": item,
                            "cantidad": linea.get("cantidad", 1),
                            "precio_unitario": linea.get("precio_unitario", 0),
                            "subtotal": linea.get("subtotal", 0),
                            "variante_id": linea.get("variante_id", ""),
                            "extras": linea.get("extras", [])
                        })
                else:
                    logger.warning(f"process_order({session_id}): total_calculated no disponible en contexto del confirmer")

                datos_recibo = {
                    "pedido": confirmacion["pedido"],
                    "fecha": datetime.now().strftime("%d/%m/%Y %H:%M"),
                    "cliente": (recibo_context.cliente_info if recibo_context else {}) or {},
                    "lineas": lineas_recibo,
                    "total": confirmacion["total"],
                    "moneda": confirmacion.get("moneda", "ARS"),
                    "tiempo_estimado_min": confirmacion.get("tiempo_estimado_min", "—")
                }

                try:
                    pdf_bytes = app_state.recibo_service(datos_recibo)
                    import base64
                    pdf_b64 = base64.b64encode(pdf_bytes).decode("utf-8")
                    await websocket.send_json({
                        "type": "recibo",
                        "pedido": confirmacion["pedido"],
                        "pdf_base64": pdf_b64,
                        "filename": f"recibo_{confirmacion['pedido']}.pdf"
                    })
                    logger.info(f"process_order({session_id}): Recibo PDF generado para pedido {confirmacion['pedido']}")
                except Exception as e:
                    logger.error(f"process_order({session_id}): Error generando recibo PDF: {e}")
            elif final_result["type"] == "clarification":
                logger.info(f"process_order({session_id}): Sending clarification: {final_result['data']}")
                await websocket.send_json({
                    "type": "clarification",
                    "question": final_result["data"]
                })
            else:
                logger.error(f"process_order({session_id}): No result type, final_result={final_result}")
                await websocket.send_json({
                    "type": "error",
                    "message": "No se obtuvo resultado del flujo"
                })
            return

        # =====================================================================
        # PASO 2: Respuesta de aclaración (cliente respondió "grande", "chica", etc.)
        # =====================================================================
        if is_clarification:
            logger.info(f"process_order({session_id}): Processing clarification response '{text}', updating parsed items directly")

            # La respuesta de aclaración se aplica al último item que faltaba tamaño
            if context.items_parsed:
                for item in reversed(context.items_parsed):
                    item_data = item.get("item", {})
                    if item_data.get("variantes") and not item.get("variante_id"):
                        # Encontramos el item que faltaba tamaño, aplicar la respuesta
                        respuesta = text.lower().strip()
                        variante_encontrada = None
                        for var in item_data.get("variantes", []):
                            if (var["id"] in respuesta or
                                var["nombre"].lower() in respuesta or
                                respuesta in var["id"] or
                                respuesta in var["nombre"].lower()):
                                variante_encontrada = var
                                break

                        if variante_encontrada:
                            item["variante_id"] = variante_encontrada["id"]
                            logger.info(f"process_order({session_id}): Applied clarification '{text}' -> variante '{variante_encontrada['id']}' to item '{item['item_id']}'")
                        else:
                            logger.warning(f"process_order({session_id}): Could not match clarification '{text}' to any variant for item '{item['item_id']}'")
                        break

                logger.info(f"process_order({session_id}): Updated items_parsed after clarification: {context.items_parsed}")

                # Activar validator directamente con los items actualizados
                validator = app_state.agents["validator"]
                await validator.activate(context, {"items_parsed": context.items_parsed})
                # El validator se ejecuta en on_activate y hace handoff a confirmer
            else:
                # No hay items parseados (item desconocido original), re-ejecutar intake con la respuesta como nuevo input
                logger.info(f"process_order({session_id}): No parsed items (unknown item), re-running intake with clarification response as new input")
                intake = app_state.agents["intake"]
                await intake.activate(context)
                result = await intake.process_turn(text)
                logger.info(f"process_order({session_id}): Intake result after clarification: {result}")

                if result.success and getattr(result, 'data', None) and result.data.get("aclaracion") and result.data.get("termina_turno"):
                    logger.info(f"process_order({session_id}): Intake returned clarification: {result.data['aclaracion']}")
                    await websocket.send_json({
                        "type": "clarification",
                        "question": result.data["aclaracion"]
                    })
                    return

                if result.success and result.data and result.data.get("items_parsed"):
                    context.items_parsed = result.data["items_parsed"]
                    logger.info(f"process_order({session_id}): Updated items_parsed after re-intake: {context.items_parsed}")

                    validator = app_state.agents["validator"]
                    await validator.activate(context, {"items_parsed": context.items_parsed})
                else:
                    if result.data and result.data.get("next_agent") == "clarifier":
                        logger.info(f"process_order({session_id}): Intake handed off to clarifier, waiting for clarification via bus events")
                        try:
                            await asyncio.wait_for(completion_event.wait(), timeout=30.0)
                            logger.info(f"process_order({session_id}): completion_event fired for clarifier handoff, final_result={final_result}")
                        except asyncio.TimeoutError:
                            logger.error(f"process_order({session_id}): Timeout waiting for clarifier handoff")
                            await websocket.send_json({
                                "type": "error",
                                "message": "Timeout esperando aclaración"
                            })
                            return

                        if final_result["type"] == "clarification":
                            logger.info(f"process_order({session_id}): Sending clarification from clarifier: {final_result['data']}")
                            await websocket.send_json({
                                "type": "clarification",
                                "question": final_result["data"]
                            })
                        return
                    else:
                        logger.error(f"process_order({session_id}): Unexpected state - no items_parsed and not is_clarification")
                        await websocket.send_json({
                            "type": "error",
                            "message": "Error interno: estado inesperado"
                        })
                        return

                validator = app_state.agents["validator"]
                await validator.activate(context, {"items_parsed": context.items_parsed})

            # Esperar a que el flujo complete (evento del bus)
            try:
                logger.info(f"process_order({session_id}): Waiting for completion_event after clarification (30s timeout)")
                await asyncio.wait_for(completion_event.wait(), timeout=30.0)
                logger.info(f"process_order({session_id}): completion_event fired, final_result={final_result}")
            except asyncio.TimeoutError:
                logger.error(f"process_order({session_id}): Timeout waiting for completion_event after clarification")
                await websocket.send_json({
                    "type": "error",
                    "message": "Timeout procesando el pedido"
                })
                return

            if final_result["type"] == "confirmation":
                confirmacion = final_result["data"]
                logger.info(f"process_order({session_id}): Sending confirmation: {confirmacion}")
                await websocket.send_json({
                    "type": "confirmation",
                    "data": confirmacion
                })
                confirmation_text = f"Pedido {confirmacion['pedido']} confirmado. Total {confirmacion['total']} pesos. Demora {confirmacion['tiempo_estimado_min']} minutos."
                await websocket.send_json({
                    "type": "tts",
                    "text": confirmation_text
                })
            elif final_result["type"] == "clarification":
                logger.info(f"process_order({session_id}): Sending clarification: {final_result['data']}")
                await websocket.send_json({
                    "type": "clarification",
                    "question": final_result["data"]
                })
            else:
                logger.error(f"process_order({session_id}): No result type, final_result={final_result}")
                await websocket.send_json({
                    "type": "error",
                    "message": "No se obtuvo resultado del flujo"
                })
            return

    except Exception as e:
        logger.error(f"process_order({session_id}): Error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except:
            pass
    finally:
        logger.info(f"process_order({session_id}): END aclaracion_pendiente_after={context.aclaracion_pendiente}")
        # Desuscribir handlers del bus (limpieza)
        app_state.bus.unsubscribe("confirmation_ready", handle_confirmation_ready)
        app_state.bus.unsubscribe("clarification_requested", handle_clarification)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")