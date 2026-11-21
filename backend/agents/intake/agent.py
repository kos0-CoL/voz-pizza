"""Agente Intake (Receptor) — Subagente del pipeline de pedidos.

Este archivo es un wrapper que re-exporta la implementación original
de IntakeAgent para mantener compatibilidad con main.py.
"""

from agents.intake_agent import IntakeAgent

__all__ = ["IntakeAgent"]
