# Development Guide

Este repositorio es un proyecto colaborativo (monorepo). El flujo de trabajo
está basado en **OpenSpec** para movements y especificaciones.

## 📁 Estructura

```
.
├── .github/
│   ├── ISSUE_TEMPLATE/      # Templates de Issues
│   ├── workflows/           # CI/CD (GitHub Actions)
│   └── CODEOWNERS
├── backend/                 # FastAPI + agents + skills
├── data/                    # Catálogo + pedidos de prueba
├── docker/                  # Docker Compose
├── app.js                   # Frontend (Agencia + Traza)
├── index.html
├── styles.css
├── proximos_desarrollos.md  # Spec / roadmap
└── README.md
```

## 🛠 Flujo de trabajo

### 1. Openspec (recomendado)

```bash
# Instalar openspec
pip install openspec

# Crear un nuevo movement
openspec new-change --title "Add feature" --type feature

# Confirmar
openspec verify change

# Sincronizar specs
openspec sync-specs
```

### 2. Git

```bash
# Crear rama
git checkout -b feature/nombre-del-feature

# Trabajar
git add .
git commit -m "feat: descripción del cambio"
git push origin feature/nombre-del-feature

# Crear PR
gh pr create --title "feat: ..." --body "..."
```

## 📜 Convenciones

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org)
  - `feat:` nueva funcionalidad
  - `fix:` corrección
  - `docs:` documentación
  - `refactor:` refactorización
  - `test:` tests
- **Ramas**: `feature/`, `fix/`, `docs/`, `refactor/`, `release/`
- **Nombres de issue**: `ENHANCEMENT-001`, `BUG-002`, `QUESTION-003`
- **Etiquetas de issue**: `enhancement`, `bug`, `documentation`, `question`
