# Publicador controlado

El workflow `.github/workflows/publish-atletismo-release.yml` solo se dispara manualmente desde `main`. Un push o un signed build exitoso **no** publica. El dry run es el valor predeterminado; la publicación real exige `dry_run=false`, `publish_confirm=true` y aprobación del environment `production-release`. Cada publicación futura requiere autorización explícita del usuario para esa versión; ningún resultado de CI equivale a esa autorización.

## Frontera de confianza

El job `validate` tiene solo permisos de lectura y acceso al secret existente `ATLETISMO_SOURCE_READ_TOKEN`. Obtiene el signed run, sus jobs del intento exacto, el artifact por ID y el SHA del blob del pipeline firmado en `SOURCE_SHA`. Ese blob debe coincidir con el valor auditado fijo en `scripts/publisher-policy.js`; cambiarlo requiere otra auditoría. El código candidato nunca se ejecuta: solo se procesan JSON y APK como datos. El ZIP se contrasta con el digest de GitHub, se exigen exactamente dos entradas y se verifican los SHA-256 de ambos archivos. No se usa el nombre del artifact para seleccionarlo.

Además de hash, tamaño, URL y contrato de `update.json`, se inspecciona el APK real con `aapt dump badging` de Android Build Tools 35.0.0 y se comprueba su firma con `apksigner verify`. Los campos reales `packageId`, `versionName`, `versionCode` y `minSdk` deben coincidir exactamente con `update.json`; el paquete y la versión deben coincidir también con `com.atletismo.personal` y el input `VERSION`. La misma inspección del APK y comprobación de firma se repite sobre los bytes descargados en el job privilegiado `publish`, antes de cualquier escritura pública. Si faltan las herramientas o el APK no se puede analizar/verificar, el workflow aborta.

La firma debe pertenecer al certificado oficial de App Atletismo. La huella SHA-256 auditada es `9dfe429d7de62570120a3d9f8f0026e55317f57bae4f9d8acbcab32941191ce5` y está fijada en `scripts/publisher-policy.js`. Se obtuvo con `apksigner verify --verbose --print-certs` sobre `Atletismo-release.apk` del artifact firmado ID `10873090249`, producido por el signed run `36153245765` para el source SHA `40e28c969b914724cecc74c05b973813f842e20c`. El APK usado tenía SHA-256 `3f742752b6a89cc8d77c58d6c535e422fd1abe670dc7adaa89a6786bbc3d705f`, igual a la evidencia validada de V3.4.3. `apksigner` informó exactamente un firmante. La comprobación exige una sola huella parseable y una coincidencia exacta, y se repite en `validate` y `publish`.

La Stable pública se obtiene de `releases/latest`; su `update.json` se descarga y contrasta con tamaño y digest publicados. El candidato debe tener versión y versionCode estrictamente superiores y `minimumAppVersion <=` la versión de la Stable pública: la instalada estable debe poder actualizar directamente. La comparación de versiones usa el mismo formato numérico estricto de tres componentes que el cliente Android.

El job `publish` es separado, solo se ejecuta tras validación satisfactoria y tiene `contents:write` bajo `production-release`. Descarga el paquete validado del mismo workflow run, vuelve a comprobar archivos, Stable pública y ausencia de release y tag inmediatamente antes de crear un draft. Crea un tag nuevo de forma atómica contra el SHA confiable del publicador; si alguien lo creó mientras tanto, aborta en vez de reutilizarlo. Luego crea el draft con `--verify-tag`. Los dos jobs ejecutan la lógica del commit confiable del publicador en `main`, nunca scripts de `SOURCE_SHA`. Si la protección de reviewers del environment no se aplica realmente a esta cuenta/plan, no se debe usar `dry_run=false` hasta que exista una puerta de aprobación efectiva.

Todas las Actions de este publicador y su CI están fijadas a commits completos verificados contra sus tags oficiales:

| Action | Versión | Commit SHA |
| --- | --- | --- |
| `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact` | v4.3.0 | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |

El CI descarga `actionlint` v1.7.12 del proyecto oficial y verifica el SHA-256 fijo del archivo Linux antes de ejecutarlo. Si cambia una Action o el binario de lint, actualizar su pin exige revisión del nuevo valor.

## Recuperación y límites

Solo HTTP 404 demuestra ausencia. HTTP 200, 401, 403, 429, 5xx, timeout o respuesta inesperada abortan. Si una nueva ejecución encuentra un tag o release existente, no la borra ni la recrea: revisar manualmente si está publicada correctamente o si quedó un draft/publicación parcial, comparando tag, nombres, tamaños, SHA-256 y metadata. En estado parcial, detenerse y pedir una decisión humana; no reintentar automáticamente con la misma versión. Una falla después de hacer pública la release puede dejarla publicada aunque el job termine rojo; el operador debe reconciliar el estado real antes de cualquier otro intento.

El `run_id` no identifica por sí solo el intento de un re-run. El validador consulta `run_attempt`, exige los pasos críticos exitosos de ese intento y verifica que el artifact se creó entre el inicio y fin del job de ese intento. El digest del ZIP se contrasta antes de extraerlo. Si la API no proporciona evidencia suficiente, aborta. El primer dry run real completo exige un **candidato futuro** firmado y auditado; no reutilizar V3.4.3 ya publicada.
