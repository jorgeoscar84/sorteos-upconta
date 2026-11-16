/* Índice de pruebas.
   `npm test` ejecuta `node --test tests/`; esta versión de Node (24.22) trata
   el argumento de directorio como un módulo y no lo expande, así que este
   archivo importa explícitamente cada suite. Añadir aquí las nuevas suites. */
import './api.test.js';
