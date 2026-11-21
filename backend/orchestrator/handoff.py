from typing import Dict, Any, List, Optional, Callable, Awaitable
from dataclasses import dataclass
from agents.base import ConversationContext, AgentConfig, HandoffType, MessageBus, TraceEvent
from config.agents import load_agents_config
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


@dataclass
class HandoffRequest:
    """Solicitud de transferencia entre agentes."""
    from_agent: str        # Agente origen
    to_agent: str          # Agente destino
    reason: str            # Motivo del handoff
    handoff_type: HandoffType  # Tipo: announced o discrete
    context: Dict          # Contexto de conversación a transferir
    args: Dict             # Argumentos adicionales


@dataclass
class EligibilityRule:
    """Regla de elegibilidad para activar un agente."""
    agent_id: str          # ID del agente
    conditions: List[str]  # Lista de condiciones (strings evaluados con eval())
    required: bool = True  # Si es obligatoria


class HandoffService:
    """Servicio que gestiona transferencias (handoffs) entre agentes del pipeline."""

    def __init__(self, agents_config: Dict[str, AgentConfig], bus: MessageBus):
        self.agents_config = agents_config  # Configuración de todos los agentes
        self.bus = bus                      # Bus de eventos para traces
        self.eligibility_rules = self._load_eligibility_rules()  # Reglas de elegibilidad por agente
        self.hooks: Dict[str, List[Callable]] = {  # Hooks de ciclo de vida
            "pre_handoff": [],
            "post_handoff": [],
            "on_agent_activate": [],
            "on_agent_deactivate": []
        }
        self._agent_instances: Dict[str, Any] = {}  # Instancias de agentes registradas

    def _load_eligibility_rules(self) -> Dict[str, List]:
        """Carga las reglas de elegibilidad para cada agente (evaluadas con eval())."""
        return {
            "intake": ["start_of_conversation", "after_clarification_response"],
            "validator": ["items_parsed and len(items_parsed) > 0"],
            "confirmer": ["total_calculated is not None"],
            "clarifier": [
                "last_handoff_reason and ('Falta tamaño' in last_handoff_reason or 'quedan' in last_handoff_reason and 'pediste' in last_handoff_reason or 'No tenemos' in last_handoff_reason or 'problemas' in last_handoff_reason.lower())"
            ]
        }

    def register_agent_instance(self, agent_id: str, instance):
        """Registra la instancia de un agente para poder activarlo/desactivarlo."""
        self._agent_instances[agent_id] = instance

    def register_hook(self, hook_name: str, handler: Callable):
        """Registra un handler para un hook de ciclo de vida."""
        if hook_name in self.hooks:
            self.hooks[hook_name].append(handler)

    async def request_handoff(self, request: HandoffRequest) -> bool:
        """Ejecuta un handoff completo: trace, elegibilidad, hooks, transferencia de contexto."""
        # Emit orchestrator decision trace
        decision_event_id = f"evt_{int(time.time()*1000000)}"
        await self.bus.publish("trace_event", TraceEvent(
            session_id=request.context.get("session_id", "unknown"),
            event_type="orchestrator_decision",
            agent_id="orchestrator",
            data={
                "decision": f"handoff to {request.to_agent}",
                "from_agent": request.from_agent,
                "to_agent": request.to_agent,
                "reason": request.reason,
                "handoff_type": request.handoff_type.value,
                "args": request.args,
                "context_summary": {
                    "items_parsed": request.context.get("items_parsed"),
                    "total_calculated": request.context.get("total_calculated"),
                    "aclaracion_pendiente": request.context.get("aclaracion_pendiente"),
                    "handoff_history_len": len(request.context.get("handoff_history", []))
                }
            },
            event_id=decision_event_id,
            step_number=None,
            decision_reason=request.reason,
            decision_context={"to_agent": request.to_agent, "from_agent": request.from_agent},
            from_agent="orchestrator",
            to_agent=request.to_agent,
            handoff_type=request.handoff_type.value,
            handoff_reason=request.reason
        ).model_dump())

        # Verificar elegibilidad del agente destino
        if not await self._check_eligibility(request.to_agent, request.context):
            await self.bus.publish("handoff_rejected", {"request": request.__dict__, "reason": "Eligibility check failed"})
            return False

        # Ejecutar hooks pre-handoff
        for hook in self.hooks["pre_handoff"]:
            if asyncio.iscoroutinefunction(hook):
                await hook(request)
            else:
                hook(request)

        # Anunciar handoff por TTS si es anunciado
        if request.handoff_type == HandoffType.ANNOUNCED:
            await self._announce_handoff(request)

        # Transferir contexto, desactivar origen, activar destino
        target_context = await self._transfer_context(request)
        await self._deactivate_agent(request.from_agent)
        await self._activate_agent(request.to_agent, target_context, request.args, decision_event_id)

        # Ejecutar hooks post-handoff
        for hook in self.hooks["post_handoff"]:
            if asyncio.iscoroutinefunction(hook):
                await hook(request, target_context)
            else:
                hook(request, target_context)

        self._record_handoff(request)
        return True

    async def _check_eligibility(self, agent_id: str, context: Dict) -> bool:
        """Verifica si un agente cumple las reglas de elegibilidad para activarse."""
        logger.info(f"_check_eligibility: agent_id={agent_id}, context_keys={list(context.keys())}")
        if agent_id not in self.agents_config:
            logger.warning(f"_check_eligibility: agent {agent_id} not in config")
            return False
        if not self.agents_config[agent_id].enabled:
            logger.warning(f"_check_eligibility: agent {agent_id} not enabled")
            return False

        rules = self.eligibility_rules.get(agent_id, [])
        logger.info(f"_check_eligibility: rules for {agent_id}: {rules}")
        for rule in rules:
            logger.info(f"_check_eligibility: evaluating rule: {rule}")
            if not self._eval_condition(rule, context):
                logger.warning(f"_check_eligibility: rule failed for {agent_id}: {rule}")
                return False
        logger.info(f"_check_eligibility: PASSED for {agent_id}")
        return True

    def _eval_condition(self, condition: str, context: Dict) -> bool:
        """Evalúa una condición de string usando eval() con contexto seguro."""
        try:
            safe_context = {k: v for k, v in context.items() if not k.startswith('_')}
            safe_builtins = {"len": len, "str": str, "int": int, "bool": bool, "list": list, "dict": dict}
            return eval(condition, {"__builtins__": safe_builtins}, safe_context)
        except Exception:
            return False

    async def _announce_handoff(self, request: HandoffRequest):
        """Anuncia el handoff por TTS al cliente."""
        await self.bus.publish("tts_speak", {
            "text": f"Te paso con {request.to_agent}. {request.reason}",
            "priority": "high"
        })

    async def _transfer_context(self, request: HandoffRequest) -> Dict:
        """Transfiere el contexto del agente origen al destino (últimos 6 mensajes del transcript)."""
        source = request.context
        return {
            "session_id": source.get("session_id"),
            "transcript": source.get("transcript", [])[-6:],
            "items_parsed": source.get("items_parsed"),
            "total_calculated": source.get("total_calculated"),
            "cliente_info": source.get("cliente_info"),
            "metadata": source.get("metadata"),
            "last_handoff_reason": request.reason,
            "handoff_history": source.get("handoff_history", []) + [{
                "from": request.from_agent,
                "to": request.to_agent,
                "reason": request.reason,
                "type": request.handoff_type.value
            }]
        }

    async def _activate_agent(self, agent_id: str, context: Dict, args: Dict, parent_event_id: Optional[str] = None):
        """Activa la instancia de un agente con el contexto transferido."""
        instance = self._agent_instances.get(agent_id)
        if instance:
            ctx = ConversationContext(**context)
            await instance.activate(ctx, args, parent_event_id)

    async def _deactivate_agent(self, agent_id: str):
        """Desactiva la instancia de un agente."""
        instance = self._agent_instances.get(agent_id)
        if instance:
            await instance.deactivate()

    def _record_handoff(self, request: HandoffRequest):
        """Registra el handoff en el historial (placeholder para futura persistencia)."""
        pass


