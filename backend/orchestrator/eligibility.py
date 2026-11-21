"""EligibilityRules — Reglas de elegibilidad del orquestador.

Extraído de orchestrator/handoff.py. Contiene las condiciones evaluadas con eval()
que determinan si un agente puede activarse en un contexto dado.
"""

from typing import Dict, Any, List
import logging

logger = logging.getLogger(__name__)


class EligibilityRules:
    """Reglas de elegibilidad para activar un agente."""

    def __init__(self):
        self.rules: Dict[str, List[str]] = {
            "intake": [
                "start_of_conversation",
                "after_clarification_response",
            ],
            "validator": [
                "items_parsed and len(items_parsed) > 0",
            ],
            "confirmer": [
                "total_calculated is not None",
            ],
            "clarifier": [
                "last_handoff_reason and ("
                "'Falta tamaño' in last_handoff_reason "
                "or 'quedan' in last_handoff_reason "
                "and 'pediste' in last_handoff_reason "
                "or 'No tenemos' in last_handoff_reason "
                "or 'problemas' in last_handoff_reason.lower())"
            ],
        }

    def get_rules(self, agent_id: str) -> List[str]:
        """Obtiene las reglas de elegibilidad de un agente."""
        return self.rules.get(agent_id, [])

    def add_rule(self, agent_id: str, condition: str) -> None:
        """Agrega una regla de elegibilidad a un agente."""
        if agent_id not in self.rules:
            self.rules[agent_id] = []
        self.rules[agent_id].append(condition)

    def remove_rule(self, agent_id: str, condition: str) -> None:
        """Elimina una regla de elegibilidad de un agente."""
        if agent_id in self.rules and condition in self.rules[agent_id]:
            self.rules[agent_id].remove(condition)

    def eval_condition(self, condition: str, context: Dict[str, Any]) -> bool:
        """Evalúa una condición de string usando eval() con contexto seguro."""
        try:
            safe_context = {k: v for k, v in context.items() if not k.startswith("_")}
            safe_builtins = {
                "len": len,
                "str": str,
                "int": int,
                "bool": bool,
                "list": list,
                "dict": dict,
            }
            return eval(condition, {"__builtins__": safe_builtins}, safe_context)
        except Exception:
            return False

    def check_eligibility(self, agent_id: str, context: Dict[str, Any]) -> bool:
        """Verifica si un agente cumple todas sus reglas de elegibilidad."""
        rules = self.get_rules(agent_id)
        for rule in rules:
            if not self.eval_condition(rule, context):
                logger.warning(f"Regla falló para {agent_id}: {rule}")
                return False
        return True
