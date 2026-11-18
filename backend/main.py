import os
import asyncio
import json
import logging
import time
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
from transport.webrtc_transport import WebSocketTransport, create_transport
from skills.catalog import register_all_skills

# Estado global
class AppState:
    def __init__(self):
        self.bus: Optional[MessageBus] = None
        self.skill_registry: Optional[SkillRegistry] = None
        self.menu_service: Optional[MenuService] = None
        self.transport: Optional[WebSocketTransport] = None
        self.handoff_service: Optional[HandoffService] = None
        self.planner: Optional[DynamicPlanner] = None
        self.agents: Dict[str, Any] = {}
        self.running = False

app_state = AppState()


# Handler para eventos de traza - reenviar a WebSocket
async def handle_trace_event(data: Dict):
    """Recibe eventos de traza del bus y los reenvía a todos los WebSocket conectados"""
    # Asegurar que transport y websocket estan inicializados
    if not app_state.transport or not app_state.transport._websocket:
        # Si no hay conexion, no hacer nada
        return
    try:
        await app_state.transport._websocket.send_json({
            "type": "trace",
            "data": data
        })
    except Exception as e:
        logger.warning(f"Error sending trace event: {e}")


# Handler para procesar handoffs solicitados por los agentes
async def handle_handoff_request(data: Dict):
    """Consume handoff_requested del bus y ejecuta el handoff real via HandoffService"""
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
    # Startup
    logger.info("🍕 Iniciando Pizzería La Esquina - Orquestador Multi-Agente")
    
    # 1. Inicializar servicios centrales
    app_state.bus = MessageBus()
    app_state.skill_registry = SkillRegistry()
    app_state.menu_service = MenuService()
    app_state.menu_service.load()
    
    # 2. Registrar skills
    await register_all_skills(app_state.skill_registry)
    
    # 3. Cargar configuración de agentes
    agents_config = load_agents_config()
    
    # 4. Crear instancias de agentes
    app_state.agents = {}
    
    # Main Agent
    main_agent = MainAgent(
        agents_config["main"],
        app_state.skill_registry,
        app_state.bus,
        app_state.menu_service
    )
    app_state.agents["main"] = main_agent
    
    # LLM Agents
    app_state.agents["intake"] = IntakeAgent(
        agents_config["intake"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["validator"] = ValidatorAgent(
        agents_config["validator"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["confirmer"] = ConfirmerAgent(
        agents_config["confirmer"],
        app_state.skill_registry,
        app_state.bus
    )
    app_state.agents["clarifier"] = ClarifierAgent(
        agents_config["clarifier"],
        app_state.skill_registry,
        app_state.bus
    )
    
    # 5. Configurar HandoffService
    app_state.handoff_service = HandoffService(agents_config, app_state.bus)
    
    # 6. Suscribir a eventos de traza para enviar al frontend
    app_state.bus.subscribe("trace_event", handle_trace_event)
    
    # Registrar instancias en handoff service
    for agent_id, agent in app_state.agents.items():
        app_state.handoff_service.register_agent_instance(agent_id, agent)
    
    # Registrar hooks
    app_state.handoff_service.register_hook("pre_handoff", lambda req: logger.info(f"Handoff: {req.from_agent} → {req.to_agent}"))
    app_state.handoff_service.register_hook("post_handoff", lambda req, ctx: logger.info(f"Handoff completado: {req.to_agent} activo"))
    
    # 7. Configurar DynamicPlanner
    app_state.planner = DynamicPlanner(app_state.handoff_service)
    
    # 8. Configurar Transport (usar el global creado abajo)
    app_state.agents["main"].set_transport(app_state.transport)
    
    # Iniciar transport
    await app_state.transport.start()
    
    # 9. Suscribir handler de handoffs al bus
    app_state.bus.subscribe("handoff_requested", handle_handoff_request)
    
    app_state.running = True
    logger.info("✅ Sistema iniciado correctamente")
    logger.info(f"   Agentes: {list(app_state.agents.keys())}")
    logger.info(f"   Skills: {[s for s in app_state.skill_registry._skills.keys()]}")
    
    yield
    
    # Shutdown
    logger.info("🛑 Apagando sistema...")
    await app_state.transport.stop()
    app_state.running = False


# Crear app FastAPI principal
app = FastAPI(
    title="Pizzería La Esquina - Orquestador Multi-Agente",
    version="1.0.0",
    lifespan=lifespan
)

# Configurar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Servir archivos estáticos
app.mount("/static", StaticFiles(directory="/app"), name="static")

# Handler de mensajes WebSocket
async def handle_websocket_message(websocket: WebSocket, msg: Dict, context: ConversationContext, session_id: str):
    logger.info(f"handle_websocket_message({session_id}): msg_type={msg.get('type')}, context_id={id(context)}, aclaracion_pendiente={context.aclaracion_pendiente}")
    msg_type = msg.get("type")
    
    if msg_type == "stt":
        transcript = msg.get("transcript", "")
        is_final = msg.get("is_final", False)
        
        if is_final and transcript.strip():
            await process_order(transcript, context, websocket, session_id)
    
    elif msg_type == "text":
        text = msg.get("text", "")
        if text.strip():
            await process_order(text, context, websocket, session_id)
    
    elif msg_type == "clarification_response":
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
        await websocket.send_json({"type": "pong"})


# Crear transport UNA SOLA VEZ
transport = WebSocketTransport(
    host=os.getenv("HOST", "0.0.0.0"),
    port=int(os.getenv("PORT", "8080"))
)
transport.set_message_handler(handle_websocket_message)

# Asignar a app_state ANTES del lifespan para que esté disponible
app_state.transport = transport

# Incluir rutas del transport
app.include_router(transport.get_fastapi_routes())


# Modelos Pydantic para API
class TextInput(BaseModel):
    text: str


# Endpoint para procesar texto directo (testing)
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


async def process_order(text: str, context: ConversationContext, websocket: WebSocket, session_id: str, is_clarification: bool = False):
    """Procesa un pedido a través del orquestador usando handoffs reales y espera el resultado final"""
    logger.info(f"process_order({session_id}): START text='{text}' is_clarification={is_clarification} aclaracion_pendiente_before={context.aclaracion_pendiente}")
    # Crear event para esperar la finalización del flujo
    completion_event = asyncio.Event()
    final_result = {"data": None, "type": None}
    
    # Handler para eventos del bus
    async def handle_confirmation_ready(data: Dict):
        logger.info(f"process_order({session_id}): handle_confirmation_ready called with data={data}")
        if data.get("session_id") == session_id:
            final_result["data"] = data.get("confirmacion")
            final_result["type"] = "confirmation"
            completion_event.set()
            logger.info(f"process_order({session_id}): completion_event set for confirmation")
    
    async def handle_clarification(data: Dict):
        logger.info(f"process_order({session_id}): handle_clarification called with data={data}")
        if data.get("session_id") == session_id:
            final_result["data"] = data.get("question")
            final_result["type"] = "clarification"
            completion_event.set()
            logger.info(f"process_order({session_id}): completion_event set for clarification, aclaracion_pendiente set to: {data.get('question')}")
            # Actualizar el contexto local para que la respuesta de aclaración funcione
            context.aclaracion_pendiente = data.get("question")
    
    # Suscribir a eventos del bus
    app_state.bus.subscribe("confirmation_ready", handle_confirmation_ready)
    app_state.bus.subscribe("clarification_requested", handle_clarification)
    
    try:
        # Inicializar contexto si es nuevo
        if not context.menu:
            context.menu = app_state.menu_service.get_menu()
        
        if not context.items_parsed and not is_clarification:
            # Primera pasada: intake - emitir decisión del orquestador
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
            
            # Esperar a que el flujo complete (evento del bus)
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
            
            # Enviar resultado según el tipo
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
        
        # Si es una respuesta de aclaración, actualizar directamente los items parseados y continuar al validator
        if is_clarification:
            logger.info(f"process_order({session_id}): Processing clarification response '{text}', updating parsed items directly")
            
            # La respuesta de aclaración (ej: "grande") se aplica al último item que faltaba tamaño
            if context.items_parsed:
                for item in reversed(context.items_parsed):
                    item_data = item.get("item", {})
                    if item_data.get("variantes") and not item.get("variante_id"):
                        # Encontramos el item que faltaba tamaño, aplicar la respuesta
                        # Buscar la variante que coincida con la respuesta (por ID o nombre)
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
                
                # Continuar al validator con los items actualizados
                logger.info(f"process_order({session_id}): Updated items_parsed after clarification: {context.items_parsed}")
                
                # Activar validator directamente
                validator = app_state.agents["validator"]
                await validator.activate(context, {"items_parsed": context.items_parsed})
                # El validator se ejecuta sincrónicamente en on_activate y hace handoff a confirmer
            else:
                # No hay items parseados (item desconocido original), re-ejecutar intake con la respuesta como nuevo input
                logger.info(f"process_order({session_id}): No parsed items (unknown item), re-running intake with clarification response as new input")
                intake = app_state.agents["intake"]
                await intake.activate(context)
                # Usar la respuesta de aclaración como nuevo input para intake
                result = await intake.process_turn(text)
                logger.info(f"process_order({session_id}): Intake result after clarification: {result}")
                
                # Si intake devuelve una aclaración (item desconocido), enviarla al usuario y esperar respuesta
                if result.success and getattr(result, 'data', None) and result.data.get("aclaracion") and result.data.get("termina_turno"):
                    logger.info(f"process_order({session_id}): Intake returned clarification: {result.data['aclaracion']}")
                    await websocket.send_json({
                        "type": "clarification",
                        "question": result.data["aclaracion"]
                    })
                    # Esperar respuesta del usuario - el flujo continuará cuando llegue clarification_response
                    return
                
                # Si intake devuelve items parseados, continuar al validator
                if result.success and result.data and result.data.get("items_parsed"):
                    context.items_parsed = result.data["items_parsed"]
                    logger.info(f"process_order({session_id}): Updated items_parsed after re-intake: {context.items_parsed}")
                    
                    # Activar validator directamente
                    validator = app_state.agents["validator"]
                    await validator.activate(context, {"items_parsed": context.items_parsed})
                else:
                    # Si intake hace handoff a clarifier (ej: item reconocido pero falta tamaño), 
                    # el flujo continuará via handoff service y eventos del bus
                    if result.data and result.data.get("next_agent") == "clarifier":
                        logger.info(f"process_order({session_id}): Intake handed off to clarifier, waiting for clarification via bus events")
                        # Esperar a que el clarifier publique clarification_requested
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
                        
                        # Enviar la aclaración al usuario
                        if final_result["type"] == "clarification":
                            logger.info(f"process_order({session_id}): Sending clarification from clarifier: {final_result['data']}")
                            await websocket.send_json({
                                "type": "clarification",
                                "question": final_result["data"]
                            })
                        return
                    else:
                        # No hay items parseados y no es respuesta de aclaración - caso no esperado
                        logger.error(f"process_order({session_id}): Unexpected state - no items_parsed and not is_clarification")
                        await websocket.send_json({
                            "type": "error",
                            "message": "Error interno: estado inesperado"
                        })
                        return
                
                # Continuar al validator con los items actualizados
                logger.info(f"process_order({session_id}): Updated items_parsed after clarification: {context.items_parsed}")
                
                # Activar validator directamente
                validator = app_state.agents["validator"]
                await validator.activate(context, {"items_parsed": context.items_parsed})
                # El validator se ejecuta sincrónicamente en on_activate y hace handoff a confirmer
            
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
            
            # Enviar resultado según el tipo
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
        # Desuscribir handlers
        app_state.bus.unsubscribe("confirmation_ready", handle_confirmation_ready)
        app_state.bus.unsubscribe("clarification_requested", handle_clarification)


# Crear app FastAPI principal
app = FastAPI(
    title="Pizzería La Esquina - Orquestador Multi-Agente",
    version="1.0.0",
    lifespan=lifespan
)

# Configurar CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Servir archivos estáticos
app.mount("/static", StaticFiles(directory="/app"), name="static")

# Servir menu.json en /data/menu.json para compatibilidad con frontend
from fastapi.responses import FileResponse
import os

@app.get("/data/menu.json")
async def get_menu_json():
    menu_path = "/app/data/menu.json"
    if os.path.exists(menu_path):
        return FileResponse(menu_path, media_type="application/json")
    # Fallback a la versión en static
    static_menu_path = "/app/static/data/menu.json"
    if os.path.exists(static_menu_path):
        return FileResponse(static_menu_path, media_type="application/json")
    return {"detail": "Menu not found"}


# Crear transport UNA SOLA VEZ
transport = WebSocketTransport(
    host=os.getenv("HOST", "0.0.0.0"),
    port=int(os.getenv("PORT", "8080"))
)
transport.set_message_handler(handle_websocket_message)

# Asignar a app_state ANTES del lifespan para que esté disponible
app_state.transport = transport

# Incluir rutas del transport
app.include_router(transport.get_fastapi_routes())


# Modelos Pydantic para API
class TextInput(BaseModel):
    text: str


# Endpoint para procesar texto directo (testing)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")