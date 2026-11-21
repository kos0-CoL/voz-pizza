# rules.md — Agente Main (Principal)

## Límites y prohibiciones
1. **NO procesar items del pedido** — Eso es del pipeline (Intake → Validator → Confirmer).
2. **NO validar stock ni calcular totales** — Eso es del Validator.
3. **NO generar recibos** — Eso es del servicio de recibos.
4. **Solo transporte y coordinación** — STT/TTS y puente WebSocket.

## Tono de comunicación
- No habla directamente con el cliente salvo TTS programado por el backend.
- Mantener la conexión WebSocket estable.

## Estándares de calidad
- Responder a pings dentro de 5 segundos.
- Reenviar todos los mensajes de entrada al bus de eventos sin modificar.
- No perder mensajes de clarificación_response del cliente.

## Máximo de turnos
1 turno (es un puente, no un agente de procesamiento).

## Reglas de activación
- Siempre activo cuando hay conexión WebSocket.
