# ADR 0004 — Frontera segura de lanzamiento Mumble H8.7

## Estado

Implementación aislada, `@wip`. No autoriza ejecución real ni release.

## Decisión

H8.7 fija tres rutas cerradas: `windows_native`, `macos_crossover` y
`linux_steam_proton`. `SteamAppId=1284210`, `SteamGameId=1284210` y el mapping
`MumbleLink` son constantes; configuración, rutas y diagnósticos no admiten `args`, `env`,
`shell`, `command` ni `mapping` libres. La configuración recibe solo el directorio efímero del
paquete, bottle o compat-data estrictos; no puede elegir el launcher ni se guarda en settings,
stores, Vault o logs. Directorios temporales `tmp|temp` fallan cerrados.

El builder produce un plan exacto con `shell:false` y stdin/stdout/stderr como pipes. Windows usa
una capability del helper; CrossOver fija su `wine` y `--bottle <nombre> --no-update --no-gui
--wait --cx-app <capability>`; Proton fija `/usr/bin/protontricks-launch --appid 1284210
<capability>` y exige `STEAM_COMPAT_DATA_PATH` explícito como único env. H8.7 no incluye una
frontera Node `child_process`, no ejecuta esos planes y no compone
CrossOver, Proton, GW2 ni Obsidian.

Antes de delegar cada intento, el adapter abre un snapshot/copia privada del paquete H8.5 exacto:
EXE, manifest, `SHA256SUMS`, `LICENSE` y `THIRD-PARTY-LICENSES.txt`. El manifest canónico conserva
`name/status/releaseAllowed/files`; checksums cubre las otras cuatro entradas sin ciclo. Solo después
de recalcular los cuatro hashes entrega al host una capability opaca ligada a esos bytes y digests:
el proceso nunca recibe el directorio del paquete ni un path del EXE que pueda resolver otra vez.
El resultado se denomina únicamente `integrity_checked` y `unsigned_qa_only`: detecta corrupción,
pero no prueban procedencia ni autenticidad. Un executor real deberá exigir un trust anchor fijado
por release —digest externo aprobado o Authenticode validado— y repetir la validación inmediatamente
antes de cada arranque o reinicio.

El adapter admite como máximo un único chunk prematuro de stdout de hasta 516 bytes, transfiere sus
bytes y lo entrega mediante un puerto que debe aplazarlo a un turno posterior. El callback aplazado
revalida antes de abrir delivery para cubrir la microtask entre el retorno del host y el suyo.
Overflow, segundo evento, exit prematuro o un puerto de aplazamiento que invoque inline cierran la
capability exactamente una vez, emiten diagnóstico saneado y notifican exit a H8.6.
`stderr` se drena sin exponerse, `stop` es idempotente y los diagnósticos contienen solo versión,
etapa, código, retryable, estado de integridad y `artifactTrust: unsigned_qa_only`: nunca token, nonce, frame, identidad,
PID, exit code, ruta, botella ni SO crudo.

## Fuera de alcance y condición de cierre

No se modifican settings, UI, `main`, `onload`, packaging ni capacidades del plugin. Tampoco hay
spawn real, autoarranque, firma, publicación o QA con Windows/Proton/CrossOver. H8.7 permanece
`@wip` hasta implementar y revisar por separado el executor con trust anchor, composición explícita,
apagado/unload, configuración no persistente autorizada y la matriz real de QA.
