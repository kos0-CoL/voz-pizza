from typing import Dict, Optional
from agents.base import AgentConfig, AgentType


def load_agents_config() -> Dict[str, 'AgentConfig']:
    """Carga configuración de agentes desde YAML o define aquí"""
    
    return {
        "main": AgentConfig(
            id="main",
            name="🎤 Principal",
            type=AgentType.PIPELINE_WORKER,
            description="Maneja transporte (STT/TTS) y coordina handoffs",
            skills=[],
            handoffs=["intake"],
            enabled=True
        ),
        "intake": AgentConfig(
            id="intake",
            name="🎙️ Receptor",
            type=AgentType.LLM_CONTEXT_WORKER,
            description="Parsea pedido crudo → items estructurados",
            model="gemini-3.5-flash-lite",
            provider="gemini",
            skills=["buscar_en_catalogo", "pedir_aclaracion"],
            handoffs=["validator", "clarifier"],
            enabled=True,
            activation_rules=["start_of_conversation", "after_clarification_response"]
        ),
        "validator": AgentConfig(
            id="validator",
            name="✅ Validador",
            type=AgentType.LLM_CONTEXT_WORKER,
            description="Verifica stock, calcula total",
            model="gemini-3.5-flash-lite",
            provider="gemini",
            skills=["buscar_en_catalogo", "verificar_stock", "calcular_total", "pedir_aclaracion"],
            handoffs=["confirmer", "clarifier"],
            enabled=True,
            activation_rules=["items_parsed"]
        ),
        "confirmer": AgentConfig(
            id="confirmer",
            name="🎫 Confirmador",
            type=AgentType.LLM_CONTEXT_WORKER,
            description="Confirma pedido, genera número, notifica",
            model="gemini-3.5-flash-lite",
            provider="gemini",
            skills=["confirmar_pedido", "analytics_registrar_evento"],
            handoffs=[],
            enabled=True,
            activation_rules=["total_calculated"]
        ),
        "clarifier": AgentConfig(
            id="clarifier",
            name="❓ Aclarador",
            type=AgentType.LLM_CONTEXT_WORKER,
            description="Resuelve ambigüedades, pregunta al cliente",
            model="gemini-3.5-flash-lite",
            provider="gemini",
            skills=["pedir_aclaracion", "buscar_en_catalogo"],
            handoffs=["intake", "validator"],
            enabled=True,
            activation_rules=["missing_size", "stock_insufficient", "unknown_item", "total_problems"]
        )
    }


def get_agent_config(agent_id: str):
    config = load_agents_config()
    return config.get(agent_id)