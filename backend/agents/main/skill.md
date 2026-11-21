# SKILL.md — Agente Main (Principal)

## ¿Qué hace?
Maneja el transporte (STT/TTS) y actúa como puente entre el WebSocket del frontend y el orquestador del backend. Es el agente coordinador de entrada/salida.

## ¿Cuándo se activa?
- Siempre que hay un mensaje entrante del cliente vía WebSocket.
- No procesa input directo del pipeline de pedidos (eso es Intake).

## Paso a paso de resolución

1. **Recibir mensaje WebSocket**: Tipo `stt` (audio → texto) o `text` (texto directo).
2. **Publicar en el bus**: Emitir el mensaje al bus para que el orquestador lo procese.
3. **Enviar TTS**: Cuando el backend solicita hablar al cliente, enviar audio de texto.
4. **Manejar pings**: Responder a mensajes `ping` para mantener conexión viva.
5. **Manejar respuestas de aclaración**: Cuando el cliente responde una pregunta del Clarifier, publicar en el bus para reanudar el flujo.

## Entrada esperada
```json
{
  "type": "stt" | "text" | "clarification_response" | "ping",
  "data": { ... }
}
```

## Salida esperada
```json
{
  "type": "tts" | "confirmation" | "clarification" | "error",
  "text": "..."
}
```

## Handoffs permitidos
- **intake** (discrete): Cuando hay texto listo para parsear.
