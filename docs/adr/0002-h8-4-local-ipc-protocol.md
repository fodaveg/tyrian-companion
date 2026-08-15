# ADR 0002 — Protocolo IPC local Mumble H8.4

- Estado: `accepted_protocol_only`
- Fecha: 2026-08-15
- Alcance: contrato ejecutable previo al runtime
- Contratos anteriores: H8.1 en `src/platform/mumble-v2-contract.ts` y ADR 0001 H8.3

## Contexto

H8.1 cerró la proyección mínima y H8.3 eligió provisionalmente la forma del futuro helper, pero
quedaban ambiguos el bootstrap, discovery, autenticación, framing, secuencia y liveness del canal.
H8.4 los fija sin implementar helper, socket, proceso, timer, adapter, Cargo ni packaging productivo.

El helper será el servidor TCP IPv4 y el plugin el cliente. El helper hace bind exclusivamente en
`127.0.0.1` con puerto `0`; el puerto efectivo no se adivina ni se persiste. El plugin entrega por
stdin un record `bootstrap`, el helper responde por stdout con `ready`, el plugin conecta al puerto
descubierto y envía `hello`, y el helper responde `welcome`. Stdin, stdout y TCP usan el mismo
framing: longitud `uint32` big-endian de cuatro bytes seguida por 1–512 bytes de JSON UTF-8.

## Contrato parseable

