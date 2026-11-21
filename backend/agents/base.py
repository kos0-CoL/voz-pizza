from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Callable, Awaitable
from pydantic import BaseModel, Field
from enum import Enum
import json
import uuid
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class AgentType(str, Enum):
    """Tipos de agente disponibles en el sistema."""
    PIPELINE_WORKER = "PipelineWorker"   # Agente que procesa un turno en el pipeline
    LLM_WORKER = "LLMWorker"             # Agente impulsado por LLM
    LLM_CONTEXT_WORKER = "LLMContextWorker"  # Agente LLM con contexto de conversación


class HandoffType(str, Enum):
    """Tipos de handoff (transferencia entre agentes)."""
    ANNOUNCED = "announced"   # Se anuncia al cliente antes de transferir
    DISCRETE = "discrete"     # Transferencia silenciosa sin anuncio


@dataclass
class SkillDefinition:
    """Definición de una skill (herramienta) que un agente puede ejecutar."""
    name: str                     # Nombre único de la skill
    description: str              # Descripción legible para humanos
    function: Callable            # Función ejecutable (async) de la skill
    parameters_schema: dict       # Esquema JSON Schema de los parámetros de entrada
    returns_schema: dict          # Esquema JSON Schema del valor de retorno
    terminates_turn: bool = False  # Si True, el turno termina después de ejecutar esta skill
    enabled: bool = True          # Si False, la skill está deshabilitada
    metadata: dict = field(default_factory=dict)  # Metadatos adicionales


@dataclass
class AgentConfig:
    """Configuración de un agente individual."""
    id: str                       # Identificador único del agente
    name: str                     # Nombre legible del agente
    type: AgentType               # Tipo de agente (ver AgentType)
    description: str              # Descripción del rol del agente
    model: str = "gemini-3.5-flash-lite"  # Modelo LLM usado por este agente
    provider: str = "gemini"      # Proveedor del LLM (gemini, groq, etc.)
    skills: List[str] = field(default_factory=list)  # Lista de nombres de skills disponibles
    handoffs: List[str] = field(default_factory=list)  # Agentes a los que puede hacer handoff
    enabled: bool = True          # Si el agente está habilitado
    activation_rules: List[str] = field(default_factory=list)  # Reglas de activación
    max_turns: int = 6            # Número máximo de turnos que puede estar activo
    temperature: float = 0.2      # Temperatura del LLM (creatividad)
    system_prompt: str = ""       # Prompt del sistema para el LLM
    handoff_config: dict = field(default_factory=dict)  # Configuración específica de handoffs


class ConversationContext(BaseModel):
    """Estado de la conversación que se pasa entre agentes."""
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))  # ID de sesión
    transcript: List[Dict[str, Any]] = Field(default_factory=list)      # Historial de mensajes
    current_agent: Optional[str] = None                                 # Agente activo actual
    items_parsed: List[Dict[str, Any]] = Field(default_factory=list)    # Items del pedido parseados
    total_calculated: Optional[Dict[str, Any]] = None                   # Resultado del cálculo de total
    aclaracion_pendiente: Optional[str] = None                          # Pregunta de aclaración pendiente
    cliente_info: Dict[str, Any] = Field(default_factory=dict)          # Datos del cliente (nombre, tel, dir)
    metadata: Dict[str, Any] = Field(default_factory=dict)              # Metadatos arbitrarios
    menu: Optional[Dict[str, Any]] = None                               # Catálogo de menú cargado
    last_handoff_reason: Optional[str] = None                           # Motivo del último handoff
    handoff_history: List[Dict[str, Any]] = Field(default_factory=list) # Historial de transferencias
    source_agent: str = Field(default="orchestrator", description="Agente que inició este turno")


class SkillResult(BaseModel):
    """Resultado de la ejecución de una skill."""
    success: bool                 # Si la skill se ejecutó correctamente
    data: Optional[Dict] = None   # Datos devueltos por la skill
    error: Optional[str] = None   # Mensaje de error si falló
    terminates_turn: bool = False # Si el turno debe terminar


class TraceEvent(BaseModel):
    """Evento de traza para visualización en el frontend (panel Agencia)."""
    timestamp: float = Field(default_factory=time.time)
    session_id: str               # ID de sesión a la que pertenece
    event_type: str               # Tipo de evento: agent_activate, skill_call, handoff, etc.
    agent_id: str                 # ID del agente que generó el evento
    data: Dict[str, Any]          # Datos del evento
    parent_event_id: Optional[str] = None  # ID del evento padre (jerarquía)
    event_id: str = Field(default_factory=lambda: f"evt_{int(time.time()*1000000)}")  # ID único del evento
    step_number: Optional[int] = None  # Número de paso en la secuencia
    decision_reason: Optional[str] = None  # Motivo de decisión del orquestador
    decision_context: Optional[Dict[str, Any]] = None  # Contexto de la decisión
    from_agent: Optional[str] = None       # Agente origen en un handoff
    to_agent: Optional[str] = None         # Agente destino en un handoff
    handoff_type: Optional[str] = None     # Tipo de handoff (announced/discrete)
    handoff_reason: Optional[str] = None   # Motivo del handoff


