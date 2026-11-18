from typing import Dict, Any, Optional, List
from agents.base import Agent, AgentConfig, SkillRegistry, ConversationContext, SkillResult, HandoffType
from transport.webrtc_transport import WebSocketTransport


class MainAgent(Agent):
    """Agente principal que maneja el transporte (STT/TTS) y el BusBridge"""
    
    def __init__(self, config: AgentConfig, skill_registry, bus, menu_service):
        super().__init__(config, skill_registry, bus)
        self.transport: Optional[WebSocketTransport] = None
        self.menu_service = menu_service
    
    async def on_activate(self, context, args: Dict = None):
        self.context = context
        self.active = True
    
    async def on_deactivate(self):
        self.active = False
    
    async def process_turn(self, user_input: str) -> SkillResult:
        return SkillResult(success=True, data={"message": "Main agent no procesa input directo"}, terminates_turn=True)
    
    def set_transport(self, transport: WebSocketTransport):
        self.transport = transport
    
    async def speak(self, text: str):
        """Envía texto al TTS via transport"""
        if self.transport:
            await self.transport.send_tts(text)
    
    async def on_stt_result(self, transcript: str, is_final: bool):
        """Callback cuando STT devuelve resultado"""
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