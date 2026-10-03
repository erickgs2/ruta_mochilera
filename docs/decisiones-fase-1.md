# Decisiones tomadas durante la ejecución de la Fase 1

Este documento preserva las 68 decisiones que el coordinador tomó por su cuenta
mientras ejecutaba el plan de la Fase 1, en el orden en que se tomaron. Se registran
aquí porque el ledger de ejecución vive fuera de git y se borra al cerrar la fase.

Cada una incluye el razonamiento y, donde aplica, qué cuesta si resultó equivocada.
La mayoría son correcciones al plan de implementación, no al código: el plan se
escribió antes de ejecutarse y acumuló defectos que sólo se vieron al construirlo.

**Rama:** `feature/phase-1-foundations` · **44 commits** · `cd75d6b..333240f`

---


### 1. usar Node 24 LTS en lugar de Node 22 — es el LTS vigente y el único instalado; ajustar `.nvmrc`, ambos Dockerfiles y el workflow de CI — si se equivoca, un `.nvmrc` a corregir.

### 2. instalar pnpm con `corepack enable` en vez de exigirlo preinstalado — corepack ya está — si se equivoca, un paso de setup distinto.

### 3. dev y pruebas usan el PostgreSQL 15 nativo (bases `rm_dev` y `rm_test`, ambas en :5432) en lugar de Docker Compose, que no existe en esta máquina. Los archivos Compose se siguen escribiendo como artefactos de despliegue para Raspberry y EC2, y el CI usa service containers de GitHub, que no requieren Docker local. `TEST_DATABASE_URL` apunta a `postgresql://localhost:5432/rm_test` — si se equivoca, hay que levantar Docker y cambiar dos URLs.

### 4. PostgreSQL 15 en local contra 16 en las imágenes — el esquema no usa nada exclusivo de 16 — si se equivoca, aparece al desplegar y se arregla subiendo la versión local.

### 5. T1 añade también los alias de subruta `@rm/db/testing` y `@rm/storage/testing` en tsconfig.base.json — sin ellos las pruebas de integración no compilan — si se equivoca, un alias de más.

### 6. T6 modifica `libs/db/prisma/seed.ts` para usar `hashPassword` de `@rm/domain-identity` en cuanto esa función existe — mantener dos rutas de hashing con parámetros distintos es una trampa — si se equivoca, el seed rehashea con otros parámetros y sólo hay que volver a sembrar.

### 7. T15 registra los esquemas compartidos como componentes con nombre (`registry.register('Permission', permissionSchema)`, y lo mismo para `Role`, `Staff`, `Session`, `Problem`) antes de generar el documento, para que `components.schemas` exista — si se equivoca, los tipos generados quedan inline y hay que retocar `endpoints.ts`.

### 8. T16 implementa `MoneyPipe` sobre `formatMoney` de `@rm/shared-utils`, tomando el idioma de `LanguageService.current()`, con prueba propia — el plan lo usa sin definirlo — si se equivoca, un pipe a reescribir.

### 9. si el generador de Nx no acepta `--unitTestRunner=vitest` para proyectos Angular, usar jest en `admin` y `ui` y mantener vitest en el resto — si se equivoca, dos configuraciones de pruebas en vez de una.

### 10. pnpm instalado con `brew install pnpm` (12.6.0) porque `corepack enable` no puede escribir en /usr/local/bin sin sudo — el plan exige pnpm y Homebrew es escribible por el usuario — si se equivoca, `brew uninstall pnpm` lo revierte.

### 11. los briefs se extraen con un awk propio, no con scripts/task-brief, porque ese script busca encabezados "Task N" y el plan los tiene en español — sin efecto sobre el código.

### 12. el trabajo va en la rama feature/phase-1-foundations, no en main; main sólo tiene el commit de documentación — si se equivoca, un merge trivial.

### 13. el despacho de la Tarea 4 debe advertir que el plan escribió el bloque `generator` de Prisma asumiendo `prisma-client-js`, y que Prisma 7 cambió ese contrato; el implementador debe verificar el generador vigente y adaptar el bloque en vez de copiarlo literal — si se equivoca, `prisma generate` falla en la primera corrida y se corrige ahí mismo.

