<div align="center">

# 🧠⚡ Hybrid AI Training — Backend API

**Backend RESTful** diseñado para la aplicación móvil *Hybrid AI Training*.  
Actúa como el núcleo central de lógica de negocio: gestiona autenticación, persiste datos biométricos y orquesta prompts dinámicos con **Google Gemini 2.5 Flash** para generar planificaciones deportivas hiper-personalizadas de fuerza y resistencia.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-black?style=flat-square&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?style=flat-square&logo=mongodb&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?style=flat-square&logo=google&logoColor=white)
![JWT](https://img.shields.io/badge/Auth-JWT-000000?style=flat-square&logo=jsonwebtokens&logoColor=white)

</div>

---

## 🏗 Arquitectura y Patrones de Diseño

El sistema está construido siguiendo principios **SOLID** y **Clean Architecture**, asegurando escalabilidad, bajo acoplamiento y alta resiliencia.

| Patrón | Descripción |
|---|---|
| 🤖 **Integración AI Determinista** | Uso del modo `responseMimeType: "application/json"` nativo de Gemini 2.5 para garantizar salida estructurada y estricta, eliminando el parseo frágil con regex. |
| 🔁 **Exponential Backoff** | El servidor intercepta errores `503` y `429` (saturación de Google Cloud) y ejecuta reintentos espaciados dinámicamente (2s → 4s → 8s...) evitando propagar el error al cliente móvil. |
| 🔐 **Seguridad Stateless** | Autenticación mediante **JWT**. Sin estado en memoria, lo que permite escalado horizontal transparente. Cifrado de contraseñas con `bcryptjs` mediante Pre-save Hooks de Mongoose. |
| 🗄 **Modelado Desnormalizado (NoSQL)** | Las rutinas generadas se almacenan como documentos JSON anidados en MongoDB, optimizando la lectura a una única consulta `O(1)` desde la app Android. |

---

## 💻 Stack Tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js (ESModules) |
| Framework | Express.js |
| Base de Datos | MongoDB Atlas + Mongoose ODM |
| Seguridad | `jsonwebtoken`, `bcryptjs` |
| Inteligencia Artificial | `@google/generative-ai` (SDK oficial) |

---

## 🚀 Instalación y Configuración Local

### Prerrequisitos

- Node.js **v18+**
- Cuenta en [Google AI Studio](https://aistudio.google.com/) con API Key activa
- Cluster en [MongoDB Atlas](https://www.mongodb.com/atlas) (o instancia local)

### Pasos

**1. Clonar el repositorio**

```bash
git clone https://github.com/TU_USUARIO/hybrid-ai-backend.git
cd hybrid-ai-backend
```

**2. Instalar dependencias**

```bash
npm install
```

**3. Configurar variables de entorno**

Crea un archivo `.env` en la raíz del proyecto. **Nunca lo subas a control de versiones.**

```env
PORT=3000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/hybrid_ai
GEMINI_API_KEY=tu_google_gemini_api_key
JWT_SECRET=tu_secreto_criptografico_largo_y_seguro
JWT_EXPIRES_IN=30d
```

**4. Arrancar en modo desarrollo**

```bash
npm run dev
```

Si todo está bien, verás:
```
[Server] Running in development mode on port 3000
[Database] MongoDB Connected
```

---

## 🗺 Endpoints (API REST)

Todas las rutas privadas requieren el token JWT en el header de cada petición:

```
Authorization: Bearer <tu_token_jwt>
```

### 🔐 Autenticación — `/api/auth`

| Método | Endpoint | Descripción | Body requerido |
|---|---|---|---|
| `POST` | `/register` | Registra un usuario, encripta la clave y emite JWT. | `name`, `email`, `password`, `age`, `weight`, `height`, `sex`, `goal`, `fitnessLevel`, `daysAvailable`, `planDuration` |
| `POST` | `/login` | Valida credenciales contra la BD y emite JWT. | `email`, `password` |

### 🤖 Inteligencia Artificial — `/api/ai`

| Método | Endpoint | Descripción | Seguridad |
|---|---|---|---|
| `POST` | `/generate-plan` | Llama a Gemini, inyecta el perfil biométrico, genera la rutina y la persiste en DB. | 🔒 Privado |

### 📋 Planes de Entrenamiento — `/api/plans`

| Método | Endpoint | Descripción | Seguridad |
|---|---|---|---|
| `GET` | `/active` | Retorna el último plan generado y activo del usuario. | 🔒 Privado |
| `GET` | `/history` | Retorna el historial de todos los planes (sin el payload de ejercicios). | 🔒 Privado |

---

## 📂 Estructura del Proyecto

```
hybrid-ai-backend/
├── src/
│   ├── controllers/          # Lógica de negocio y orquestación de req/res
│   │   ├── aiController.js
│   │   ├── authController.js
│   │   └── workoutPlanController.js
│   ├── middlewares/          # Interceptores (JWT, manejo de errores)
│   │   └── authMiddleware.js
│   ├── models/               # Esquemas Mongoose con validaciones estrictas
│   │   ├── User.js
│   │   └── WorkoutPlan.js
│   ├── routes/               # Definición de endpoints
│   │   ├── aiRoutes.js
│   │   ├── authRoutes.js
│   │   └── workoutPlanRoutes.js
│   ├── services/             # Conectores a APIs externas
│   │   └── geminiService.js  # Exponential Backoff + gestión de prompts
│   └── app.js                # Punto de entrada de Express
├── .env                      # Variables de entorno (excluido de Git)
├── .gitignore
├── package.json
└── README.md
```

---

<div align="center">

Desarrollado para integración con cliente nativo **Android (Kotlin)** · 2025

</div>