<!-- h8.4-protocol:start -->
```json
{
  "schemaVersion": 1,
  "decisionId": "H8.4",
  "status": "accepted_protocol_only",
  "version": 1,
  "roles": {
    "server": "helper",
    "client": "plugin"
  },
  "network": {
    "protocol": "tcp_ipv4",
    "host": "127.0.0.1",
    "bindPort": 0,
    "discoveredPortMinimum": 1,
    "discoveredPortMaximum": 65535,
    "authenticatedConnectionMaximum": 1,
    "pendingConnectionMaximum": 1
  },
  "framing": {
    "lengthBytes": 4,
    "lengthEncoding": "uint32_big_endian",
    "payloadEncoding": "utf8_json",
    "minimumPayloadBytes": 1,
    "maximumPayloadBytes": 512,
    "maximumBufferedRecordBytes": 516,
    "inputChunkRetention": "none",
    "recordDelivery": "incremental_ownership_transfer_before_callback",
    "reject": [
      "zero_length",
      "oversize",
      "truncated",
      "invalid_utf8",
      "byte_order_mark",
      "invalid_json",
      "non_object_json",
      "duplicate_keys",
      "trailing_content",
      "unknown_fields",
      "missing_fields"
    ]
  },
  "credentials": {
    "token": {
      "generatedBy": "plugin",
      "entropyBytes": 32,
      "encodedCharacters": 43,
      "randomness": "csprng",
      "encoding": "base64url_no_padding",
      "scope": "per_process",
      "comparison": "constant_time_exact_32_bytes",
      "binding": "hello_equals_bootstrap_same_helper_process",
      "retainedAcrossSameProcessReconnect": true,
      "invalidatedOn": [
        "helper_exited",
        "process_restarted",
        "stdin_eof",
        "shutdown_requested"
      ],
      "allowedSurfaces": [
        "stdin_bootstrap",
        "tcp_hello"
      ],
      "forbiddenSurfaces": [
        "argv",
        "env",
        "file",
        "log",
        "stdout",
        "stderr",
        "discovery",
        "settings",
        "indexeddb",
        "vault",
        "telemetry"
      ]
    },
    "nonce": {
      "generatedBy": "helper",
      "entropyBytes": 16,
      "encodedCharacters": 22,
      "randomness": "csprng",
      "encoding": "base64url_no_padding",
      "scope": "per_connection",
      "requireFreshPerConnection": true,
      "allowedSurfaces": [
        "welcome",
        "heartbeat",
        "sample"
      ]
    }
  },
  "handshake": [
    "bootstrap",
    "ready",
    "hello",
    "welcome"
  ],
  "messages": {
    "bootstrap": [
      "kind",
      "version",
      "token"
    ],
    "ready": [
      "kind",
      "version",
      "host",
      "port"
    ],
    "hello": [
      "kind",
      "version",
      "token"
    ],
    "welcome": [
      "kind",
      "version",
      "nonce",
      "heartbeatIntervalMs"
    ],
    "heartbeat": [
      "kind",
      "version",
      "nonce",
      "sequence",
      "sourceStatus"
    ],
    "sample": [
      "version",
      "nonce",
      "sequence",
      "tick",
      "mapId",
      "activity"
    ]
  },
  "sequence": {
    "sharedBy": [
      "heartbeat",
      "sample"
    ],
    "initial": 0,
    "step": 1,
    "maximum": 9007199254740991,
    "rejectGap": true,
    "rejectReplay": true,
    "rejectRegression": true,
    "rejectWrap": true,
    "resetOnNewNonce": true
  },
  "timingMs": {
    "heartbeatInterval": 500,
    "sourceStalledAfter": 1500,
    "discoveryTimeout": 5000,
    "connectTimeout": 2000,
    "helloTimeout": 2000,
    "firstSequencedRecordTimeout": 2000,
    "heartbeatTimeout": 2000,
    "reconnectBackoff": [
      250,
      500,
      1000,
      2000,
      5000
    ]
  },
  "lifecycle": {
    "initialState": "awaiting_bootstrap",
    "terminalState": "shutdown",
    "phaseRecordError": "frame_schema",
    "phaseRecords": {
      "awaiting_bootstrap": [
        "bootstrap"
      ],
      "awaiting_ready": [
        "ready"
      ],
      "connecting": [],
      "awaiting_hello": [
        "hello"
      ],
      "awaiting_welcome": [
        "welcome"
      ],
      "awaiting_first_sequenced": [
        "heartbeat",
        "sample"
      ],
      "healthy": [
        "heartbeat",
        "sample"
      ],
      "reconnect_wait": [],
      "restart_wait": [],
      "shutdown": []
    },
    "transitions": [
      {
        "from": "awaiting_bootstrap",
        "event": "bootstrap_accepted",
        "to": "awaiting_ready"
      },
      {
        "from": "awaiting_ready",
        "event": "ready_accepted",
        "to": "connecting"
      },
      {
        "from": "connecting",
        "event": "tcp_connected",
        "to": "awaiting_hello"
      },
      {
        "from": "awaiting_hello",
        "event": "hello_accepted",
        "to": "awaiting_welcome"
      },
      {
        "from": "awaiting_welcome",
        "event": "welcome_accepted",
        "to": "awaiting_first_sequenced"
      },
      {
        "from": "awaiting_first_sequenced",
        "event": "heartbeat_accepted",
        "to": "healthy"
      },
      {
        "from": "awaiting_first_sequenced",
        "event": "sample_accepted",
        "to": "healthy"
      },
      {
        "from": "healthy",
        "event": "heartbeat_accepted",
        "to": "healthy"
      },
      {
        "from": "healthy",
        "event": "sample_accepted",
        "to": "healthy"
      },
      {
        "from": "reconnect_wait",
        "event": "reconnect_due",
        "to": "connecting"
      },
      {
        "from": "restart_wait",
        "event": "process_restarted",
        "to": "awaiting_bootstrap"
      }
    ],
    "timeouts": [
      {
        "name": "discovery_timeout",
        "state": "awaiting_ready",
        "timeoutMs": 5000,
        "error": "discovery_timeout",
        "deadlineStartsAfter": "bootstrap_accepted",
        "deadlineRefreshesAfter": []
      },
      {
        "name": "connect_timeout",
        "state": "connecting",
        "timeoutMs": 2000,
        "error": "connect_timeout",
        "deadlineStartsAfter": "ready_accepted",
        "deadlineRefreshesAfter": []
      },
      {
        "name": "hello_timeout",
        "state": "awaiting_hello",
        "timeoutMs": 2000,
        "error": "auth_rejected",
        "deadlineStartsAfter": "tcp_connected",
        "deadlineRefreshesAfter": []
      },
      {
        "name": "hello_timeout",
        "state": "awaiting_welcome",
        "timeoutMs": 2000,
        "error": "auth_rejected",
        "deadlineStartsAfter": "tcp_connected",
        "deadlineRefreshesAfter": []
      },
      {
        "name": "first_sequenced_record_timeout",
        "state": "awaiting_first_sequenced",
        "timeoutMs": 2000,
        "error": "heartbeat_timeout",
        "deadlineStartsAfter": "welcome_accepted",
        "deadlineRefreshesAfter": []
      },
      {
        "name": "heartbeat_timeout",
        "state": "healthy",
        "timeoutMs": 2000,
        "error": "heartbeat_timeout",
        "deadlineStartsAfter": "welcome_accepted",
        "deadlineRefreshesAfter": [
          "heartbeat_accepted",
          "sample_accepted"
        ]
      }
    ],
    "failureRoutes": [
      {
        "fromStates": [
          "awaiting_bootstrap"
        ],
        "errors": [
          "auth_rejected",
          "version_unsupported",
          "frame_length",
          "frame_utf8",
          "frame_json",
          "frame_schema"
        ],
        "to": "restart_wait",
        "recoveryEvent": "process_restarted",
        "tokenDisposition": "invalidate",
        "portDisposition": "invalidate",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "awaiting_ready"
        ],
        "errors": [
          "discovery_timeout",
          "discovery_invalid",
          "version_unsupported",
          "frame_length",
          "frame_utf8",
          "frame_json",
          "frame_schema"
        ],
        "to": "restart_wait",
        "recoveryEvent": "process_restarted",
        "tokenDisposition": "invalidate",
        "portDisposition": "invalidate",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "awaiting_bootstrap",
          "awaiting_ready",
          "connecting",
          "awaiting_hello",
          "awaiting_welcome",
          "awaiting_first_sequenced",
          "healthy",
          "reconnect_wait",
          "restart_wait"
        ],
        "errors": [
          "helper_exited"
        ],
        "to": "restart_wait",
        "recoveryEvent": "process_restarted",
        "tokenDisposition": "invalidate",
        "portDisposition": "invalidate",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "connecting"
        ],
        "errors": [
          "connect_timeout",
          "frame_schema",
          "peer_closed"
        ],
        "to": "reconnect_wait",
        "recoveryEvent": "reconnect_due",
        "tokenDisposition": "retain",
        "portDisposition": "retain",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "awaiting_hello"
        ],
        "errors": [
          "auth_rejected",
          "version_unsupported",
          "frame_length",
          "frame_utf8",
          "frame_json",
          "frame_schema",
          "peer_closed"
        ],
        "to": "reconnect_wait",
        "recoveryEvent": "reconnect_due",
        "tokenDisposition": "retain",
        "portDisposition": "retain",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "awaiting_welcome"
        ],
        "errors": [
          "auth_rejected",
          "version_unsupported",
          "frame_length",
          "frame_utf8",
          "frame_json",
          "frame_schema",
          "nonce_mismatch",
          "peer_closed"
        ],
        "to": "reconnect_wait",
        "recoveryEvent": "reconnect_due",
        "tokenDisposition": "retain",
        "portDisposition": "retain",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      },
      {
        "fromStates": [
          "awaiting_first_sequenced",
          "healthy"
        ],
        "errors": [
          "version_unsupported",
          "frame_length",
          "frame_utf8",
          "frame_json",
          "frame_schema",
          "nonce_mismatch",
          "sequence_mismatch",
          "heartbeat_timeout",
          "peer_closed"
        ],
        "to": "reconnect_wait",
        "recoveryEvent": "reconnect_due",
        "tokenDisposition": "retain",
        "portDisposition": "retain",
        "nonceDisposition": "invalidate",
        "sequenceDisposition": "invalidate"
      }
    ],
    "stdinEofFromStates": [
      "awaiting_bootstrap",
      "awaiting_ready",
      "connecting",
      "awaiting_hello",
      "awaiting_welcome",
      "awaiting_first_sequenced",
      "healthy",
      "reconnect_wait",
      "restart_wait"
    ],
    "stdinEofTo": "shutdown",
    "stdinEofAction": "shutdown_helper",
    "stdinEofCloses": [
      "listener",
      "pending_connection",
      "authenticated_connection"
    ],
    "backoffResetState": "healthy",
    "backoffResetEvents": [
      "heartbeat_accepted",
      "sample_accepted"
    ],
    "backoffResetOnlyWhenHealthy": true,
    "sameProcessReconnectEvent": "reconnect_due",
    "newProcessReconnectEvent": "process_restarted"
  },
  "sourceStatuses": [
    "warming_up",
    "mapping_unavailable",
    "layout_unsupported",
    "sample_unstable",
    "sample_invalid"
  ],
  "channelErrors": [
    "discovery_timeout",
    "discovery_invalid",
    "connect_timeout",
    "auth_rejected",
    "version_unsupported",
    "frame_length",
    "frame_utf8",
    "frame_json",
    "frame_schema",
    "nonce_mismatch",
    "sequence_mismatch",
    "heartbeat_timeout",
    "peer_closed",
    "helper_exited"
  ],
  "authority": {
    "rollout": "shadow",
    "source": "api_v1",
    "confirmation": "human_required",
    "retention": "none"
  }
}
```
<!-- h8.4-protocol:end -->