### 14. Next 16 y Angular 22 son mayores que lo que asumió el plan (Next 15 / Angular 20). Las firmas de Route Handler con `params: Promise<...>` que usa el plan siguen siendo las correctas en Next 16 — si se equivoca, aparece al compilar la Tarea 8.

### 15. Tarea 2

los dos archivos Compose SÍ se escriben tal como los especifica el plan — son entregables válidos para la Raspberry y para cualquier máquina con Docker —, pero el paso de verificación local cambia: en vez de `docker compose up -d`, se verifica la conexión al PostgreSQL nativo con `PGPASSWORD=rm psql -h localhost -U rm -d rm_dev -c 'select 1'` — si se equivoca, un paso de verificación a reescribir.

### 16. Tarea 2 y 4

`compose.test.yml` conserva el puerto 5433 para quien use Docker, pero el valor por defecto de `TEST_DATABASE_URL` en `libs/db/src/testing/test-db.ts` (Tarea 4) pasa de 5433 a **5432**, que es donde vive `rm_test` en esta máquina. El CI sigue fijando la variable explícitamente hacia su service container. Sin esto, todas las pruebas de integración de las Tareas 4, 7, 9, 10, 12, 13 y 14 fallan al conectar — si se equivoca, una cadena de conexión.

### 17. Tarea 2

`.env.example` documenta ambos escenarios: nativo (5432, el de esta máquina) y Docker Compose (5433 para pruebas), con el nativo como valor activo — si se equivoca, un comentario de más.

### 18. SISTÉMICO, afecta 10 tareas

el plan contiene ~25 comentarios en español dentro de bloques de código, en las tareas 3, 6, 7, 8, 9, 10, 12, 14, 16 y 19. La restricción global de la spec ("todo el código en inglés, comentarios incluidos; sólo docs/** en español") es la autoridad vinculante y el plan es sólo su argumento, así que el plan pierde. Añadí una sección "CORRECCIÓN DEL CONTROLADOR" a constraints.md ordenando traducir todo comentario de código al inglés conservando el sentido, y regeneré los briefs 3-19 con ella. No reescribo los 25 bloques del plan: es caro y arriesgado, y la corrección en el brief llega igual a cada implementador — si se equivoca, aparecen comentarios en español en revisiones posteriores y se corrigen ahí.

### 19. acepto el hallazgo plan-mandated sobre `loadEnv` — descartar `issue.path` deja sin nombre a cualquier fallo con mensaje estándar de Zod, y un cargador de configuración existe precisamente para dar un error accionable. Se corrige con prefijo de path y una cuarta prueba — si se equivoca, un formato de mensaje distinto.

### 20. Tarea 4, estructural

adoptamos Prisma 7 tal cual en vez de fijar Prisma 6. El bloque `generator`/`datasource` del brief se reemplaza por el contrato de arriba; el output generado va dentro de `libs/db` y se ignora en git, porque el CI ya corre `pnpm db:generate` antes de compilar. Consecuencia buena y buscada: al no existir ya `@prisma/client` como ruta pública, **nada fuera de `libs/db` importa Prisma directamente** — `libs/db/src/index.ts` reexporta `PrismaClient`, los tipos de modelo y el namespace `Prisma`, y todo el resto del código consume `@rm/db`. Eso es precisamente el límite que la spec quería. Si se equivoca, hay que retocar los imports de `@rm/db` en las tareas 4, 7, 9, 10, 12, 13 y 14.

### 21. Tarea 9

`libs/domain/audit/src/lib/audit.ts` importa `import type { Prisma } from '@prisma/client'` en el plan; pasa a importarse desde `@rm/db` por el ruling anterior — si se equivoca, un import.

### 22. Tarea 12

`slugify` usa un rango de diacríticos combinantes escrito con caracteres literales invisibles. Verifiqué que sobrevive y produce `oaxaca-magica`, pero el implementador debe reescribirlo como `/[̀-ͯ]/g` para que el fuente sea legible y no lo rompa un editor — si se equivoca, el slug pierde el despojo de acentos y la prueba lo detecta.

