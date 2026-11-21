from typing import Dict, Any, Optional, List
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from transport.webrtc_transport import WebSocketTransport


class MainAgent(Agent):
    """Agente principal que maneja el transporte (STT/TTS) y el BusBridge."""

    def __init__(self, config: AgentConfig, skill_registry, bus, menu_service):
        super().__init__(config, skill_registry, bus)
        self.transport: Optional[WebSocketTransport] = None  # Transporte WebSocket (STT/TTS)
        self.menu_service = menu_service  # Servicio de menú para obtener el catálogo

    async def on_activate(self, context, args: Dict = None):
        """Al activarse, establece el contexto y marca al agente como activo."""
        self.context = context
        self.active = True

    async def on_deactivate(self):
        """Al desactivarse, marca al agente como inactivo."""
        self.active = False

    async def process_turn(self, user_input: str) -> SkillResult:
        """El MainAgent no procesa input directo del usuario."""
        return SkillResult(success=True, data={"message": "Main agent no procesa input directo"}, terminates_turn=True)

    def set_transport(self, transport: WebSocketTransport):
        """Asigna el transporte WebSocket para enviar TTS y recibir STT."""
        self.transport = transport

    async def speak(self, text: str):
        """Envía texto al TTS via transport."""
        if self.transport:
            await self.transport.send_tts(text)

    async def on_stt_result(self, transcript: str, is_final: bool):
        """Callback cuando STT devuelve resultado de reconocimiento de voz."""
        if is_final:
            # Crear contexto si no existe
            if not self.context:
                self.context = ConversationContext()
                self.context.menu = self.menu_service.get_menu()

            # Handoff a intake
            from orchestrator.handoff import HandoffService
            # El handoff se maneja via bus
            await self.bus.publish("stt_final", {
                "transcript": transcript,
                "session_id": self.context.session_id
            })