## Semántica normativa

Los records tienen claves exactas. `kind` vale el nombre del mensaje cuando existe; `version` debe
ser exactamente `1`, sin downgrade. `ready.host` es exactamente `127.0.0.1` y el puerto efectivo es
un entero `1..65535`. Cada parser incremental limita la memoria simultánea a 516 bytes (cuatro de
cabecera más 512 de payload), incluso si recibe un chunk coalesced arbitrariamente grande. Al
entregar un payload transfiere su buffer: libera la referencia interna antes del callback y no crea
una copia mientras el original siga retenido. El plugin
genera el token con CSPRNG una vez por proceso futuro del helper; el helper captura el valor de
`bootstrap` y exige en tiempo constante exactamente ese mismo valor en cada `hello` del proceso.
Bootstrap valida forma/entropía, no se compara con una expectativa externa. El token solo
aparece en `bootstrap` y `hello`; se compara sobre sus 32 bytes exactos y nunca
entra en argv, entorno, fichero, log, stdout, stderr, discovery, settings, IndexedDB, Vault ni
telemetría. El nonce se genera con CSPRNG por conexión en el helper y solo aparece desde `welcome`
en el canal autenticado.

Solo puede existir una conexión autenticada y una conexión pendiente. Una conexión adicional se
rechaza sin desplazar a la válida. Tras `welcome`, `heartbeat` y `sample` comparten una única
secuencia: empieza exactamente en cero, cada record aumenta exactamente uno, y gap, replay,
regresión, entero inseguro o wrap invalidan el canal. Un nonce nuevo crea una secuencia nueva; un
record del nonce anterior es stale. El rollover `uint32` de `tick` sí es válido y un cambio
`4294967295 → 0` significa que el enlace avanzó.

