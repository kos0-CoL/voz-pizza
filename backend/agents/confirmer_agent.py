from typing import Dict, List, Any, Optional
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from skills.catalog import confirmar_pedido, analytics_registrar_evento
import random


SYSTEM_PROMPT = """Sos el AGENTE CONFIRMADOR de "Pizzería La Esquina".

Tu trabajo: confirmar pedidos YA VALIDADOS (requiere calcular_total previo exitoso).

REGLAS:
1. Solo ejecutá confirmar_pedido si el contexto tiene total_calculated válido.
2. Extraé datos del cliente del contexto (nombre, teléfono, dirección, notas).
3. Generá número de pedido y demora estimada.
4. Ejecutá notificaciones post-confirmación (push, cocina, analytics).
5. Publicá evento "confirmation_ready" en el bus con la confirmación.
6. Salida: confirmación completa para el cliente.

HANDOFFS:
- Tras confirmar → analytics (evento)
"""


class ConfirmerAgent(Agent):
    """Agente Confirmador. Confirma pedidos ya validados y registra el evento de confirmación."""

    def __init__(self, config: AgentConfig, skill_registry, bus):
        super().__init__(config, skill_registry, bus)

    async def on_activate(self, context, args: Dict = None):
        """Al activarse, verifica que haya total_calculated y confirma el pedido."""
        if not context.total_calculated:
            await self.handoff_to("validator", "Falta total calculado", HandoffType.DISCRETE)
            return

        await self._confirm_order()

    async def on_deactivate(self):
        pass

    async def process_turn(self, user_input: str) -> SkillResult:
        """El confirmer no procesa input directo del usuario."""
        return SkillResult(success=True, data={"message": "Confirmer no procesa input directo"}, terminates_turn=True)

    async def _confirm_order(self):
        """Ejecuta confirmar_pedido, publica confirmation_ready y registra analytics."""
        cliente = self.context.cliente_info
        cliente_data = {
            "nombre_cliente": cliente.get("nombre"),
            "telefono": cliente.get("telefono"),
            "direccion": cliente.get("direccion"),
            "notas": cliente.get("notas")
        }

        # Ejecutar skill de confirmación de pedido
        confirm_result = await self.execute_skill("confirmar_pedido", cliente_data, self.context)

        if not confirm_result.success:
            await self.handoff_to("clarifier", f"Error confirmando: {confirm_result.error}", HandoffType.ANNOUNCED)
            return

        # Publicar confirmación en el bus para que el handler WebSocket la reciba
        await self.bus.publish("confirmation_ready", {
            "session_id": self.context.session_id,
            "confirmacion": confirm_result.data
        })

        # Registrar evento analytics de pedido confirmado
        await self.execute_skill("analytics_registrar_evento", {
            "evento": "pedido_confirmado",
            "propiedades": {
                "pedido_id": confirm_result.data["pedido"],
                "total": confirm_result.data["total"],
                "items_count": len(self.context.total_calculated["lineas"])
            },
            "user_id": self.context.session_id
        }, self.context)

        return SkillResult(
            success=True,
            data=confirm_result.data,
            terminates_turn=True
        )