### 23. el arreglo no pertenece a la Tarea 4 (no lo causó) sino al andamiaje de la Tarea 1. Reabro la Tarea 1 con su implementador original, que conserva el contexto del andamiaje, mientras la revisión de la Tarea 4 corre en paralelo — el revisor lee un diff congelado en archivo, así que no hay conflicto. Es carga bloqueante: las Tareas 8, 9, 10, 14 y 15 ponen route handlers en `apps/api` y no pueden cerrarse sobre una app que no compila — si me equivoco, el arreglo se revierte y se mueve a la Tarea 19.

### 24. proceso, aplica a las 15 tareas restantes

toda verificación final de tarea debe usar `--skip-nx-cache`. Un verde cacheado no es evidencia. Esto se añade a cada despacho desde ahora — si me equivoco, sólo cuesta tiempo de CPU en cada tarea.

### 25. intentar primero **subir Next de 16.1.7 a 16.3.6** y sólo si eso rompe la integración de @nx/next, caer al build con webpack sólo para `apps/api`. Razón: 16.1.7 lo fijó el generador de Nx con `~16.1.6`, pero el estable actual es 16.3.6 y la restricción global del plan pide la última estable — o sea que 16.1.7 nunca fue lo pedido, y hay dos minors de correcciones desde entonces. El fallback a webpack ya está probado, así que el riesgo del intento es bajo. Si se equivoca, se revierte el bump y se usa webpack, que es el plan B ya verificado.

### 26. si se usa webpack, va sólo en el target de build de producción, con un comentario en el sitio de configuración que nombre el bug y la versión observada; un override de bundler sin documentar se vuelve permanente por accidente.

### 27. promuevo a Important los minors 2 y 3 del revisor (cliente Prisma nunca cerrado → ~70 conexiones con siete suites contra max_connections=100; y `rejects.toThrow()` que acepta cualquier excepción, incluida un error de conexión). El argumento del propio revisor los justifica: estos dos archivos son la PLANTILLA que las siete suites siguientes van a copiar. Corregir ahora cuesta líneas de configuración; corregir después cuesta siete suites ya escritas mal. Si me equivoco, es trabajo de más en una tarea barata.

### 28. incluyo también el minor 4 (guard de DATABASE_URL en seed.ts) porque la Tarea 5 es justo quien va a correr ese seed por primera vez, y un fallo opaco del driver ahí costaría una ronda.

### 29. añado `"postinstall": "prisma generate"` — el cliente generado está en .gitignore y no existe workflow de CI todavía, así que hoy un clon limpio deja `@rm/db` sin resolver. Es un agujero real que afecta a cualquier implementador que haga install desde cero. Si me equivoco, un script de más que el CI de la Tarea 19 igual necesitaría.

### 30. la línea "Consumes: loadEnv de @rm/shared-utils" del brief es un artefacto del plan: `loadEnv` exige JWT_SECRET, APP_BASE_URL y STORAGE_*, que un script de seed no tiene por qué proveer. Leer `process.env` directamente CON guard es lo correcto. No es incumplimiento del implementador.

### 31. mi prescripción del hallazgo 3 era incorrecta — `meta.target` no existe en Prisma 7 con driver adapter; el índice violado llega por `meta.driverAdapterError.cause.constraint.index`. El implementador lo detectó y extrajo un helper `uniqueViolationIndex()` en @rm/db/testing para que las siete suites no caminen ese path a mano. Acepto su solución sobre la mía: es más específica y evita repetir siete veces un acceso frágil.

### 32. acepto que `prepareTestDb()` lance `prisma migrate deploy` la primera vez que el esquema de un worker está atrasado, en vez de moverlo a globalSetup. globalSetup corre una sola vez antes de que existan los workers, así que no puede crear esquemas por worker sin duplicar la lógica de conteo de workers. El helper es idempotente y está guardado. Al review final como minor diferido — si me equivoco, se mueve a globalSetup con un conteo fijo de workers.

### 33. abro fix round 2 por el "template risk" que levantó la re-revisión, y es un hueco de MI prescripción: `VITEST_WORKER_ID` sólo es único dentro de un proceso de Vitest, y cada proyecto de Nx corre el suyo. Con `nx run-many --parallel=3`, el worker 0 de libs/db y el worker 0 de libs/domain/identity calcularían el mismo `test_w0` sobre la misma base. Es la carrera de la ronda 1 reaparecida un nivel arriba. No se manifiesta hoy porque sólo hay un consumidor, pero el segundo es la Tarea 7. Cerrarlo ahora cuesta una clave compuesta; descubrirlo en la Tarea 7 cuesta un diagnóstico falso sobre código de dominio — si me equivoco, una clave de esquema más larga de lo necesario.

