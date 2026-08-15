# ADR 0001 — Lenguaje y distribución del helper Mumble H8.3

<!-- h8.3-adr-authority:start -->
- Estado: `accepted_for_implementation` (provisional)
- Fecha: 2026-08-14
- Alcance: decisión previa a implementación
- Contrato anterior: H8.1 en `src/platform/mumble-v2-contract.ts`

## Contexto

H8.1 deja el futuro helper fuera del proceso de Obsidian y limita su salida al frame local mínimo.
H8.3 decide cómo construir y distribuir ese proceso auxiliar sin implementar todavía su runtime. El
mismo binario Windows x64 debe poder probarse en Linux con Steam/Proton, macOS con CrossOver y
Windows x64; crear tres implementaciones nativas distintas multiplicaría la superficie de revisión y
haría más difícil demostrar que todas leen y proyectan exactamente lo mismo.

La decisión es provisional porque todavía no existe evidencia de compilación, lectura real de Mumble
Link, convivencia con el juego/Obsidian ni firma. `accepted_for_implementation` autoriza preparar un
lote posterior contra este contrato; no declara que el helper esté construido, empaquetado, firmado
o soportado.

## Opciones consideradas

| Criterio | Rust | C# |
| --- | --- | --- |
| Unidad desplegable | Un PE x64 nativo con CRT estático y sin runtime del lenguaje distribuido aparte. | NativeAOT publica una aplicación nativa self-contained: no necesita un runtime .NET instalado y puede producir un único fichero de aplicación. Es una alternativa válida al mismo contrato de un PE. |
| Runtime y tamaño | No incorpora un GC/runtime administrado; el tamaño real seguirá dependiendo de estándar, panic, optimización y dependencias. | NativeAOT enlaza el soporte mínimo de runtime/GC necesario dentro de la aplicación. Su coste de tamaño y arranque debe medirse, no inferirse; no equivale a framework-dependent. |
| Frontera Win32/Mumble | FFI explícita con una frontera `unsafe` pequeña para mapping, layout y rollover; esa zona debe censarse y aislarse. | P/Invoke, `StructLayout`, punteros o memory-mapped files simplifican parte del interop, pero también forman una frontera nativa/unsafe que exige validar layout y longitudes. |
| AOT y compatibilidad | El target MSVC y sus crates deben fijarse; FFI, linker y dependencias siguen sujetos a revisión multiplataforma real. | NativeAOT usa un modelo cerrado: trimming, reflexión dinámica, generación de código y librerías no compatibles con AOT imponen restricciones que este helper pequeño podría asumir, pero habría que probar. |
| Toolchain, símbolos y distribución | Rust + target MSVC/linker deben quedar fijados y reproducibles; los símbolos separados no entran en el ZIP. | SDK .NET NativeAOT + toolchain MSVC también deben fijarse; la configuración de símbolos/PDB y single-file debe demostrar que el ZIP conserva solo el PE acordado. |

Se elige **Rust** por una frontera pequeña sin GC administrado, el control explícito de la zona
`unsafe` Win32 y la posibilidad de auditar un binario con pocas dependencias. No se elige porque C#
requiera instalar .NET: NativeAOT no lo requiere. C# queda como alternativa explícita si un spike
demuestra mejor compatibilidad, menor tamaño/riesgo total o un interop sustancialmente más mantenible
sin romper el PE único ni la distribución cerrada.

## Contrato ejecutable

El guard documental parsea este bloque, exige el schema/valor canónico byte a byte y verifica su
SHA-256. El sobre de autoridad del ADR también está hasheado, por lo que una frase libre que declare
QA o firma completadas no puede coexistir sin reabrir la decisión y actualizar deliberadamente el
guard.