El heartbeat es control de canal/fuente y nunca sustituye un sample H8.1. `sourceStatus` expresa
disponibilidad o validez de la fuente; `link_stalled` sigue siendo exclusivamente `sample.activity`
tras 1.500 ms con el mismo tick. Son tres ejes distintos: lifecycle del canal, salud de la fuente y
actividad derivada. Una pausa/sleep no reproduce heartbeats ni samples perdidos; al despertar, un
deadline vencido cierra el canal y aplica el backoff desde el principio. Cada fase solo admite los
records de `lifecycle.phaseRecords`; incluso un record bien formado en una fase incorrecta produce
`frame_schema`. `hello_timeout` cubre desde TCP conectado hasta `welcome`; el primer record
secuenciado y la salud del canal tienen deadlines propios. Tanto heartbeat como sample secuenciados
válidos renuevan el deadline de salud. El backoff se resetea exclusivamente cuando un heartbeat o sample
secuenciado válido deja el canal en `healthy`, nunca por TCP conectado, hello o welcome.

EOF de stdin es una orden terminal: invalida token/nonce/secuencia, pasa a `shutdown` y cierra
listener, conexión pendiente y conexión autenticada. Antes de aceptar `ready`, cualquier fallo
—incluido `discovery_timeout`— invalida el token y exige reiniciar proceso, bootstrap y discovery;
nunca puede saltar a `connecting` sin puerto. Tras `ready`, un fallo de canal conserva el token y
puede reconectar al mismo helper, pero invalida nonce/secuencia y exige nonce nuevo con secuencia
desde cero. `helper_exited` desde cualquier estado no terminal —también `reconnect_wait`— invalida
token/puerto/nonce/secuencia y fuerza reinicio de proceso; `reconnect_due` nunca puede conectar a un
helper muerto. Un nonce anterior queda stale. Solo reiniciar correctamente
el proceso vuelve a `awaiting_bootstrap` para capturar un token nuevo.

Todo fallo es fail-closed. No hay red externa, persistencia, log de raw/records/credenciales,
fallback de fuente, influencia autoritativa ni acción automática. La API v1 sigue siendo la
autoridad, el rollout sigue shadow y cualquier efecto posterior sobre una propuesta exige decisión
humana.

## Consecuencias

Los validators, framer, fake clock y vectores de H8.4 viven solo en `*.test.ts` como referencia
ejecutable. Este ADR y el modelo TS no autorizan helper, runtime IPC, socket, timer, process manager,
adapter, Cargo, CI nativa ni packaging. La implementación posterior deberá reproducir este contrato
en ambos extremos y pasar QA real separada sin ampliar los seis mensajes ni las superficies de
secreto.