### 34. el conteo correcto es 29, no 27. Verifiqué comparando clave por clave el bloque de la Tarea 5 contra el archivo implementado: IDÉNTICAS. El "27" de mi prosa era un error de conteo mío; las 3 líneas extra que aparecían al contar sobre todo el plan pertenecen a un fixture de prueba de la Tarea 17. El implementador acertó al señalarlo en vez de recortar el catálogo para cuadrar con mi cifra — si me equivoco, sobran dos permisos que nadie usa.

### 35. corrección para mis propios despachos

los nombres de proyecto de Nx se derivan del directorio, no del importPath. Son `rbac`, `identity`, `trips`, `costing`, `staff`, `audit`, `db`, `ui`, `api`, `admin`, etc. — NO `domain-rbac`. Los importPaths sí son `@rm/domain-*`. He estado dando comandos de test con el nombre equivocado; corregirlo en los despachos restantes.

### 36. se corrigen las dos mitades — filtrar contra el catálogo en `loadActorPermissions` para que el tipo de retorno sea cierto por construcción y no por aserción, y podar en el seed las filas ausentes del catálogo, como ya hace el bloque de Super Admin. La poda debe registrar cada clave eliminada, no sólo un conteo: un rename mal hecho tiene que ser visible, no silencioso — si me equivoco, el seed borra filas que alguien quería conservar, y por eso se exige el log.

### 37. REVOCADA — escribí antes "T6 modifica libs/db/prisma/seed.ts para usar hashPassword de @rm/domain-identity". Está MAL y no se ejecuta. `libs/domain/identity` importa `Db` de `@rm/db`, y el seed vive DENTRO de libs/db, así que ese cambio crearía el ciclo libs/db → libs/domain/identity → libs/db, que las fronteras de módulo de Nx rechazan.

### 38. Ruling de reemplazo: el seed sigue usando `@node-rs/argon2` directo. El riesgo que me preocupaba es menor de lo que pensé: un hash argon2 codificado lleva embebidos sus propios parámetros (m, t, p), así que `verifyPassword` valida correctamente un hash generado con otros parámetros. Lo único que difiere es el costo de cómputo del hash sembrado, no su verificabilidad. Se pide un comentario en el seed que lo explique, para que nadie "arregle" la duplicación aparente creando el ciclo — si me equivoco, el usuario inicial queda con un hash más barato de lo previsto y basta resembrarlo.

### 39. corrijo los dos primeros. (1) Fijar `algorithms: ['HS256']` en jwtVerify — el revisor demostró que hoy NO es explotable, porque una clave simétrica cruda bloquea estructuralmente la confusión RS256→HS256, pero la propiedad se sostiene por accidente del material de clave y no por declaración; el día que alguien pase a clave asimétrica desaparece en silencio y ninguna prueba falla. (2) Validar `type` y `locale` contra sus uniones literales, no sólo contra typeof string: `type` decide STAFF vs CUSTOMER, o sea autorización.

### 40. DIFIERO el tercero (catch amplio en verifyPassword que enmascara fallos sistémicos de argon2 como contraseña incorrecta). Estrecharlo arriesga lanzar ante hashes malformados, que el brief exige que devuelvan false. Carry-forward a la Tarea 7: el servicio de autenticación debe diseñarse sabiendo que un fallo sistémico de hashing es indistinguible de credenciales malas.

### 41. el target de typecheck se añade AHORA, en esta ronda, y no se difiere a la Tarea 19. Doce tareas más sin comprobación de tipos habrían acumulado esta deuda en silencio, y el síntoma aparece siempre lejos de la causa (aquí habría estallado en la Tarea 8, al importar el servicio en apps/api). Se exige demostrarlo viéndolo fallar con el error conocido antes del arreglo — si me equivoco, un target de más que el CI de la Tarea 19 iba a necesitar igual.

### 42. el comentario de `DbTransactionClient` afirma que el tipo excluye `$transaction` y que eso impide anidar transacciones. Es FALSO: la denylist real es $connect/$disconnect/$on/$use/$extends. Se corrige antes de que cuatro tareas lo copien, y se añade el hecho que originó el bug: DbTransactionClient NO es asignable a Db.

