#!/usr/bin/env python3
"""Script CLI para generar un recibo PDF de un pedido.

Uso:
    python generate_recibo.py --pedido ORD-20241120-001 --total 5500 --cliente "Juan"
"""

import argparse
import json
import sys
from pathlib import Path

# Agregar backend al path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recibo_service import generar_recibo_pdf


def main() -> None:
    parser = argparse.ArgumentParser(description="Generar recibo PDF de un pedido")
    parser.add_argument("--pedido", required=True, help="Número de pedido")
    parser.add_argument("--total", required=True, type=float, help="Total del pedido")
    parser.add_argument("--cliente", default="Cliente", help="Nombre del cliente")
    parser.add_argument("--telefono", default="", help="Teléfono del cliente")
    parser.add_argument("--direccion", default="", help="Dirección de entrega")
    parser.add_argument("--notas", default="", help="Notas del pedido")
    parser.add_argument("--output", default=None, help="Archivo de salida (opcional)")
    args = parser.parse_args()

    datos_recibo = {
        "pedido": args.pedido,
        "fecha": __import__("datetime").datetime.now().strftime("%d/%m/%Y %H:%M"),
        "cliente": {
            "nombre": args.cliente,
            "telefono": args.telefono,
            "direccion": args.direccion,
            "notas": args.notas,
        },
        "lineas": [],
        "total": args.total,
        "moneda": "ARS",
        "tiempo_estimado_min": "—",
    }

    pdf_bytes = generar_recibo_pdf(datos_recibo)

    output_path = args.output or f"recibo_{args.pedido}.pdf"
    with open(output_path, "wb") as f:
        f.write(pdf_bytes)

    print(f"✅ Recibo generado: {output_path}")


if __name__ == "__main__":
    main()