class Agent(ABC):
    """Clase base abstracta para todos los agentes del sistema."""

    def __init__(self, config: AgentConfig, skill_registry: "SkillRegistry", bus: "MessageBus"):
        self.config = config               # Configuración del agente
        self.skill_registry = skill_registry  # Registro de skills disponibles
        self.bus = bus                     # Bus de eventos para publicar traces
        self.context: Optional[ConversationContext] = None  # Contexto de conversación actual
        self.active = False                # Si el agente está activo
        self._trace_step_counter = 0       # Contador interno de pasos de traza
        self._current_parent_event_id: Optional[str] = None  # ID del evento padre actual

    @abstractmethod
    async def on_activate(self, context: ConversationContext, args: Dict = None):
        """Llamado cuando el agente se activa. Debe ser implementado por subclases."""
        pass

    @abstractmethod
    async def on_deactivate(self):
        """Llamado cuando el agente se desactiva. Debe ser implementado por subclases."""
        pass

    @abstractmethod
    async def process_turn(self, user_input: str) -> SkillResult:
        """Procesa un turno de usuario. Debe ser implementado por subclases."""
        pass

    def _next_step(self) -> int:
        """Incrementa y devuelve el contador de pasos de traza."""
        self._trace_step_counter += 1
        return self._trace_step_counter

    def _set_parent_event(self, event_id: Optional[str]):
        """Establece el ID del evento padre para jerarquía de traces."""
        self._current_parent_event_id = event_id

    async def activate(self, context: ConversationContext, args: Dict = None, parent_event_id: Optional[str] = None):
        """Método público que emite trace y llama a on_activate."""
        self.context = context
        self.active = True
        event_id = f"evt_{int(time.time()*1000000)}"
        self._emit_trace("agent_activate", {
            "agent_name": self.config.name,
            "args": args or {},
            "source_agent": self.context.source_agent if self.context else "orchestrator"
        }, event_id=event_id, step_number=self._next_step(), parent_event_id=parent_event_id)
        self._current_parent_event_id = event_id
        await self.on_activate(context, args)

    async def deactivate(self):
        """Método público que emite trace y llama a on_deactivate."""
        self._emit_trace("agent_deactivate", {
            "agent_name": self.config.name
        }, parent_event_id=self._current_parent_event_id, step_number=self._next_step())
        self.active = False
        await self.on_deactivate()
        self._current_parent_event_id = None

    def get_available_skills(self) -> List[SkillDefinition]:
        """Devuelve la lista de skills habilitadas para este agente."""
        skills = []
        for s in self.config.skills:
            skill = self.skill_registry.get(s)
            if skill and skill.enabled:
                skills.append(skill)
        return skills

    async def execute_skill(self, skill_name: str, args: Dict[str, Any], context: ConversationContext) -> SkillResult:
        """Ejecuta una skill por nombre, emitiendo traces de inicio y fin."""
        # Emit trace: skill call start
        event_id = f"evt_{int(time.time()*1000000)}"
        self._emit_trace("skill_call", {
            "skill_name": skill_name,
            "args": args,
            "source_agent": self.config.id
        }, event_id=event_id, parent_event_id=self._current_parent_event_id, step_number=self._next_step())

        skill = self.skill_registry.get(skill_name)
        if not skill or not skill.enabled:
            result = SkillResult(success=False, error=f"Skill {skill_name} no disponible")
            self._emit_trace("skill_result", {
                "skill_name": skill_name,
                "success": False,
                "error": result.error
            }, parent_event_id=event_id, step_number=self._next_step())
            return result
        if skill_name not in self.config.skills:
            result = SkillResult(success=False, error=f"Agente {self.config.id} no tiene skill {skill_name}")
            self._emit_trace("skill_result", {
                "skill_name": skill_name,
                "success": False,
                "error": result.error
            }, parent_event_id=event_id, step_number=self._next_step())
            return result

        try:
            result_data = await skill.function(args, context)
            result = SkillResult(success=True, data=result_data, terminates_turn=skill.terminates_turn)
            self._emit_trace("skill_result", {
                "skill_name": skill_name,
                "success": True,
                "data": result_data,
                "terminates_turn": skill.terminates_turn,
                "source_agent": self.config.id
            }, parent_event_id=event_id, step_number=self._next_step())
            return result
        except Exception as e:
            result = SkillResult(success=False, error=str(e))
            self._emit_trace("skill_result", {
                "skill_name": skill_name,
                "success": False,
                "error": str(e)
            }, parent_event_id=event_id, step_number=self._next_step())
            return result

    def _emit_trace(self, event_type: str, data: Dict[str, Any], event_id: Optional[str] = None, parent_event_id: Optional[str] = None, step_number: Optional[int] = None, decision_reason: Optional[str] = None, decision_context: Optional[Dict] = None, from_agent: Optional[str] = None, to_agent: Optional[str] = None, handoff_type: Optional[str] = None, handoff_reason: Optional[str] = None):
        """Emite un evento de traza al bus para visualización en el frontend."""
        if self.context:
            if event_id is None:
                event_id = f"evt_{int(time.time()*1000000)}"
            if step_number is None:
                step_number = self._next_step()
            if parent_event_id is None:
                parent_event_id = self._current_parent_event_id

            trace_event = TraceEvent(
                session_id=self.context.session_id,
                event_type=event_type,
                agent_id=self.config.id,
                data=data,
                event_id=event_id,
                parent_event_id=parent_event_id,
                step_number=step_number,
                decision_reason=decision_reason,
                decision_context=decision_context,
                from_agent=from_agent,
                to_agent=to_agent,
                handoff_type=handoff_type,
                handoff_reason=handoff_reason
            )
            # Publicar al bus - el frontend se suscribe a trace_event
            asyncio.create_task(self.bus.publish("trace_event", trace_event.model_dump()))
            return event_id

    async def handoff_to(self, target_agent_id: str, reason: str, handoff_type: HandoffType = HandoffType.ANNOUNCED, args: Optional[Dict[str, Any]] = None):
        """Solicita transferencia a otro agente, emitiendo trace y evento de handoff."""
        event_id = self._emit_trace("handoff", {
            "from_agent": self.config.id,
            "to_agent": target_agent_id,
            "reason": reason,
            "type": handoff_type.value,
            "args": args or {}
        }, step_number=self._next_step(), handoff_type=handoff_type.value, handoff_reason=reason, from_agent=self.config.id, to_agent=target_agent_id)

        context_dict = self.context.model_dump() if self.context else {}
        await self.bus.publish("handoff_requested", {
            "from": self.config.id,
            "to": target_agent_id,
            "reason": reason,
            "type": handoff_type.value,
            "context": context_dict,
            "args": args or {}
        })


