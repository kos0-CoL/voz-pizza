# SKILL.md — Agente Intake (Receptor)

## ¿Qué hace?
Convierte el texto libre del cliente en items estructurados del catálogo de la pizzería. Es el primer agente del pipeline que procesa el pedido.

## ¿Cuándo se activa?
- Al inicio de una conversación nueva (`start_of_conversation`)
- Después de que el cliente responde una aclaración del Clarifier (`after_clarification_response`)

## Paso a paso de resolución

1. **Recibir texto**: El cliente envía un mensaje por voz o texto (ej. "dos muzza medianas y una coca").
2. **Parsear items**: Usar `buscar_en_catalogo` para encontrar cada item mencionado, tolerando alias (muzza, napo, birra, fugazzeta).
3. **Detectar cantidad**: Identificar cuántos de cada item se piden.
4. **Detectar variante**: Si es pizza, identificar el tamaño (chica, mediana, grande). Si falta, marcar para aclaración.
5. **Detectar extras**: Identificar extras permitidos (extra queso, etc.).
6. **Detectar cliente**: Buscar nombre con patrón "a nombre de X" o "soy X".
7. **Validar entrada**: Si no se identificaron items, pedir aclaración al cliente.
8. **Handoff**:
   - Si todos los items tienen tamaño → hacer handoff a **Validator** (discrete).
   - Si falta tamaño en algún item → hacer handoff a **Clarifier** (announced) con el motivo específico.

## Entrada esperada
```json
{
  "texto": "dos muzza medianas y una coca",
  "menu": { ... },
  "cliente_info": { ... }
}
```

## Salida esperada
```json
{
  "items_parsed": [
    {
      "item_id": "muzza",
      "cantidad": 2,
      "variante_id": "mediana",
      "extras": []
    }
  ],
  "cliente_info": { "nombre": "Juan" },
  "next_agent": "validator"
}
```

## Handoffs permitidos
- **validator** (discrete): Cuando los items están completos con tamaño.
- **clarifier** (announced): Cuando falta tamaño o hay items desconocidos.
