# ADR 0003 — Runtime helper/servidor Mumble H8.5

- Estado: `implemented_pending_ci_and_real_qa`
- Fecha: 2026-08-15
- Alcance: helper/servidor nativo, sin cliente del plugin ni release
- Contratos: H8.1, ADR 0001 H8.3 y ADR 0002 H8.4

## Decisión

<!-- h8.5-runtime:start -->
```json
{
  "schemaVersion": 1,
  "decisionId": "H8.5",
  "status": "implemented_pending_ci_and_real_qa",
  "root": "native/mumble-helper",
  "role": "helper_server_only",
  "runtime": {
    "eventLoop": "bounded_single_connection",
    "stdinWatchdogs": 1,
    "threadsPerConnection": 0,
    "authenticatedConnectionMaximum": 1,
    "pendingConnectionMaximum": 1,
    "additionalConnectionAction": "reject",
    "cadenceMs": 500,
    "recordsPerCadence": 1,
    "sourceInput": "raw_tick_map_or_exact_status",
    "firstValidAfterDiscontinuity": "warming_up",
    "warmingUpStoresSourceHistory": false,
    "nextValidRead": "establish_epoch_and_sample_advancing",
    "stalledAfterMs": 1500,
    "heartbeatTimeoutMs": 2000,
    "lateInvocationMaximumRecords": 1,
    "nextSlotAfterInvocation": "now_plus_500ms",
    "sleepCatchUp": false
  },
  "source": {
    "mapping": "MumbleLink",
    "access": "FILE_MAP_READ",
    "viewBytes": 5460,
    "fields": [
      "LinkedMem.uiVersion",
      "LinkedMem.uiTick",
      "LinkedMem.context_len",
      "MumbleContext.mapId"
    ],
    "samplePairAttempts": 8
  },
  "implemented": [
    "framing",
    "strict_json",
    "constant_time_process_token",
    "zeroize_secret_buffers",
    "per_connection_nonce",
    "shared_sequence",
    "source_projection",
    "stdin_eof_shutdown",
    "same_process_reconnect"
  ],
  "notImplemented": [
    "plugin_launcher",
    "plugin_client",
    "plugin_settings",
    "plugin_ui",
    "external_network",
    "persistence",
    "logging",
    "release_package",
    "authenticode"
  ],
  "qa": {
    "hostPortable": "implemented",
    "windowsCi": "pending_run",
    "windowsReal": "pending",
    "linuxSteamProton": "pending",
    "macosCrossOver": "pending"
  },
  "ciArtifact": {
    "contents": "UNSIGNED-NOT-FOR-RELEASE marker only",
    "retentionDays": 1,
    "releaseAllowed": false
  }
}
```
<!-- h8.5-runtime:end -->

## Consecuencias

El helper reproduce solo la mitad servidor de H8.4. No afirma implementar los estados, timeouts ni
backoff del futuro cliente/plugin. Un slot produce sample únicamente tras una lectura estable ya
calentada; los cinco estados de fuente producen heartbeat y una discontinuidad borra el historial
de actividad. Heartbeat y sample usan la misma secuencia y ambos serán prueba de salud para el
cliente futuro.

El event loop mantiene como máximo una conexión autenticada y una segunda conexión pendiente; una
tercera se cierra. La pendiente conserva su deadline de hello desde el accept y solo puede promoverse
cuando termina la activa, sin crear un thread por conexión ni una cola ampliable.

El scheduler recibe una lectura raw por slot. El primer válido no conserva tick ni instante; el
segundo abre una época y emite `link_advancing`. Un tick igual sigue advancing a 1.499 ms y pasa a
stalled exactamente a 1.500 ms. Una invocación tardía emite como máximo el record actual y fija el
siguiente slot en `now+500 ms`; a 2.000 ms desde el último record emitido cierra el canal sin emitir,
por lo que un sleep de 60 s no produce catch-up ni replay.

El adapter Win32 es la única isla `unsafe`, abre el mapping existente con acceso de lectura y no
enumera procesos ni usa PID, identidad, personaje, posición, movimiento, combate o loot. Token y
raw frames no se registran ni persisten. EOF de stdin apaga listener y conexión; un reconnect dentro
del mismo proceso conserva el token bootstrap, rota nonce y reinicia secuencia.

El gate local no sustituye la CI Windows ni la QA real. Hasta que el mismo PE pase inspección,
reproducibilidad, firma y matriz, no existe helper publicable ni soporte declarado.
