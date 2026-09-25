# Publicador controlado

El workflow `.github/workflows/publish-atletismo-release.yml` solo se dispara manualmente desde `main`. Un push o un signed build exitoso **no** publica. El dry run es el valor predeterminado; la publicación real exige `dry_run=false`, `publish_confirm=true` y aprobación del environment `production-release`. Cada publicación futura requiere autorización explícita del usuario para esa versión; ningún resultado de CI equivale a esa autorización.

## Frontera de confianza

El job `validate` tiene solo permisos de lectura y acceso al secret existente `ATLETISMO_SOURCE_READ_TOKEN`. Obtiene el signed run, sus jobs del intento exacto, el artifact por ID y el SHA del blob del pipeline firmado en `SOURCE_SHA`. Ese blob debe coincidir con el valor auditado fijo en `scripts/publisher-policy.js`; cambiarlo requiere otra auditoría. El código candidato nunca se ejecuta: solo se procesan JSON y APK como datos. El ZIP se contrasta con el digest de GitHub, se exigen exactamente dos entradas y se verifican los SHA-256 de ambos archivos. No se usa el nombre del artifact para seleccionarlo.

El job `publish` es separado, solo se ejecuta tras validación satisfactoria y tiene `contents:write` bajo `production-release`. Descarga el paquete validado del mismo workflow run, vuelve a comprobar archivos, Stable pública y ausencia de release y tag inmediatamente antes de crear un draft. Crea un tag nuevo de forma atómica contra el SHA confiable del publicador; si alguien lo creó mientras tanto, aborta en vez de reutilizarlo. Luego crea el draft con `--verify-tag`. Los dos jobs ejecutan la lógica del commit confiable del publicador en `main`, nunca scripts de `SOURCE_SHA`. Si la protección de reviewers del environment no se aplica realmente a esta cuenta/plan, no se debe usar `dry_run=false` hasta que exista una puerta de aprobación efectiva.

## Recuperación y límites

Solo HTTP 404 demuestra ausencia. HTTP 200, 401, 403, 429, 5xx, timeout o respuesta inesperada abortan. Si una nueva ejecución encuentra un tag o release existente, no la borra ni la recrea: revisar manualmente si está publicada correctamente o si quedó un draft/publicación parcial, comparando tag, nombres, tamaños, SHA-256 y metadata. En estado parcial, detenerse y pedir una decisión humana; no reintentar automáticamente con la misma versión. Una falla después de hacer pública la release puede dejarla publicada aunque el job termine rojo; el operador debe reconciliar el estado real antes de cualquier otro intento.

El `run_id` no identifica por sí solo el intento de un re-run. El validador consulta `run_attempt`, exige los pasos críticos exitosos de ese intento y verifica que el artifact se creó entre el inicio y fin del job de ese intento. El digest del ZIP se contrasta antes de extraerlo. Si la API no proporciona evidencia suficiente, aborta. El primer dry run real completo exige un **candidato futuro** firmado y auditado; no reutilizar V3.4.3 ya publicada.
