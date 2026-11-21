"""DynamicPlanner — Planificador dinámico del orquestador.

Decide el siguiente agente basado en reglas de routing del contexto de conversación.
Extraído de orchestrator/handoff.py para separar responsabilidades.
"""

from typing import Dict, Any, Optional
import logging
import time

from agents.base import TraceEvent

logger = logging.getLogger(__name__)


class DynamicPlanner:
    """Planificador dinámico que decide el siguiente agente basado en el contexto."""

    def __init__(self, handoff_service, llm_client=None):
        self.handoff_service = handoff_service
        self.llm_client = llm_client
        self.bus = handoff_service.bus

    async def decide_next_agent(self, context: Dict[str, Any]) -> str:
        """Decide el siguiente agente basado en reglas de routing del contexto.

        Reglas de prioridad:
        1. Si hay aclaración pendiente → clarifier
        2. Si no hay items parseados → intake
        3. Si hay items pero no total calculado → validator
        4. Si hay total y no hay confirmación → confirmer
        5. Fallback → routing por LLM (o intake por defecto)
        """
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

        # Emitir trace de decisión del orquestador
        await self._emit_decision_trace(session_id, decision, reason, context)

        return decision

    async def _llm_routing(self, context: Dict[str, Any]) -> str:
        """Routing por LLM (fallback cuando ninguna regla aplica)."""
        logger.info("_llm_routing: usando fallback por LLM, decisión por defecto: intake")
        return "intake"

    async def _emit_decision_trace(
        self,
        session_id: str,
        decision: str,
        reason: str,
        context: Dict[str, Any],
    ) -> None:
        """Emitir evento de traza de decisión del orquestador."""
        event_id = f"evt_{int(time.time() * 1000000)}"
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
                    "handoff_history_len": len(context.get("handoff_history", [])),
                },
            },
            event_id=event_id,
            decision_reason=reason,
            decision_context={"to_agent": decision},
            from_agent="orchestrator",
            to_agent=decision,
            handoff_type="planner_decision",
            handoff_reason=reason,
        ).model_dump())
