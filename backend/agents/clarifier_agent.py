from typing import Dict, List, Any, Optional
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from skills.catalog import pedir_aclaracion, buscar_en_catalogo
import logging

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """Sos el AGENTE ACLARADOR de "Pizzería La Esquina".

Tu trabajo: cuando falta info crítica, preguntar al cliente de forma natural y resolver.

REGLAS:
1. Recibís el contexto del problema (qué falta, qué opciones hay).
2. Formulá pregunta clara, corta, en español rioplatense.
3. Ofrecé alternativas del catálogo si el item no existe.
4. Ejecutá pedir_aclaracion y TERMINÁ el turno.
5. El orquestador re-ejecutará con la respuesta del usuario → intake.

TIPOS DE ACLARACIÓN:
- missing_size: "La pizza X: ¿la querés chica, mediana o grande?"
- missing_quantity: "¿Cuántas X querés?"
- stock_low: "De X quedan Y y pediste Z. ¿Ajustamos?"
- unknown_item: "No tenemos X. ¿Quizás Y?"
- total_problems: "Problema en total: [detalle]. ¿Cómo lo resolvemos?"

HANDOFFS:
- Tras respuesta del usuario → handoff a "intake" con items_parsed actualizados
"""


class ClarifierAgent(Agent):
    
    def __init__(self, config, skill_registry, bus):
        super().__init__(config, skill_registry, bus)
    
    async def on_activate(self, context, args: Dict = None):
        logger.info(f"Clarifier({context.session_id}): on_activate called with args={args}")
        
        # Usar last_handoff_reason del contexto en lugar de args
        reason = context.last_handoff_reason or args.get("reason", "Aclaración requerida")
        self.context.aclaracion_pendiente = reason
        await self._ask_clarification()
    
    async def on_deactivate(self):
        pass
    
    async def process_turn(self, user_input: str) -> SkillResult:
        self.context.transcript.append({"role": "user", "content": user_input})
        self.context.aclaracion_pendiente = None
        
        await self.handoff_to(
            "intake",
            f"Respuesta a aclaración: {user_input}",
            HandoffType.DISCRETE
        )
        
        return SkillResult(
            success=True,
            data={"response": user_input, "next_agent": "intake"},
            terminates_turn=True
        )
    
    async def _ask_clarification(self):
        reason = self.context.aclaracion_pendiente or ""
        
        if "Falta tamaño" in reason:
            pregunta = reason.replace("Falta tamaño para: ", "") + ": ¿la querés chica, mediana o grande?"
        elif "Falta cantidad" in reason:
            pregunta = reason.replace("Falta cantidad para: ", "") + ": ¿cuántas querés?"
        elif "quedan" in reason and "pediste" in reason:
            pregunta = reason + " ¿Ajustamos?"
        elif "No tenemos" in reason:
            pregunta = reason + " ¿Querés que te pase las opciones?"
        elif "Problema en total" in reason or "problemas" in reason.lower():
            pregunta = reason + " ¿Cómo lo resolvemos?"
        else:
            pregunta = f"Necesito que me aclares: {reason}"
        
        await self.execute_skill("pedir_aclaracion", {"pregunta": pregunta}, self.context)
        
        # Publicar evento para que el handler WebSocket lo reciba
        await self.bus.publish("clarification_requested", {
            "session_id": self.context.session_id,
            "question": pregunta
        })