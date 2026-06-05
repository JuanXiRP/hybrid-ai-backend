# Hybrid AI Training - Backend API

Backend RESTful diseñado para la aplicación móvil Hybrid AI Training. Actúa como el núcleo central de la lógica de negocio: gestiona la autenticación, persiste datos biométricos y orquesta la comunicación con Google Gemini 2.5 Flash para la generación de planificaciones deportivas hiperpersonalizadas.

## Arquitectura y Patrones de Diseño

El sistema está construido siguiendo los principios SOLID y Clean Architecture, asegurando escalabilidad, bajo acoplamiento y alta resiliencia.

* Integración AI Determinista: Uso del modo `responseMimeType: "application/json"` nativo de Gemini 2.5 para garantizar una salida estructurada y estricta, eliminando el parseo basado en expresiones regulares.
* Exponential Backoff: El servidor intercepta errores 503 y 429 de Google Cloud y ejecuta reintentos espaciados dinámicamente (2s → 4s → 8s) para evitar la propagación del error al cliente móvil.
* Seguridad Stateless: Autenticación mediante JWT sin estado en memoria, permitiendo un escalado horizontal transparente. Cifrado de contraseñas con `bcryptjs` mediante hooks de pre-guardado en Mongoose.
* Modelado Desnormalizado (NoSQL): Las rutinas generadas se almacenan como documentos JSON anidados en MongoDB, optimizando la lectura a una única consulta O(1) desde el cliente.

## Stack Tecnológico

* Runtime: Node.js (ESModules)
* Framework: Express.js
* Base de Datos: MongoDB Atlas + Mongoose ODM
* Seguridad: jsonwebtoken, bcryptjs
* IA: @google/generative-ai

## Instalación y Configuración Local

### Prerrequisitos

* Node.js v18+
* Clave de API activa en Google AI Studio
* Cluster en MongoDB Atlas o instancia local