class SkillRegistry:
    """Registro central de skills disponibles en el sistema."""

    def __init__(self):
        self._skills: Dict[str, SkillDefinition] = {}

    def register(self, skill: SkillDefinition):
        """Registra una skill en el registro."""
        self._skills[skill.name] = skill

    def get(self, name: str) -> Optional[SkillDefinition]:
        """Obtiene una skill por su nombre."""
        return self._skills.get(name)

    def get_all_enabled(self) -> List[SkillDefinition]:
        """Devuelve todas las skills habilitadas."""
        return [s for s in self._skills.values() if s.enabled]

    def get_tool_schemas(self, skill_names: List[str]) -> List[Dict]:
        """Devuelve los esquemas JSON Schema de las skills dadas (para LLM function calling)."""
        schemas = []
        for name in skill_names:
            skill = self._skills.get(name)
            if skill and skill.enabled:
                schemas.append({
                    "type": "function",
                    "function": {
                        "name": skill.name,
                        "description": skill.description,
                        "parameters": skill.parameters_schema
                    }
                })
        return schemas


class MessageBus:
    """Bus de eventos pub/sub para comunicación entre componentes."""

    def __init__(self):
        self._subscribers: Dict[str, List[Callable]] = {}
        self._queue: asyncio.Queue = asyncio.Queue()

    def subscribe(self, event: str, handler: Callable):
        """Suscribe un handler a un tipo de evento."""
        if event not in self._subscribers:
            self._subscribers[event] = []
        self._subscribers[event].append(handler)

    def unsubscribe(self, event: str, handler: Callable):
        """Desuscribe un handler de un tipo de evento."""
        if event in self._subscribers:
            try:
                self._subscribers[event].remove(handler)
            except ValueError:
                pass

    async def publish(self, event: str, data: Dict):
        """Publica un evento a todos los handlers suscritos."""
        for handler in self._subscribers.get(event, []):
            if asyncio.iscoroutinefunction(handler):
                await handler(data)
            else:
                handler(data)

    async def publish_to_queue(self, event: str, data: Dict):
        """Publica un evento a la cola interna."""
        await self._queue.put({"event": event, "data": data})

    async def consume(self):
        """Consume eventos de la cola interna y los distribuye a los handlers."""
        while True:
            item = await self._queue.get()
            for handler in self._subscribers.get(item["event"], []):
                if asyncio.iscoroutinefunction(handler):
                    await handler(item["data"])
                else:
                    handler(item["data"])