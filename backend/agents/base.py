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
    PIPELINE_WORKER = "PipelineWorker"
    LLM_WORKER = "LLMWorker"
    LLM_CONTEXT_WORKER = "LLMContextWorker"


class HandoffType(str, Enum):
    ANNOUNCED = "announced"
    DISCRETE = "discrete"


@dataclass
class SkillDefinition:
    name: str
    description: str
    function: Callable
    parameters_schema: dict
    returns_schema: dict
    terminates_turn: bool = False
    enabled: bool = True
    metadata: dict = field(default_factory=dict)


@dataclass
class AgentConfig:
    id: str
    name: str
    type: AgentType
    description: str
    model: str = "gemini-3.5-flash-lite"
    provider: str = "gemini"
    skills: List[str] = field(default_factory=list)
    handoffs: List[str] = field(default_factory=list)
    enabled: bool = True
    activation_rules: List[str] = field(default_factory=list)
    max_turns: int = 6
    temperature: float = 0.2
    system_prompt: str = ""
    handoff_config: dict = field(default_factory=dict)


class ConversationContext(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    transcript: List[Dict[str, Any]] = Field(default_factory=list)
    current_agent: Optional[str] = None
    items_parsed: List[Dict[str, Any]] = Field(default_factory=list)
    total_calculated: Optional[Dict[str, Any]] = None
    aclaracion_pendiente: Optional[str] = None
    cliente_info: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    menu: Optional[Dict[str, Any]] = None
    last_handoff_reason: Optional[str] = None
    handoff_history: List[Dict[str, Any]] = Field(default_factory=list)
    source_agent: str = Field(default="orchestrator", description="Agente que inició este turno")


class SkillResult(BaseModel):
    success: bool
    data: Optional[Dict] = None
    error: Optional[str] = None
    terminates_turn: bool = False


class TraceEvent(BaseModel):
    """Evento de traza para visualización en frontend"""
    timestamp: float = Field(default_factory=time.time)
    session_id: str
    event_type: str  # orchestrator_decision, agent_activate, skill_call, skill_result, handoff, agent_deactivate, orchestrator_decision_end
    agent_id: str
    data: Dict[str, Any]
    # Campos jerárquicos
    parent_event_id: Optional[str] = None  # ID del evento padre
    event_id: str = Field(default_factory=lambda: f"evt_{int(time.time()*1000000)}")
    step_number: Optional[int] = None  # Número de paso en la secuencia
    # Contexto de decisión del orquestador
    decision_reason: Optional[str] = None
    decision_context: Optional[Dict[str, Any]] = None
    # Para handoffs
    from_agent: Optional[str] = None
    to_agent: Optional[str] = None
    handoff_type: Optional[str] = None
    handoff_reason: Optional[str] = None


class Agent(ABC):
    def __init__(self, config: AgentConfig, skill_registry: "SkillRegistry", bus: "MessageBus"):
        self.config = config
        self.skill_registry = skill_registry
        self.bus = bus
        self.context: Optional[ConversationContext] = None
        self.active = False
        self._trace_step_counter = 0
        self._current_parent_event_id: Optional[str] = None
    
    @abstractmethod
    async def on_activate(self, context: ConversationContext, args: Dict = None):
        pass
    
    @abstractmethod
    async def on_deactivate(self):
        pass
    
    @abstractmethod
    async def process_turn(self, user_input: str) -> SkillResult:
        pass
    
    def _next_step(self) -> int:
        self._trace_step_counter += 1
        return self._trace_step_counter
    
    def _set_parent_event(self, event_id: Optional[str]):
        self._current_parent_event_id = event_id
    
    async def activate(self, context: ConversationContext, args: Dict = None, parent_event_id: Optional[str] = None):
        """Public method that emits trace and calls on_activate"""
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
        """Public method that emits trace and calls on_deactivate"""
        self._emit_trace("agent_deactivate", {
            "agent_name": self.config.name
        }, parent_event_id=self._current_parent_event_id, step_number=self._next_step())
        self.active = False
        await self.on_deactivate()
        self._current_parent_event_id = None
    
    def get_available_skills(self) -> List[SkillDefinition]:
        skills = []
        for s in self.config.skills:
            skill = self.skill_registry.get(s)
            if skill and skill.enabled:
                skills.append(skill)
        return skills
    
    async def execute_skill(self, skill_name: str, args: Dict[str, Any], context: ConversationContext) -> SkillResult:
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
        """Emit trace event to bus for frontend visualization"""
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
            # Publish to bus - frontend subscribes to trace events
            asyncio.create_task(self.bus.publish("trace_event", trace_event.model_dump()))
            return event_id
    
    async def handoff_to(self, target_agent_id: str, reason: str, handoff_type: HandoffType = HandoffType.ANNOUNCED, args: Optional[Dict[str, Any]] = None):
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
    def __init__(self):
        self._skills: Dict[str, SkillDefinition] = {}
    
    def register(self, skill: SkillDefinition):
        self._skills[skill.name] = skill
    
    def get(self, name: str) -> Optional[SkillDefinition]:
        return self._skills.get(name)
    
    def get_all_enabled(self) -> List[SkillDefinition]:
        return [s for s in self._skills.values() if s.enabled]
    
    def get_tool_schemas(self, skill_names: List[str]) -> List[Dict]:
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
    def __init__(self):
        self._subscribers: Dict[str, List[Callable]] = {}
        self._queue: asyncio.Queue = asyncio.Queue()
    
    def subscribe(self, event: str, handler: Callable):
        if event not in self._subscribers:
            self._subscribers[event] = []
        self._subscribers[event].append(handler)
    
    def unsubscribe(self, event: str, handler: Callable):
        if event in self._subscribers:
            try:
                self._subscribers[event].remove(handler)
            except ValueError:
                pass
    
    async def publish(self, event: str, data: Dict):
        for handler in self._subscribers.get(event, []):
            if asyncio.iscoroutinefunction(handler):
                await handler(data)
            else:
                handler(data)
    
    async def publish_to_queue(self, event: str, data: Dict):
        await self._queue.put({"event": event, "data": data})
    
    async def consume(self):
        while True:
            item = await self._queue.get()
            for handler in self._subscribers.get(item["event"], []):
                if asyncio.iscoroutinefunction(handler):
                    await handler(item["data"])
                else:
                    handler(item["data"])