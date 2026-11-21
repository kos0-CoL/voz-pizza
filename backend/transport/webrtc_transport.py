from typing import Optional, Dict, Any, Callable, Awaitable
from abc import ABC, abstractmethod
import asyncio
import json
import logging
import os
from agents.base import ConversationContext

logger = logging.getLogger(__name__)


class BaseTransport(ABC):
    def __init__(self):
        self._event_handlers: Dict[str, list] = {}
        self._running = False

    def on(self, event: str, handler: Callable):
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    def emit(self, event: str, data: Dict[str, Any]):
        for handler in self._event_handlers.get(event, []):
            if asyncio.iscoroutinefunction(handler):
                asyncio.create_task(handler(data))
            else:
                handler(data)

    @abstractmethod
    async def start(self):
        pass

    @abstractmethod
    async def stop(self):
        pass

    @abstractmethod
    async def send_tts(self, text: str):
        pass

    @property
    def running(self) -> bool:
        return self._running


class WebSocketTransport(BaseTransport):
    """Transport WebSocket - solo maneja el endpoint WS, no el servidor"""

    def __init__(self, host: str = "0.0.0.0", port: int = 8080, message_handler: Optional[Callable] = None):
        super().__init__()
        self.host = host
        self.port = port
        self._websocket = None
        self._running = False
        self._message_handler = message_handler
        self._menu_service = None
        self._session_contexts: Dict[str, ConversationContext] = {}

    def set_message_handler(self, handler: Callable):
        self._message_handler = handler

    def set_menu_service(self, menu_service):
        self._menu_service = menu_service

    def _get_or_create_context(self, session_id: str) -> ConversationContext:
        """Obtiene o crea el contexto para una sesión"""
        if session_id not in self._session_contexts:
            self._session_contexts[session_id] = ConversationContext()
            self._session_contexts[session_id].session_id = session_id
            if self._menu_service:
                try:
                    self._session_contexts[session_id].menu = self._menu_service.get_menu()
                except Exception:
                    pass
        return self._session_contexts[session_id]

    def _clear_context(self, session_id: str):
        """Limpia el contexto de una sesión"""
        if session_id in self._session_contexts:
            del self._session_contexts[session_id]

    def get_fastapi_routes(self):
        """Retorna las rutas para agregar a la app FastAPI principal"""
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect
        from fastapi.staticfiles import StaticFiles
        from fastapi.responses import FileResponse

        # Crear un router con las rutas
        from fastapi import APIRouter
        router = APIRouter()

        @router.get("/")
        async def root():
            docker_path = "/app/index.html"
            dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "index.html")
            index_path = docker_path if os.path.exists(docker_path) else dev_path
            return FileResponse(
                index_path,
                headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"},
            )

        @router.get("/api/menu")
        async def get_menu():
            import json
            docker_path = "/app/data/menu.json"
            dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "menu.json")
            menu_path = docker_path if os.path.exists(docker_path) else dev_path
            with open(menu_path, "r") as f:
                return json.load(f)

        @router.get("/data/menu.json")
        async def get_menu_json():
            import json
            docker_path = "/app/data/menu.json"
            dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "menu.json")
            menu_path = docker_path if os.path.exists(docker_path) else dev_path
            with open(menu_path, "r") as f:
                return json.load(f)

        @router.get("/data/pedidos-prueba.json")
        async def get_pedidos_prueba():
            import json
            docker_path = "/app/data/pedidos-prueba.json"
            dev_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "pedidos-prueba.json")
            pedidos_path = docker_path if os.path.exists(docker_path) else dev_path
            with open(pedidos_path, "r") as f:
                return json.load(f)

        @router.get("/api/health")
        async def health():
            return {"status": "ok"}

        @router.websocket("/ws")
        async def websocket_endpoint(websocket: WebSocket):
            await websocket.accept()
            # Usar una session_id simple basada en el cliente
            session_id = f"{websocket.client.host}:{websocket.client.port}" if websocket.client else "default"
            self._websocket = websocket
            self.emit("client_connected", {"session_id": session_id})
            logger.info("WebSocket connection accepted")

            try:
                while True:
                    try:
                        data = await websocket.receive_text()
                        logger.debug(f"Received: {data}")
                        msg = json.loads(data)

                        # Extraer session_id del mensaje si viene
                        msg_session_id = msg.get("session_id", session_id)
                        
                        # Llamar al handler de mensajes si existe
                        if self._message_handler:
                            try:
                                context = self._get_or_create_context(msg_session_id)
                                logger.info(f"Calling message handler with msg: {msg}")
                                await self._message_handler(websocket, msg, context, msg_session_id)
                                logger.info("Message handler completed")
                            except Exception as e:
                                logger.error(f"Error in message handler: {e}", exc_info=True)
                                try:
                                    await websocket.send_json({"type": "error", "message": str(e)})
                                except:
                                    pass

                    except json.JSONDecodeError as e:
                        logger.error(f"JSON decode error: {e}")
                    except Exception as e:
                        logger.error(f"Error handling message: {e}", exc_info=True)
                        break
            except WebSocketDisconnect:
                logger.info("WebSocket disconnected")
                self.emit("client_disconnected", {"session_id": session_id})
                self._clear_context(session_id)
                self._websocket = None
            except Exception as e:
                logger.error(f"WebSocket error: {e}", exc_info=True)
                self._clear_context(session_id)
                self._websocket = None

        return router

    def set_message_handler(self, handler: Callable):
        self._message_handler = handler

    def set_menu_service(self, menu_service):
        self._menu_service = menu_service

    async def start(self):
        """No inicia servidor propio"""
        self._running = True

    async def stop(self):
        if self._websocket:
            await self._websocket.close()
        self._running = False

    async def send_tts(self, text: str):
        if self._websocket:
            await self._websocket.send_json({
                "type": "tts",
                "text": text
            })

    async def _handle_message(self, msg: Dict):
        msg_type = msg.get("type")

        if msg_type == "stt":
            transcript = msg.get("transcript", "")
            is_final = msg.get("is_final", False)
            self.emit("stt_result", {
                "transcript": msg.get("transcript", ""),
                "is_final": msg.get("is_final", False)
            })
        elif msg_type == "text":
            self.emit("stt_result", {
                "transcript": msg.get("text", ""),
                "is_final": True
            })
        elif msg_type == "ping":
            if self._websocket:
                await self._websocket.send_json({"type": "pong"})


async def create_transport(transport_type: str = "websocket", **kwargs) -> BaseTransport:
    if transport_type == "websocket":
        return WebSocketTransport(**kwargs)
    raise ValueError(f"Transport type {transport_type} no soportado")