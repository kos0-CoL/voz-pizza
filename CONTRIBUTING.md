# Contribuyendo 🚀

Gracias por tu interés en contribuir a **TicketScan** (Pizzería La Esquina).
Este repositorio es un proyecto colaborativo: recepción de **Issues**, **PRs** y **discusiones** abiertas.

---

## 📐 Motor de desarrollo: OpenSpec

El roadmap y las specs detalladas viven en [proximos_desarrollos.md](../proximos_desarrollos.md).
Para nuevas funcionalidades se recomienda crear cambios con **OpenSpec** (`openspec` CLI) para mantener el flujo consistente.

- **Docs**: [openspec](https://openspec.nousresearch.com)
- **Skills**: `openspec` (onboard, explore, new-change, verify, propose, sync-specs, etc.)

---

## 📥 Cómo contribuir

### 1. Fork y clone

```bash
git clone https://github.com/tu-usuario/voz-pizza.git
cd voz-pizza
git remote add upstream https://github.com/kos0-CoL/voz-pizza.git
```

### 2. Crea una rama

Para cada PR, una rama nueva:

```bash
git checkout -b feature/nueva-funcionalidad
# o
git checkout -b fix/correccion-de-trazas
```

### 3. Haz tu cambio

- Sigue el estilo del código existente
- No agregues credenciales reales; usa `.env.example` y `REDACTED`
- Si pruebas con debbuging logs, quítalos antes de subir

### 4. Prueba local

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend
# Abrir index.html en un navegador (o con un servidor estático)
```

### 5. Envía tu PR

- Rebase antes de subir: `git fetch upstream && git rebase upstream/main`
- Expón claramente qué hace el PR y por qué
- Revisa la checklist

---

## ✅ Checklist de PR

- [ ] El código compila/sin errores
- [ ] Se respeta el estilo actual (JS/CSS/HTML)
- [ ] No se añaden credenciales, claves o secrets
- [ ] Se documenta el API/SSP cambio si aplica
- [ ] Se testea en local
- [ ] Se sigue **(optional)** OpenSpec para movements nuevos

---

## 📋 Checklists

### Issue Checklist

- [ ] `bug` → reporte reproducibles, stack trace (si aplica), versión
- [ ] `enhancement` → descripción del feature, caso de uso, prioridad
- [ ] `question` → pregunta clara y contexto

### Release Checklist

- [ ] Branch `release/vX.Y`
- [ ] PR a `main` con el release note
- [ ] Verificación de CI
- [ ] Tag `vX.Y.Z`

---

## 🤝 Comunidad

- **Issues**: [Issue tracker](https://github.com/kos0-CoL/voz-pizza/issues)
- **Discussions**: [Discussiones](https://github.com/kos0-CoL/voz-pizza/discussions)
- **Prs**: [Pull Requests](https://github.com/kos0-CoL/voz-pizza/pulls)

---

## 📄 Licencia

Ver `LICENSE` en el repositorio. (Si no existe, agregar en PR)

---

*Última actualización: 2026-11-18*