<!-- h8.3-decision:start -->
```json
{
  "schemaVersion": 1,
  "decisionId": "H8.3",
  "status": "accepted_for_implementation",
  "provisional": true,
  "language": "rust",
  "alternative": "csharp",
  "sourceRoot": "native/mumble-helper",
  "build": {
    "target": "x86_64-pc-windows-msvc",
    "rustFlags": [
      "-C target-feature=+crt-static",
      "-C link-arg=/Brepro"
    ],
    "peOutputs": [
      "tyrian-mumble-helper.exe"
    ]
  },
  "package": {
    "kind": "separate_zip",
    "nameTemplate": "tyrian-mumble-helper-{version}-windows-x64.zip",
    "pluginArchiveIncluded": false,
    "entries": [
      "tyrian-mumble-helper.exe",
      "helper-manifest.json",
      "SHA256SUMS",
      "LICENSE",
      "THIRD-PARTY-LICENSES.txt"
    ]
  },
  "support": [
    {
      "environment": "linux_steam_proton",
      "tier": "primary",
      "qa": "pending"
    },
    {
      "environment": "macos_crossover",
      "tier": "secondary",
      "qa": "pending"
    },
    {
      "environment": "windows_x64",
      "tier": "beta",
      "qa": "pending"
    }
  ],
  "unsupported": [
    "linux_native",
    "macos_native",
    "windows_x86",
    "windows_arm64",
    "mobile",
    "wine_outside_steam_proton_or_crossover"
  ],
  "signing": {
    "scheme": "authenticode",
    "status": "pending",
    "releaseAllowed": false
  },
  "risks": [
    "proton_or_crossover_mapping_incompatibility",
    "ffi_layout_or_tick_rollover_error",
    "static_crt_or_single_pe_regression",
    "dependency_license_or_binary_size_growth",
    "unsigned_binary_trust_and_smartscreen"
  ],
  "reopenTriggers": [
    "supported_matrix_requires_more_than_one_helper_binary",
    "single_pe_with_static_crt_cannot_be_reproduced",
    "rust_ffi_cannot_meet_the_h8_1_boundary_safely",
    "csharp_proves_materially_safer_or_more_compatible",
    "windows_arm64_becomes_a_release_requirement",
    "signing_or_licensing_cannot_meet_release_policy"
  ]
}
```
<!-- h8.3-decision:end -->

## Consecuencias

El futuro código vivirá solo bajo `native/mumble-helper`. Su único target autorizado es
`x86_64-pc-windows-msvc` con `-C target-feature=+crt-static` y `-C link-arg=/Brepro`, y su única salida PE de producto será
`tyrian-mumble-helper.exe`. La implementación deberá demostrar que no necesita DLL de aplicación ni
runtime redistribuible adicional. H8.3 no crea todavía `Cargo.toml`, `.csproj`, EXE, DLL, código
nativo, wiring, listener, CI de producto ni packaging real.

El ZIP del helper será un artefacto separado del ZIP de instalación del plugin. Incluirá exactamente
el EXE, un manifest del helper, `SHA256SUMS`, la licencia del proyecto y los avisos de terceros. El
manifest deberá ligar versión, target y hashes al mismo build; `SHA256SUMS` cubrirá todos los ficheros
no circulares del paquete. No se añadirá el helper a `manifest.json`, `main.js` ni al ZIP BRAT.

La matriz inicial es Linux con Steam/Proton como primaria, macOS con CrossOver como secundaria y
Windows x64 como beta, las tres con `qa=pending`. Quedan exactamente fuera de soporte la ejecución
nativa Linux, la ejecución nativa macOS, Windows x86, Windows ARM64, móvil y Wine fuera de
Steam/Proton o CrossOver. Una capa de emulación que logre arrancar el EXE no cambia esa política.

La firma Authenticode está pendiente y un artefacto sin firma no está autorizado para release. La
elección se reabre ante cualquiera de los triggers del bloque: más de un binario para la matriz,
imposibilidad de reproducir PE único + CRT estático, FFI que no pueda respetar H8.1, ventaja material
demostrada de C#, requisito Windows ARM64 o bloqueo de firma/licencias. Los riesgos se revisarán con
evidencia de build, tamaño/licencias, scanner y QA real; no se resolverán por afirmación documental.
<!-- h8.3-adr-authority:end -->