### 43. el implementador preguntó si añadir un fixture de dos tokens vivos para poder discriminar el alcance de logout. SÍ. Su observación es correcta —la API pública nunca produce esa forma de cadena— pero ese estado no es imposible: es exactamente el que producía la carrera de rotación del item 4 antes de arreglarla, y es contra lo que logout-por-cadena defiende. Probar una defensa con un fixture construido a mano es correcto; exigir que el estado sea alcanzable por la API pública equivaldría a decir que la defensa sólo puede probarse una vez reintroducido el bug del que protege — si me equivoco, una prueba de más.

### 44. ESCALO a máxima prioridad un hallazgo que el revisor clasificó como minor. `getActor` devuelve null con token expirado; `route()` llama a `requirePermission(null, …)` que devuelve PERMISSION_DENIED → 403. O sea: token vencido en endpoint protegido = 403, no 401. El interceptor de Angular de la Tarea 16 renueva la sesión al ver 401, así que nunca se dispararía y el panel expulsaría al usuario cada 15 minutos en vez de renovar. Es un fallo funcional del producto, no una sutileza de códigos HTTP. Se arregla en la capa HTTP (identidad primero → 401; permiso después → 403) y NO en requirePermission, que es dominio puro y cuyo comportamiento actual es correcto para un llamador de dominio — si me equivoco, el coste es un 401 donde alguien esperaba 403.

### 45. la rama `permission` de route() no tiene NINGUNA prueba — es la línea más relevante para seguridad de toda la plantilla y veinte endpoints dependen de ella. Se exige un route.spec.ts dedicado.

### 46. convertir RouteOptions en unión discriminada para que {auth:'public', permission:X} sea irrepresentable y para que RouteContext.actor se estreche a Actor no-nulo cuando hay autenticación. Eso elimina el `actor!` de los veinte endpoints en vez de dejarlo como convención — y una convención es exactamente lo que acaba de fallar aquí. Con permiso explícito de caer a un throw en tiempo de definición si los tipos resultan más difíciles de leer que el problema que resuelven.

### 47. plan-mandated

/me consulta Prisma directamente y da forma al DTO en la capa HTTP, violando la regla de cuatro responsabilidades de CLAUDE.md. Defecto de mi brief. Se resuelve exportando `describeUser` desde @rm/domain-identity, que ya hace exactamente esa transformación para login y refresh — elimina la violación y la duplicación a la vez.

### 48. el hallazgo del TOCTOU en deleteRole revela algo que el revisor no nombró — EL ESQUEMA CONTRADICE LA REGLA. "Un rol con usuarios asignados no se puede borrar" es exactamente lo que expresa una llave foránea, pero UserRole.roleId está declarada `onDelete: Cascade`, que dice lo contrario. La regla vive sólo en un conteo en TypeScript fuera de la transacción. Se cambia a `onDelete: Restrict` con migración y se mapea la violación de FK a ROLE_IN_USE; PostgreSQL pasa a ser quien garantiza el invariante. Se conservan Cascade en el lado userId (borrar un usuario sí debe quitar sus asignaciones) y en RolePermission (borrar un rol sí debe quitar sus enlaces de permiso). Mover el conteo dentro de la transacción sólo estrecha la ventana; la restricción la cierra — si me equivoco, un borrado legítimo se rechaza y hay que quitar asignaciones primero, que es justo lo que la regla pide.

### 49. dos rutas sin cobertura completa del candado de permisos (GET /roles sin caso 403, GET /permissions sin caso positivo). Es la misma brecha que la revisión de la Tarea 8 encontró en el envoltorio, reapareciendo ruta por ruta. Toda ruta protegida necesita la tríada completa: permitido, 403 sin permiso, 401 sin token.

### 50. Ruling aceptado (desviación del implementador que corrige una instrucción MÍA): le dije reutilizar `uniqueViolationIndex` desde `@rm/db/testing`, sin considerar que ese módulo hace sondeo de filesystem en tiempo de importación para calcular el esquema por worker. Importarlo desde producción habría sido un error grave. Lo movió a `libs/db/src/lib/prisma-errors.ts` y lo reexportó desde testing. Correcto y mejor que mi instrucción.

