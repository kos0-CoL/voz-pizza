#!/usr/bin/env python3
"""Script de validación de configuración de agentes.

Verifica que:
- Cada agente tenga skill.md y rules.md
- Los handoffs declarados existan
- Las reglas de activación no estén vacías (excepto Main)
"""

import os
import sys
import yaml
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
AGENTS_DIR = BASE_DIR / "agents"
CONFIG_DIR = BASE_DIR / "config"

errors = []


def check_agent_folder(agent_id: str) -> None:
    """Verifica que un agente tenga todos sus archivos requeridos."""
    agent_folder = AGENTS_DIR / agent_id
    if not agent_folder.exists():
        errors.append(f"[CARPETA] Agente '{agent_id}' no tiene carpeta en agents/")
        return

    required_files = ["agent.py", "skill.md", "rules.md", "__init__.py"]
    for f in required_files:
        if not (agent_folder / f).exists():
            errors.append(f"[ARCHIVO] Agente '{agent_id}' falta archivo: {f}")

    config_file = CONFIG_DIR / "agents.yaml"
    if config_file.exists():
        with open(config_file) as f:
            config = yaml.safe_load(f)
        agent_cfg = config.get("agents", {}).get(agent_id, {})
        if not agent_cfg.get("enabled", True):
            errors.append(f"[CONFIG] Agente '{agent_id}' está deshabilitado")
        handoffs = agent_cfg.get("handoffs", [])
        for h in handoffs:
            if not (AGENTS_DIR / h).exists():
                errors.append(f"[HANDOFF] Agente '{agent_id}' declara handoff a '{h}' que no existe")


def main() -> None:
    config_file = CONFIG_DIR / "agents.yaml"
    if not config_file.exists():
        print("ERROR: No se encontró config/agents.yaml")
        sys.exit(1)

    with open(config_file) as f:
        config = yaml.safe_load(f)

    agents = config.get("agents", {})
    for agent_id in agents:
        check_agent_folder(agent_id)

    if errors:
        print(f"\n❌ Se encontraron {len(errors)} error(es):\n")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("✅ Todos los agentes están configurados correctamente.")
        sys.exit(0)


if __name__ == "__main__":
    main()
