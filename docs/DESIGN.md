# Dirección de arte — Sorteo Studio

**Tipo:** software (SaaS de eventos). **Se vende:** sorteos en vivo con marca propia para empresas.
**Quien compra:** gerentes/contadores que organizan eventos corporativos en Ecuador.
**Acción principal:** iniciar sesión y girar el sorteo en el escenario.

## Concepto

"**La mesa del sorteo, no un juguete.**" Una herramienta de sala de juntas que se transforma en
espectáculo. Sobrio y caro en la configuración; teatral y grande en el escenario. Nada de arcoíris
infantil: el color lo pone **la marca del cliente** (white-label), no el producto.

## Paleta (tokens en `public/styles/system.css`)

| Rol | Token | HEX | Uso |
|---|---|---|---|
| Fondo profundo | `--ink` | `#05070D` | lienzo del escenario y login |
| Superficie | `--surface` | `#0B101B` | tarjetas, rail, drawer |
| Superficie alta | `--surface-2` | `#121927` | inputs, filas hover, chips |
| Línea | `--line` | `rgba(255,255,255,.10)` | bordes 1px, separadores |
| Texto | `--text` | `#F3F5FA` | títulos y datos |
| Texto tenue | `--muted` | `#96A2BA` | ayudas, labels, metadatos |
| Acento (marca) | `--brand` | `#E3B04B` (gold) | primario, foco, ruleta, ganador |
| Acento profundidad | `--brand-deep` | derivado | gradientes del acento |
| Éxito | `--ok` | `#3ED3A3` | licencia activa |
| Aviso | `--warn` | `#F0B429` | por vencer |
| Peligro | `--danger` | `#FF6B6B` | revocada / errores |

**`--brand` es dinámico**: se sobreescribe con el color dominante del logo de la empresa
(`accounts.brand_color`). Todo componente debe usar `var(--brand)`; **prohibido** hex de acento
suelto dentro de componentes. Paleta neutra obligatoria = el producto desaparece, la marca manda.

Prohibido por cliché: violeta/lavanda en cualquier parte, degradados violeta→azul, tarjetas
idénticas con iconitos, bordes ultra-redondeados en todo, emojis en titulares, glow morado.

## Tipografía

- **Display:** `Fraunces` (serif variable) → nombres de ganador, títulos de escenario, cifras grandes. `font-optical-sizing:auto`.
- **UI:** `Inter` → todo lo demás. `font-feature-settings:"cv11","ss01"`, `letter-spacing:-.011em`.
- **Números:** `font-variant-numeric: tabular-nums` en todo dato alineable (tablas, contadores, precios, fechas).
- Escala: 11 / 12.5 / 14 / 16 / 19 / 24 / 32 / 44 / clamp(64→120) para el nombre ganador en escenario.
- Tracking: titulares `-.02em`; labels en mayúsculas `+.12em` a 11px.

## Espaciado y forma

- Base 4 px. Escala: 4 8 12 16 20 24 32 40 56 72.
- Contenedor: `max-width:1320px`, gutter 24 (16 en móvil).
- Radios: `--r-sm:10px`, `--r-md:14px`, `--r-lg:20px`, `--r-pill:999px` (solo pills y botones pequeños).
- Elevación: `--shadow-1` sutil, `--shadow-2` para drawers/modales, sin glow morado.
- Tensión asimétrica: el rail del estudio es fijo (300px) y el escenario respira; en el login, columna
  editorial 55% / formulario 45%, nunca 50/50.

## Páginas

1. **`/login`** — pantalla partida. Izquierda: marca del producto pequeña, titular editorial y una
   ruleta real girando lenta tras un vidrio (canvas, un solo "wow"). Derecha: formulario en tarjeta
   con `username`/`password`, error en línea, link "¿Olvidaste tu contraseña? Habla con tu asesor".
   Sin registro público: el acceso lo entrega el administrador.
2. **`/` (estudio)** — rail izquierdo: **plato de marca con el logo de la empresa (protagonista,
   48–64px de alto, máx 240px de ancho)** + nombre de la empresa; navegación Sorteo/Participantes/
   Marca/Historial; pie con estado de licencia y usuario. Centro: configuración con **vista previa
   viva de la ruleta** (el mismo canvas, actualizado al cambiar participantes/marca). Botón grande
   "Abrir escenario".
3. **Escenario** — vista inmersiva a pantalla completa: ruleta grande, foco del participante bajo el
   puntero, botón Girar, historial mínimo, salir. Overlay de ganador con logo de la empresa + premio.
4. **`/admin`** — consola de licencias: KPIs arriba (cuentas, activas, por vencer), buscador, tabla
   con empresa/plan/estado/vencimiento/uso, acciones por fila (renovar, activar, revocar, reset de
   contraseña), drawer "Nueva cuenta" con alta manual (empresa, contacto, email, usuario,
   contraseña generada, plan, vence, monto, nota de pago). Bitácora de auditoría al pie.

## Microinteracciones (obligatorias)

- Botón: `translateY(-1px)` en hover, `scale(.99)` en active, 160ms `ease-out`; disabled 45% opacidad.
- Fila de tabla: fondo `--surface-2` en hover, transición 120ms.
- Tarjeta enlazada: sube 2px, borde a `--line-strong`.
- Pills de estado: punto 6px + texto; `por vencer` pulsa suavemente (2.4s) solo cuando quedan ≤7 días.
- Foco visible siempre: `outline:2px solid var(--brand); outline-offset:2px` (nunca quitarlo).
- Nada de fade-in por sección, parallax ni scroll-jacking. `prefers-reduced-motion` detiene todo.

## Accesibilidad (puerta de calidad)

- Contraste ≥ 4.5:1 texto normal, ≥3:1 grande. Verificado con Playwright.
- Un solo `h1` por página, jerarquía sin saltos.
- Todo control con nombre accesible; `label` visible en formularios.
- Targets ≥ 44px de alto en móvil. Sin scroll horizontal en 390 ni 1440.
- Estados vacíos escritos con voz propia ("Aún sin participantes. Sube la lista o usa los datos demo").

## Copy

Español de Ecuador, tuteo profesional, frases cortas, sin jerga. Verbos en botones ("Girar",
"Renovar licencia", "Crear cuenta"). Sin "Lorem", sin "Potencia tu negocio", sin signos de
exclamación en cadena.

## Marca blanca (regla dura)

- El logo y el nombre de **la empresa cliente** son lo primero en el estudio y en el overlay.
- "Sorteo Studio" aparece en: `title`, login (lockup pequeño), pie del rail en 11px `--muted`, y
  `footer` de admin. **Nunca** dentro del escenario durante un sorteo.
- Si no hay logo cargado: monograma con la inicial de la empresa sobre `--brand` (nunca la "U" de UpConta).
