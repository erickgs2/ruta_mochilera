# Identidad visual de La Ruta Mochilera

La identidad de la plataforma sale del material que la agencia ya publica: el
logo (`assets/branding/logo.png`) y los carteles de sus rutas en redes sociales
(`assets/rutas/`). Nada se inventó encima: el amarillo es el del logo, el
carbón y el crema son los de las letras y la píldora de fechas de los carteles,
y la tipografía es la de sus titulares.

## Logo

| Archivo | Para qué |
|---|---|
| `assets/branding/logo.png` | Original de la agencia, trazo blanco sobre amarillo. No se edita. |
| `assets/branding/logo-on-light.png` | Sin fondo, trazo carbón `#3D3B33`. Sobre fondos claros **y sobre el amarillo** de marca. |
| `assets/branding/logo-on-dark.png` | Sin fondo, trazo blanco. Sobre fondos oscuros o fotografías. |
| `assets/branding/logo-badge.png` | El sello de los carteles: trazo blanco en un disco amarillo. Origen de favicons e íconos. |

Los dos PNG sin fondo se derivan del original midiendo cuánto blanco tiene cada
píxel (el canal azul va de 35 en el amarillo a 255 en el blanco), así que los
bordes conservan su suavizado en vez de quedar dentados. Están recortados al
trazo con un margen de 24 px y son cuadrados (880 × 880).

Las dos apps sirven estos archivos en `brand/` (ver `assets` en cada
`project.json`); los favicons (`favicon.ico`, `icon-192.png`, `icon-512.png`,
`apple-touch-icon.png`) viven en el `public/` de cada app.

## Color

Definidos una sola vez como variables CSS en
`libs/ui/src/styles/_brand.scss` (`@include brand.tokens`).

| Token | Valor | Uso |
|---|---|---|
| `--rm-yellow` | `#F9D423` | El amarillo del logo. Bandas de marca, botón principal, barra superior. |
| `--rm-yellow-strong` | `#FFD600` | El amarillo de imprenta de los carteles. Estado *hover* del botón. |
| `--rm-yellow-soft` | `#FFF3B0` | Elemento activo de la navegación, fondos suaves. |
| `--rm-cream` | `#FCF6DA` | La píldora de fechas. Avisos sin leer, pagos pendientes. |
| `--rm-ground` | `#FFFCF0` | Fondo de página: crema muy tenue, nunca gris. |
| `--rm-ink` | `#2A2924` | Texto y trazos. Sobre amarillo, crema o blanco supera 4.5:1. |
| `--rm-ink-soft` | `#57544A` | Texto secundario. |
| `--rm-line` / `--rm-line-strong` | `#E8E0C4` / `#8A8470` | Divisores / bordes de campos (3:1, WCAG 1.4.11). |
| `--rm-danger`, `--rm-success` | `#B3261E`, `#1E6B34` | Estados. Un botón destructivo es rojo, nunca amarillo. |

**El amarillo siempre lleva texto carbón, nunca blanco.** Es la regla de los
carteles y la única combinación con contraste suficiente. Por eso, en el panel,
el `primary` de Material es el carbón y no el amarillo: `primary` también
colorea campos enfocados, enlaces y casillas, donde el amarillo sobre blanco no
se leería.

## Tipografía

**Poppins**, autoalojada con `@fontsource/poppins` (400, 500, 600, 700, 800) en
el `styles` de cada app: la app empaquetada con Capacitor no depende de una CDN
de fuentes. Titulares en 800 con tracking −0.02em a −0.035em, como los
carteles; texto en 400.

## El gesto distintivo

**La píldora de fechas** (`@include brand.date-pill`): crema, totalmente
redondeada, cifras gruesas en carbón. Es el elemento que se repite en cada
cartel y es la firma de la plataforma. Se usa para las fechas de un viaje y
para nada más.

En el catálogo del cliente, además, cada viaje va enmarcado como los «posts» de
los carteles: marco blanco alrededor de la foto y el nombre en 800 debajo, y el
primer viaje (la próxima salida) ocupa dos columnas en pantallas anchas.

## Dónde vive cada cosa

- **Panel (`apps/admin`)** — herramienta de trabajo: la marca aporta tipografía,
  paleta y la barra amarilla con el logo; los controles siguen siendo los de
  Angular Material. Tema en `apps/admin/src/styles.scss`.
- **App del cliente (`apps/client`)** — el catálogo es donde la marca manda:
  banda amarilla con titular grueso, tarjetas-post, píldora de fechas y botón
  de reservar fijo abajo en el teléfono. Estilos globales en
  `apps/client/src/styles.scss`.

## Lo que no se hace

- Franjas laterales de color en tarjetas o filas: el resaltado es un fondo
  tintado más una etiqueta con palabras.
- Texto blanco sobre amarillo.
- Una fuente del sistema como voz de los titulares.
- Colores escritos a mano en un componente: siempre un token `--rm-*` o un
  token de sistema de Material (`--mat-sys-*`).

## Contenido de demostración

`pnpm db:seed:demo` (después de `pnpm db:seed`) crea las siete rutas de los
carteles, publicadas, con su foto central como portada
(`libs/db/prisma/demo/covers/`). Nombres, fechas, destinos e inclusiones salen
de los carteles; **precios, anticipos y cupo son ilustrativos**, porque los
carteles no los publican. Se niega a correr con `NODE_ENV=production` salvo
que se fije `ALLOW_DEMO_SEED=1`.
