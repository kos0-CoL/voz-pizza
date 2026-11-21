# API.md — Documentación de Endpoints

## Endpoints REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Health check del servidor |
| GET | `/api/menu` | Obtiene el menú completo (JSON) |
| GET | `/data/menu.json` | Sirve el archivo estático del menú |
| POST | `/api/process-text` | Procesa texto de pedido (alternativa a WebSocket) |

## WebSocket

| Ruta | Descripción |
|------|-------------|
| `/ws` | Conexión WebSocket principal para STT/TTS y traces |

### Mensajes cliente → servidor
| Tipo | Descripción |
|------|-------------|
| `stt` | Audio convertido a texto (Speech-to-Text) |
| `text` | Texto directo del cliente |
| `clarification_response` | Respuesta del cliente a una pregunta de aclaración |
| `ping` | Mantener conexión viva |

### Mensajes servidor → cliente
| Tipo | Descripción |
|------|-------------|
| `tts` | Texto para reproducir como audio (Text-to-Speech) |
| `confirmation` | Pedido confirmado con datos completos |
| `clarification` | Pregunta de aclaración al cliente |
| `error` | Error en el procesamiento |
| `recibo` | PDF del recibo codificado en base64 |
| `trace_event` | Evento de traza para el panel "Agencia" |

## Ejemplo de flujo completo

1. Cliente envía: `{ type: "text", data: "dos muzza medianas" }`
2. Servidor responde: `{ type: "clarification", question: "¿La muzza la querés chica, mediana o grande?" }`
3. Cliente responde: `{ type: "clarification_response", data: "mediana" }`
4. Servidor procesa y responde: `{ type: "confirmation", pedido: "...", total: 5500, ... }`
5. Servidor envía: `{ type: "recibo", pdf_base64: "..." }`
