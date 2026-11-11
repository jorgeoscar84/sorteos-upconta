# UpConta · Sorteos en Vivo

Aplicación web (100% estática, sin backend) para hacer sorteos en eventos corporativos:
ruleta animada, tambores, fanfarria, confeti y serpentinas. Pensada para proyectar en
pantalla grande con ~60 participantes.

## Funciones

- **Ruleta** con sectores de alto contraste (legible a distancia) y selección con
  criptografía (`crypto.getRandomValues` + Fisher-Yates), no `Math.random` sesgado.
- **Importación de participantes**: Excel (.xlsx/.xls), CSV, TSV, JSON o pegar lista.
  Detecta columnas automáticamente (Número / Nombre / Empresa / Cargo / Teléfono).
- **Plantillas descargables** (.xlsx y .csv) con el formato esperado.
- **Ganadores múltiples** (1–12 por sorteo), revelado simultáneo o uno a uno.
- **Vueltas configurables** (2–40) y duración del giro (3–16 s).
- **Descartar ganadores**: los que ya ganaron no vuelven a salir (rondas sin repetición).
- **Sonido sintetizado con WebAudio** (sin archivos): redoble de tambores acelerado,
  "ticks" al pasar cada gajo, crash de platillos, fanfarria y aplausos.
- **Confeti + serpentinas** en canvas, cañones laterales y lluvia.
- **Branding**: logo principal + logos de marcas participantes (se muestran en la
  cabecera), nombre de marca y título del evento.
- **Historial y exportación** de resultados a CSV (para el acta del evento).
- **Atajos**: `Espacio` girar · `F` pantalla completa · `R` siguiente sorteo · `M` sonido.
- **Persistencia** en `localStorage`: si se recarga la página no se pierden datos.

## Stack

- HTML + CSS + JavaScript puro (sin build step).
- [SheetJS](https://sheetjs.com) vendorizado (`assets/xlsx.full.min.js`) para leer Excel offline.
- Servido por **nginx** (imagen Alpine) con `/healthz`.

## Desarrollo local

```bash
# cualquier servidor estático
npx serve .
```

## Deploy

`Dockerfile` → nginx:1.27-alpine, escucha en el puerto **80**.
Desplegado en Dokploy con dominio genérico.

## Formato de la plantilla

| NUMERO | NOMBRE | EMPRESA | CARGO | TELEFONO |
|--------|--------|---------|-------|----------|
| 1 | Ana Torres | UpConta | Contadora Senior | 0991111111 |

Las columnas extra se concatenan y se muestran como "detalle" del participante.