### 51. el contrato compartido no lo detectó porque sus diez casos de clave malformada llaman SÓLO a put. Se extiende para cubrir las cinco operaciones con al menos una clave insegura representativa, en storage-contract.ts y no en el spec local, para que S3 lo herede cuando su contrato pueda ejecutarse. Se exige ver el contrato extendido FALLAR contra el exists() actual antes del arreglo.

### 52. se corrigen los cinco. (1) listTrips pasa por committedSeats y se corrigen las dos afirmaciones falsas. (2) uniqueSlug gana respaldo ante violación única con el patrón ya establecido en role-service. (3) el chequeo de capacidad usa input.preSoldSeats, no existing, y se mueve dentro de la transacción. (4) el gate de backfill pasa a ser consciente de zona horaria leyendo SystemSetting, con prueba de frontera de día. (5) CAPACITY_BELOW_COMMITTED estrena prueba.

### 53. NO se añade `SELECT ... FOR UPDATE` ahora. Con el stub en cero no hay nada que proteger y un bloqueo sin contención es culto al cargo. Se exige en cambio que el comentario diga la verdad sobre qué existe hoy y qué debe añadir la Fase 2 — si me equivoco, la Fase 2 añade el bloqueo al escribir reservas, que es cuando lo necesita.

### 54. el gate de zona horaria se resuelve con un helper date-only en @rm/shared-utils/calendar.ts junto a monthStartsBetween, que ya recibe timeZone y es el patrón establecido; la zona se lee de SystemSetting, nunca hardcodeada. Cumple la restricción global y la Fase 2 reutiliza la pieza.

### 55. se separa cómputo de persistencia. Una función pura devuelve el DTO sin escribir; la persistencia la invocan sólo las cuatro mutaciones y se mueve DENTRO de sus transacciones, cerrando también el hueco transaccional. No se añade una entrada de auditoría para el recálculo: las cuatro mutaciones ya registran qué cambió y el recálculo es consecuencia determinista, no un evento propio — si me equivoco, falta un registro de algo que igual es derivable.

### 56. se le pide además responder si, al quitar la escritura del camino de lectura, puede servirse un pricePerSeatCents obsoleto — en concreto cuando `updateTrip` de libs/domain/trips cambia totalCapacity, que es insumo del precio pero vive en OTRO servicio. Si ese camino deja el precio obsoleto es una brecha real y probablemente pertenece a la Tarea 14.

### 57. el arreglo va en la TAREA 14 y se hace en `updateTrip` de libs/domain/trips, dentro de su transacción, invocando el recálculo de costeo cuando cambie el cupo. NO en la capa HTTP: es una regla de negocio y ponerla en el endpoint violaría la regla de cuatro responsabilidades. Verificado que no hay ciclo (costing no importa trips, trips no importa costing) y que hay precedente de dependencia dominio→dominio (staff importa de audit, identity y rbac). Si me equivoco, el acoplamiento trips→costing resulta indeseado y habría que invertirlo con un puerto.

### 58. se mueven al dominio, en libs/domain/trips (las imágenes son un asunto de viajes, no una librería nueva). El handler conserva lo genuinamente de transporte: parsear el multipart, sniffear los bytes y rechazar. El StorageProvider se INYECTA como puerto en vez de importar la implementación concreta, lo que mantiene la dirección de la dependencia y permite que un importador futuro aporte la suya — si me equivoco, hay un ciclo que no anticipé y el implementador debe parar en vez de rodearlo.

### 59. se arregla AHORA, no se arrastra. La spec prometía que un cambio de contrato rompe la compilación en vez de producción, y del lado de las respuestas hoy no lo hace — justo en los dos dominios sobre los que las Tareas 16-18 construyen más interfaz. El arreglo son cinco aserciones de asignabilidad mutua con un tipo mapeado que convierte Date en string, en un archivo que participe del target typecheck y NO en un .spec, para que la desviación rompa typecheck y build, no sólo test. Se exige verlas fallar rompiendo un esquema a propósito — si me equivoco, son cinco líneas de más.