class DynamicPlanner:
    """Planificador dinámico que decide el siguiente agente basado en el contexto."""

    def __init__(self, handoff_service, llm_client=None):
        self.handoff_service = handoff_service
        self.llm_client = llm_client
        self.bus = handoff_service.bus

    async def decide_next_agent(self, context: Dict) -> str:
        """Decide el siguiente agente basado en reglas de routing del contexto."""
        session_id = context.get("session_id", "unknown")

        if context.get("aclaracion_pendiente"):
            decision = "clarifier"
            reason = "Hay aclaración pendiente del usuario"
        elif not context.get("items_parsed"):
            decision = "intake"
            reason = "No hay items parseados, iniciar con intake"
        elif context.get("items_parsed") and not context.get("total_calculated"):
            decision = "validator"
            reason = "Items parseados, validar stock y calcular total"
        elif context.get("total_calculated") and not context.get("metadata", {}).get("confirmacion"):
            decision = "confirmer"
            reason = "Total calculado, confirmar pedido"
        else:
            decision = await self._llm_routing(context)
            reason = "Decisión por LLM"

        # Emit orchestrator decision trace
        await self.bus.publish("trace_event", TraceEvent(
            session_id=session_id,
            event_type="orchestrator_decision",
            agent_id="orchestrator",
            data={
                "decision": f"next agent: {decision}",
                "to_agent": decision,
                "reason": reason,
                "context_summary": {
                    "items_parsed": context.get("items_parsed"),
                    "total_calculated": context.get("total_calculated"),
                    "aclaracion_pendiente": context.get("aclaracion_pendiente"),
                    "handoff_history_len": len(context.get("handoff_history", []))
                }
            },
            event_id=f"evt_{int(time.time()*1000000)}",
            decision_reason=reason,
            decision_context={"to_agent": decision},
            from_agent="orchestrator",
            to_agent=decision,
            handoff_type="planner_decision",
            handoff_reason=reason
        ).model_dump())

        return decision

    async def _llm_routing(self, context: Dict) -> str:
        """Routing por LLM (fallback cuando ninguna regla aplica)."""
        return "intake"