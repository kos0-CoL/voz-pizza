from typing import Dict, List, Any, Optional
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from skills.catalog import buscar_en_catalogo, verificar_stock, calcular_total, pedir_aclaracion
import logging

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """Sos el AGENTE VALIDADOR de "Pizzería La Esquina".

Tu trabajo: recibir items estructurados, verificar stock y calcular total exacto.

REGLAS:
1. Para cada item: verificá stock con verificar_stock(cantidad).
2. Si no hay stock → pedir_aclaracion("De X quedan Y, ¿ajustamos?").
3. Calculá total con calcular_total (OBLIGATORIO). Valida tamaños, extras permitidos, stock.
4. Si calcular_total da problemas → pedir_aclaracion con el detalle.
5. NO confirmés el pedido. Solo validá y calculá.
6. Salida: {total: {...}, lineas_validadas: [...]} listo para Confirmador.

HANDOFFS:
- Si total calculado OK → handoff a "confirmer"
- Si stock bajo / problemas en total → handoff a "clarifier"
"""


class ValidatorAgent(Agent):
    """Agente Validador. Verifica stock y calcula el total del pedido."""

    def __init__(self, config: AgentConfig, skill_registry: SkillRegistry, bus):
        super().__init__(config, skill_registry, bus)

    async def on_activate(self, context: ConversationContext, args: Dict = None):
        """Al activarse, recibe items_parsed y ejecuta la validación de items."""
        if args and args.get("items_parsed"):
            self.context.items_parsed = args["items_parsed"]

        await self._validate_items()

    async def on_deactivate(self):
        pass

    async def process_turn(self, user_input: str) -> SkillResult:
        """El validator no procesa input directo del usuario."""
        return SkillResult(success=True, data={"message": "Validator no procesa input directo"}, terminates_turn=True)

    async def _validate_items(self):
        """Itera los items parseados, verifica stock de cada uno y calcula el total."""
        lineas_para_calcular = []

        for linea in self.context.items_parsed:
            item_id = linea["item_id"]
            cantidad = linea["cantidad"]
            variante_id = linea.get("variante_id")
            extras = linea.get("extras", [])

            # Verificar stock de este item
            stock_result = await self.execute_skill("verificar_stock", {
                "item_id": item_id,
                "cantidad": cantidad
            }, self.context)

            if not stock_result.success or not stock_result.data.get("disponible"):
                stock_data = stock_result.data or {}
                await self.handoff_to(
                    "clarifier",
                    f"De {stock_data.get('nombre', item_id)} quedan {stock_data.get('stock', 0)} y pediste {cantidad}. ¿Ajustamos?",
                    HandoffType.ANNOUNCED
                )
                return

            lineas_para_calcular.append({
                "item_id": item_id,
                "variante_id": variante_id,
                "cantidad": cantidad,
                "extras": extras
            })

        # Calcular total de todas las líneas validadas
        total_result = await self.execute_skill("calcular_total", {
            "lineas": lineas_para_calcular
        }, self.context)

        if not total_result.success:
            problemas = total_result.data.get("problemas", [total_result.error]) if total_result.data else [total_result.error]
            await self.handoff_to(
                "clarifier",
                f"{' '.join(problemas)} ¿Cómo lo resolvemos?",
                HandoffType.ANNOUNCED
            )
            return

        self.context.total_calculated = total_result.data

        await self.handoff_to(
            "confirmer",
            f"Total calculado: {total_result.data['total']} {total_result.data['moneda']}. {len(total_result.data['lineas'])} líneas validadas.",
            HandoffType.DISCRETE
        )