### 60. se exige averiguarlo EMPÍRICAMENTE —servir la app, abrirla y ejercitar login, sidenav y cambio de idioma, reportando la consola— y, independientemente del resultado, añadir una prueba que use los PROVIDERS DE PRODUCCIÓN en vez de un TestBed ensamblado a mano. Ese es el arreglo durable: la pregunta del arranque es sólo lo que lo destapó — si me equivoco, sobra una prueba de humo.

### 61. el comentario que afirma que un input() de señal "nunca recibe su valor" bajo este pipeline debe demostrarse con un caso mínimo o suavizarse a lo observado. Las Tareas 17 y 18 lo leerán como doctrina del workspace y evitarán inputs de señal por su autoridad; la doctrina sin verificar sale cara.

### 62. los dos archivos "sueltos" resultaron ser generados por NEXT.JS, no por el agente. El propio archivo declara que `next dev` los escribe y los recrea si se borran, y apunta a node_modules/next/dist/server/lib/generate-agent-files.js. Su aparición es además evidencia de que el agente SÍ levantó la API para la comprobación en navegador. Se commitean: la herramienta los recrea igual y dejarlos sin rastrear ensucia el árbol para todos — si me equivoco, son dos archivos de instrucciones de Next en el repo, borrables cuando se quiera.

### 63. se traduce en el CLIENTE, consistente con los códigos de error — claves para las 29 etiquetas y descripciones más las ~9 categorías, en ambos catálogos, resueltas desde la permission key. El backend conserva su `description` en inglés como documentación para desarrolladores, que es un uso legítimo; sólo deja de ser la fuente de lo que se muestra. Si me equivoco, sobran claves de traducción.

### 64. el parámetro de ruta leído una sola vez del snapshot es un bug latente hoy inalcanzable (sólo la lista enlaza a esas rutas), pero la Tarea 18 construye rutas :tripId sobre este patrón y con más formas de navegar entre hermanos. Se corrige AQUÍ antes de que se copie tres veces más.

### 65. se aplica en el DOMINIO, no en la ruta — changeTripStatus ya recibe el actor, así que exige trip.cancel para la transición a CANCELLED y trip.publish para las demás, dejando el permiso estático de la ruta como el más laxo. Mismo razonamiento que puso las reglas de imágenes en el dominio en la Tarea 14. Se actualiza docs/business-rules/trips.md porque cambia una regla documentada.

### 66. la URL de imagen se arregla en la CAPA API, no en el dominio. Una URL es asunto de transporte: local y s3 la calculan distinto y depende del host de despliegue. El endpoint de subida ya la produce; sólo falta aplicarlo al serializar las imágenes anidadas de un viaje. Cambio aditivo de contrato, regenerar cliente, y borrar el fileUrl() del cliente para que nadie lo reutilice — si me equivoco, la URL debería haber vivido en el DTO de dominio y habría que moverla.

### 67. el residual es MI error de instrucción. Dije "deja en la ruta el permiso más laxo" y no existe uno más laxo: trip.publish y trip.cancel son grants disjuntos. El dominio ya decide bien por transición, pero nadie con sólo trip.cancel llega hasta él, así que el permiso sigue siendo tan inservible como antes del arreglo.

### 68. se añade a route() una puerta "cualquiera de estos permisos", conservando la forma de permiso único que usan veinte endpoints. La ruta de estado declara ambos y el dominio mantiene la decisión exacta: puerta gruesa en el borde, regla precisa en el dominio. Se exige preservar el reparto 401/403 y la solidez de la unión discriminada (el @ts-expect-error de route.spec debe seguir sin compilar para una ruta pública con permisos), y probar el envoltorio directamente además de por los endpoints. "Cualquiera de" volverá a hacer falta en Fase 2 (reservas tienen un reparto similar) — si me equivoco, es una opción de más en el envoltorio.

### 69. además de corregir el símbolo, se cuestiona el cableado. Un compose de producción que lee el .env local del desarrollador está mal más allá de NODE_ENV: significa que la configuración de producción sale de lo que haya en una laptop, incluido un JWT_SECRET que nunca debió salir de ahí. Debe apuntar a su propio archivo de entorno o a variables inyectadas por el despliegue, y .env.example debe decir cuál espera producción — con permiso explícito de discrepar y argumentarlo si cree que a esta escala leer el .env raíz es lo correcto.
