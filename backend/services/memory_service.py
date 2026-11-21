"""MemoryService — Persistencia de contexto de sesión entre turnos.

Guarda y recupera ConversationContext por session_id para permitir
reanudar conversaciones después de aclaraciones o reconexiones.
"""

import json
import os
from typing import Optional, List, Dict, Any
from datetime import datetime
from agents.base import ConversationContext


class MemoryService:
    """Servicio de memoria persistente para contextos de sesión."""

    def __init__(self, storage_path: str = "data/sessions"):
        self.storage_path = storage_path
        os.makedirs(storage_path, exist_ok=True)

    def _session_file(self, session_id: str) -> str:
        """Ruta del archivo JSON de una sesión."""
        return os.path.join(self.storage_path, f"{session_id}.json")

    def save_context(self, session_id: str, context: ConversationContext) -> None:
        """Guarda el contexto de una sesión en disco."""
        filepath = self._session_file(session_id)
        data = {
            "session_id": context.session_id,
            "transcript": context.transcript,
            "items_parsed": context.items_parsed,
            "total_calculated": context.total_calculated,
            "cliente_info": context.cliente_info,
            "metadata": context.metadata,
            "handoff_history": context.handoff_history,
            "aclaracion_pendiente": context.aclaracion_pendiente,
            "updated_at": datetime.now().isoformat(),
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def load_context(self, session_id: str) -> Optional[ConversationContext]:
        """Carga el contexto de una sesión desde disco."""
        filepath = self._session_file(session_id)
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            return ConversationContext(**data)
        except Exception:
            return None

    def list_sessions(self) -> List[str]:
        """Lista todos los IDs de sesión disponibles."""
        if not os.path.exists(self.storage_path):
            return []
        files = [f.replace(".json", "") for f in os.listdir(self.storage_path) if f.endswith(".json")]
        return sorted(files)

    def delete_session(self, session_id: str) -> bool:
        """Elimina una sesión de disco."""
        filepath = self._session_file(session_id)
        if os.path.exists(filepath):
            os.remove(filepath)
            return True
        return False

    def get_context_summary(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Obtiene un resumen ligero del contexto sin cargar todo."""
        filepath = self._session_file(session_id)
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "session_id": data.get("session_id"),
                "items_count": len(data.get("items_parsed", [])),
                "total": data.get("total_calculated"),
                "updated_at": data.get("updated_at"),
            }
        except Exception:
            return None
