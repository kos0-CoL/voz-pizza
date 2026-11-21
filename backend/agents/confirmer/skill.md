# SKILL.md — Agente Confirmer (Confirmador)

## ¿Qué hace?
Confirma pedidos YA VALIDADOS, genera el número de pedido, registra analytics y publica el evento de confirmación listo.

## ¿Cuándo se activa?
- Cuando hay `total_calculated` en el contexto (después de Validator).
- Requiere que `total_calculated` no sea None.

## Paso a paso de resolución

1. **Recibir contexto validado**: Datos del cliente + items validados + total calculado.
2. **Confirmar pedido**: Ejecutar `confirmar_pedido` con datos del cliente y líneas del pedido.
3. **Generar número de pedido**: Identificador único para el recibo y seguimiento.
4. **Calcular tiempo estimado**: Basado en complejidad del pedido y cola.
5. **Registrar analytics**: Ejecutar `analytics_registrar_evento` con evento de confirmación.
6. **Publicar evento**: Emitir `confirmation_ready` en el bus con toda la confirmación.
7. **Trigger recibo**: El backend genera el PDF del recibo a partir de los datos de confirmación.

## Entrada esperada
```json
{
  "total_calculated": { "total": 5500, "moneda": "ARS", "lineas_detalle": [...] },
  "cliente_info": { "nombre": "Juan", "telefono": "...", "direccion": "...", "notas": "..." }
}
```

## Salida esperada
```json
{
  "pedido": "ORD-20241120-001",
  "total": 5500,
  "moneda": "ARS",
  "tiempo_estimado_min": 35,
  "cliente_info": { ... },
  "next_agent": null
}
```

## Handoffs permitidos
- Ninguno (es el último agente del pipeline).
