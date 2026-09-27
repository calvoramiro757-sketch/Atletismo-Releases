# Publicador controlado de App Atletismo

El workflow `.github/workflows/publish-atletismo-release.yml` se ejecuta manualmente desde `main`. `dry_run=true` valida el candidato sin escribir en la release. Para publicar se requieren `dry_run=false`, `publish_confirm=true`, una orden explícita para esa versión y la aprobación efectiva del environment `production-release` si GitHub la exige. Un resultado verde de CI no es autorización de publicación.

## Evidencia antes de escribir

El job de lectura verifica el run firmado, su último intento, sus pasos críticos, el artifact por ID, su ZIP por digest, y exactamente los archivos `Atletismo-release.apk` y `update.json`. El blob del workflow firmado debe coincidir con `9a2ca9b3903ce8e07325baf72f3859f7ab566de6`. El APK se comprueba mediante `aapt`, `apksigner`, la huella de certificado oficial `9dfe429d7de62570120a3d9f8f0026e55317f57bae4f9d8acbcab32941191ce5` y SHA-256. La Stable pública debe ser anterior en versión y versionCode y poder actualizar directamente al candidato.

El changelog se obtiene como **dato** de `docs/changelog/VERSION.md` en `metadata_source_sha`. Debe tener frontmatter `releaseStatus: stable-ready` y la versión exacta; el texto de `update.json` debe coincidir exactamente. Para nuevas versiones, `metadata_source_sha` debe ser igual a `source_sha` y el artifact firmado debe contener el metadata final. Esto bloquea un artifact técnicamente correcto con notas de desarrollo antes de toda escritura pública. No se ejecutan scripts del repositorio fuente en el job con credenciales de publicación.

La única excepción es la recuperación fijada de V3.4.4: source SHA `147960406da1631e388ec2ff5c501dfb31759598`, metadata source SHA `b7b87b60afe94bd97be554e9b5c74b7a8459b685`, run `36276925417`, artifact `10917702155`, APK `dfcdda35f7c4e92b445fe38f9f6545003db870ffbb982c140276129aa0c06364`, metadata defectuoso `8ce9761b8fa0d5a78a531350b0883546000d2043f864994dbf4ea604f01dd4fd` y metadata corregido `4ea5fdfdc0827854bae4c4d2d273153f0beeccd52f5b961650a61dd21a193bd0`. Se sustituye solo el campo changelog desde la fuente revisada; el resto del JSON, incluido `publishedAt`, permanece intacto. El nuevo archivo se contrasta por hash. La excepción no se aplica a V3.4.5 ni posteriores.

## Reanudación segura

El job con `contents:write`, después de su puerta de aprobación, lista releases con credenciales capaces de ver drafts y consulta el tag por separado. `releases/tags/vX.Y.Z` no demuestra ausencia de un draft: GitHub puede exponerlo mediante una URL `untagged-*`. El publicador reconoce el tag y el draft existentes solo si coinciden sus IDs, SHA, nombre, body, assets, tamaños, digest y bytes descargados. Ante error de red o respuesta ambigua, se detiene; un nuevo run vuelve a leer el estado real. No elimina ni recrea el APK ya aprobado.

En la recuperación V3.4.4, primero descarga y comprueba el APK y el metadata viejo del draft ID `397433395`. Registra en el log el ID `591683601` y SHA histórico del metadata defectuoso. Elimina **solo ese asset**, sube el metadata nuevo, verifica sus bytes, actualiza las notas de procedencia con ambos hashes y promueve el mismo draft por ID. Cada paso puede reanudarse después de una interrupción. Si hay otro tag, release, asset, digest, body o latest inesperado, falla sin publicar. La verificación final exige que V3.4.4 sea la Stable pública y que ambos assets descargados tengan los hashes esperados.

## V3.4.5 y siguientes

1. Preparar un changelog con `releaseStatus: stable-ready` y versión exacta **antes** del build firmado. Cerrar la auditoría del source SHA y registrar run, artifact, hashes y versión.
2. Ejecutar `Publish controlled Atletismo release` desde `main` con `version`, `source_sha`, `signed_run_id`, `artifact_id`, `apk_sha256`, `update_json_sha256` y `dry_run=true`. Dejar vacíos `metadata_source_sha` y `artifact_update_sha256`: sus valores predeterminados son `source_sha` y `update_json_sha256`.
3. Revisar el resultado y comprobar en GitHub que la puerta `production-release` tenga aprobador efectivo. Con autorización explícita para esa versión, repetir el workflow con los mismos valores, `dry_run=false` y `publish_confirm=true`; aprobar el environment si GitHub lo solicita.
4. Confirmar en `releases/latest` y en los bytes descargados que la versión, notas, APK y `update.json` coinciden. Verificar que la Stable anterior y sus assets siguen accesibles. Actualizar el checkpoint del repositorio fuente a `RELEASED` solo después de esa comprobación.

Si un run falla, consultar la release y el tag existentes antes de reintentar. El mismo workflow puede reanudarse con los mismos inputs y commit de publicador, siempre que el estado intermedio coincida exactamente con el candidato. Un cambio de código del publicador durante un draft parcial requiere auditoría explícita, porque el body de procedencia fija el SHA del publicador.
