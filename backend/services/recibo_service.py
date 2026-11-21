from reportlab.lib.pagesizes import mm
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.lib import colors
from io import BytesIO
from datetime import datetime
from typing import Dict, Any, List


def generar_recibo_pdf(datos_pedido: Dict[str, Any]) -> bytes:
    """Genera un recibo en PDF para un pedido confirmado.

    Args:
        datos_pedido: Dict con claves:
            - pedido: número de pedido
            - fecha: fecha y hora del pedido
            - cliente: {nombre, telefono, direccion, notas}
            - lineas: lista de {item, cantidad, precio_unitario, subtotal, extras}
            - total: monto total
            - moneda: moneda (ej. "ARS")
            - tiempo_estimado_min: minutos de demora

    Returns:
        Bytes del PDF generado.
    """
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=(80 * mm, 200 * mm))
    width, height = 80 * mm, 200 * mm

    # Encabezado
    c.setFont("Helvetica-Bold", 14)
    c.setFillColor(colors.HexColor("#d32f2f"))
    c.drawCentredString(width / 2, height - 15 * mm, "Pizzería La Esquina")
    c.setFont("Helvetica", 8)
    c.setFillColor(colors.black)
    c.drawCentredString(width / 2, height - 20 * mm, "Recibo de Pedido")
    c.drawCentredString(width / 2, height - 25 * mm, datetime.now().strftime("%d/%m/%Y %H:%M"))

    # Línea separadora
    c.setStrokeColor(colors.HexColor("#d32f2f"))
    c.setLineWidth(1)
    c.line(5 * mm, height - 28 * mm, width - 5 * mm, height - 28 * mm)

    y = height - 35 * mm

    # Datos del pedido
    c.setFont("Helvetica-Bold", 9)
    c.drawString(5 * mm, y, f"Pedido N°: {datos_pedido.get('pedido', 'N/A')}")
    c.drawRightString(width - 5 * mm, y, f"Total: {datos_pedido.get('moneda', '')} {datos_pedido.get('total', 0)}")
    y -= 6 * mm

    cliente = datos_pedido.get("cliente", {})
    c.setFont("Helvetica", 8)
    c.drawString(5 * mm, y, f"Cliente: {cliente.get('nombre', '—')}")
    y -= 5 * mm
    c.drawString(5 * mm, y, f"Teléfono: {cliente.get('telefono', '—')}")
    y -= 5 * mm
    c.drawString(5 * mm, y, f"Dirección: {cliente.get('direccion', '—')}")
    y -= 8 * mm

    # Tabla de items
    c.setFont("Helvetica-Bold", 9)
    c.drawString(5 * mm, y, "Items")
    y -= 5 * mm

    c.setFont("Helvetica", 8)
    for linea in datos_pedido.get("lineas", []):
        nombre = linea.get("item", {}).get("nombre", "Item")
        cantidad = linea.get("cantidad", 1)
        precio = linea.get("precio_unitario", 0)
        subtotal = linea.get("subtotal", precio * cantidad)
        variante = linea.get("variante_id", "")
        extras = ", ".join(linea.get("extras", []))

        texto = f"{cantidad}x {nombre}"
        if variante:
            texto += f" ({variante})"
        c.drawString(8 * mm, y, texto)
        y -= 4 * mm

        c.setFont("Helvetica-Oblique", 7)
        c.drawString(10 * mm, y, f"  ${precio} x {cantidad} = ${subtotal}")
        c.setFont("Helvetica", 8)
        y -= 4 * mm

        if extras:
            c.setFont("Helvetica-Oblique", 7)
            c.drawString(10 * mm, y, f"  Extras: {extras}")
            c.setFont("Helvetica", 8)
            y -= 5 * mm

        y -= 2 * mm

    # Línea separadora antes del total
    c.setStrokeColor(colors.grey)
    c.setLineWidth(0.5)
    c.line(5 * mm, y, width - 5 * mm, y)
    y -= 6 * mm

    # Total
    c.setFont("Helvetica-Bold", 11)
    c.drawString(5 * mm, y, "TOTAL:")
    c.drawRightString(width - 5 * mm, y, f"{datos_pedido.get('moneda', '')} {datos_pedido.get('total', 0)}")
    y -= 8 * mm

    # Tiempo estimado
    tiempo = datos_pedido.get("tiempo_estimado_min", "—")
    c.setFont("Helvetica", 8)
    c.drawString(5 * mm, y, f"Tiempo estimado: {tiempo} minutos")
    y -= 10 * mm

    # Notas
    notas = cliente.get("notas", "")
    if notas:
        c.setFont("Helvetica-Bold", 8)
        c.drawString(5 * mm, y, "Notas:")
        y -= 5 * mm
        c.setFont("Helvetica", 8)
        c.drawString(8 * mm, y, notas)
        y -= 10 * mm

    # Pie de página
    c.setStrokeColor(colors.HexColor("#d32f2f"))
    c.setLineWidth(0.5)
    c.line(5 * mm, y, width - 5 * mm, y)
    y -= 8 * mm
    c.setFont("Helvetica-Oblique", 7)
    c.setFillColor(colors.grey)
    c.drawCentredString(width / 2, y, "¡Gracias por tu pedido!")
    c.drawCentredString(width / 2, y - 4 * mm, "Pizzería La Esquina")

    c.showPage()
    c.save()

    buffer.seek(0)
    return buffer.read()